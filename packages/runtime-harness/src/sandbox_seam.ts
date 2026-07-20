/**
 * Sandbox seam — isolation boundary around tool effects.
 *
 * Every durable or external effect MUST go through `SandboxSeam.invoke`.
 * The model never touches state directly. Write/critical risk classes require
 * a write-ahead audit acknowledgment before effect. Hung work is raced
 * against deadlineMs and returns a typed tool error (never hangs the turn).
 *
 * Tool outputs are validated against an optional result JSON Schema; failures
 * map to TOOL_STATUS error frames and structured tool_response for the model
 * — never raw poison passthrough to the stream.
 */

import type {
  ToolDescriptor,
  ToolInterface,
  ToolInvocation,
  ToolResult,
} from "@moolam/contracts";
import type { ToolStatusFrame } from "@moolam/sync-protocol";

/** Soft caps (NFR): registry and audit-order log stay bounded. */
export const SANDBOX_REGISTRY_LIMIT = 32;
export const SANDBOX_INVOKE_LOG_LIMIT = 64;
export const SANDBOX_MAX_BYTES_DEFAULT = 64 * 1024;
export const SANDBOX_DEFAULT_DEADLINE_MS = 5_000;
/** Bounded schema issue list (NFR — no unbounded scans). */
export const SANDBOX_SCHEMA_ISSUE_LIMIT = 32;
/** Obligation id for result-schema failures (correction loop / operators). */
export const SANDBOX_RESULT_SCHEMA_OBLIGATION = "SANDBOX.RESULT_SCHEMA";

export type SandboxSeamFailureClass =
  | "missing_subject"
  | "cross_subject"
  | "unknown_tool"
  | "audit_required"
  | "deadline_exceeded"
  | "payload_oversize"
  | "schema_invalid"
  | "invalid_deadline"
  | "tool_threw";

export type SandboxSeamContext = {
  subjectId: string;
  deviceId?: string;
  invocationId: string;
  deadlineMs: number;
  /** Defaults to invocationId. Concurrent same key → at-most-once. */
  idempotencyKey?: string;
  /**
   * Must be true for write/critical before effect begins (write-ahead ack
   * from the host audit sink / B3 act stage).
   */
  writeAheadRecorded?: boolean;
};

export type SandboxInvokeAccepted = {
  ok: true;
  status: "ok";
  invocationId: string;
  output: unknown;
  latencyMs: number;
  subjectId: string;
};

export type SandboxSchemaIssue = {
  path: string;
  message: string;
};

export type SandboxInvokeRejected = {
  ok: false;
  status: "error";
  failureClass: SandboxSeamFailureClass;
  invocationId: string;
  subjectId: string | null;
  latencyMs: number;
  /** Structured error for tool_response / TOOL_STATUS — never raw model dump. */
  error: {
    kind: SandboxSeamFailureClass;
    message: string;
    obligationId?: string;
    issues?: SandboxSchemaIssue[];
  };
};

/** Minimal JSON Schema subset for tool result validation (object-centric). */
export type SandboxResultJsonSchema = {
  type?: "object" | "string" | "number" | "boolean" | "array" | "null";
  properties?: Record<string, SandboxResultJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: SandboxResultJsonSchema;
};

export type SandboxInvokeResult = SandboxInvokeAccepted | SandboxInvokeRejected;

export type SandboxSeamTelemetryEvent = {
  event: "runtime.harness.sandbox_seam";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  toolName?: string;
  riskClass?: ToolDescriptor["riskClass"];
  failureClass?: SandboxSeamFailureClass;
  invocationId?: string;
  latencyMs?: number;
};

/**
 * Isolation seam: descriptor + args + ctx → validated, deadline-bounded effect.
 */
export interface SandboxSeam {
  invoke(
    descriptor: ToolDescriptor,
    args: Record<string, unknown>,
    ctx: SandboxSeamContext,
  ): Promise<SandboxInvokeResult>;
}

export type SandboxInvokeTracePhase = "audit" | "effect" | "denied";

/** Ordered trace for audit-before-effect assertions (tests / operators). */
export type SandboxInvokeTrace = {
  phase: SandboxInvokeTracePhase;
  toolName: string;
  invocationId: string;
  riskClass: ToolDescriptor["riskClass"];
  subjectId: string;
  seq: number;
};

export type FakeToolEffect = (
  args: Record<string, unknown>,
  ctx: SandboxSeamContext,
) => Promise<unknown> | unknown;

export type InProcessFakeToolSpec = {
  descriptor: ToolDescriptor;
  /** Reject when JSON-serialized output exceeds this (default SANDBOX_MAX_BYTES_DEFAULT). */
  maxBytes?: number;
  /**
   * Result JSON Schema — validated after effect, before success is returned.
   * Schema-invalid → tool error (never raw passthrough).
   */
  resultSchema?: SandboxResultJsonSchema;
  /** When true, effect never resolves — seam deadline must win. */
  hang?: boolean;
  /**
   * When true, effect returns a non-object poison payload used to exercise
   * the result-validator path (schema_invalid → tool error, not passthrough).
   */
  invalidResult?: boolean;
  effect?: FakeToolEffect;
};

export type SandboxResultValidation =
  | { ok: true }
  | { ok: false; detail: string; issues?: SandboxSchemaIssue[] };

export type CreateSandboxSeamOptions = {
  registry: InProcessFakeToolRegistry;
  /** Seam is subject-scoped; ctx.subjectId must match. */
  subjectId: string;
  deviceId?: string;
  onTelemetry?: (event: SandboxSeamTelemetryEvent) => void;
  /**
   * Hook for result-schema validation. Default uses the tool's `resultSchema`
   * (and rejects `invalidResult` / non-JSON poison).
   */
  validateResult?: (
    descriptor: ToolDescriptor,
    output: unknown,
  ) => SandboxResultValidation;
};

export type SandboxToolResponse = {
  role: "tool";
  toolCallId: string;
  /** JSON body for the model — structured status/output or typed error only. */
  content: string;
};

export type MapSandboxResultOptions = {
  subjectId: string;
  correlationId: string;
  sequenceIndex: number;
  /** Defaults to result.invocationId. */
  toolCallId?: string;
};

function requiresWriteAhead(riskClass: ToolDescriptor["riskClass"]): boolean {
  return riskClass === "write" || riskClass === "critical";
}

function utf8JsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Deterministic in-process tool registry for harness tests.
 * Records invoke order for write-ahead audit assertions.
 */
export class InProcessFakeToolRegistry {
  private readonly tools = new Map<string, InProcessFakeToolSpec>();
  private readonly traces: SandboxInvokeTrace[] = [];
  private seq = 0;

  get invokeOrder(): readonly SandboxInvokeTrace[] {
    return this.traces;
  }

  clearTraces(): void {
    this.traces.length = 0;
    this.seq = 0;
  }

  register(spec: InProcessFakeToolSpec): void {
    if (this.tools.size >= SANDBOX_REGISTRY_LIMIT) {
      throw new Error(
        `InProcessFakeToolRegistry exceeded ${SANDBOX_REGISTRY_LIMIT} tools`,
      );
    }
    const name = spec.descriptor.name.trim();
    if (!name) throw new Error("tool descriptor name required");
    this.tools.set(name, {
      ...spec,
      descriptor: { ...spec.descriptor, name },
    });
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((t) => ({ ...t.descriptor }));
  }

  get(name: string): InProcessFakeToolSpec | undefined {
    return this.tools.get(name.trim());
  }

  appendTrace(
    phase: SandboxInvokeTracePhase,
    toolName: string,
    invocationId: string,
    riskClass: ToolDescriptor["riskClass"],
    subjectId: string,
  ): void {
    if (this.traces.length >= SANDBOX_INVOKE_LOG_LIMIT) return;
    this.traces.push({
      phase,
      toolName,
      invocationId,
      riskClass,
      subjectId,
      seq: ++this.seq,
    });
  }

  /**
   * Run the registered effect (or hang). Pure of deadline — seam races it.
   */
  async runEffect(
    name: string,
    args: Record<string, unknown>,
    ctx: SandboxSeamContext,
  ): Promise<unknown> {
    const spec = this.tools.get(name.trim());
    if (!spec) throw new Error(`unknown tool: ${name}`);
    if (spec.hang) {
      return new Promise(() => {
        /* never resolves — seam deadline must terminate */
      });
    }
    if (spec.invalidResult) {
      return Symbol("sandbox-invalid-result");
    }
    if (spec.effect) {
      return await spec.effect(args, ctx);
    }
    return { echo: args, toolName: spec.descriptor.name };
  }

  /** Adapt to ToolInterface for hosts that still speak the contract surface. */
  asToolInterface(seam: SandboxSeam, subjectId: string): ToolInterface {
    const self = this;
    return {
      list: () => self.list(),
      async invoke(
        invocation: ToolInvocation,
        deadlineMs: number,
      ): Promise<ToolResult> {
        const descriptor = self.get(invocation.toolName)?.descriptor;
        if (!descriptor) {
          return {
            invocationId: invocation.invocationId,
            status: "error",
            output: {
              kind: "unknown_tool",
              message: "unknown tool",
            },
            latencyMs: 0,
          };
        }
        const result = await seam.invoke(descriptor, invocation.arguments, {
          subjectId,
          invocationId: invocation.invocationId,
          deadlineMs,
          idempotencyKey: invocation.invocationId,
          ...(requiresWriteAhead(descriptor.riskClass)
            ? { writeAheadRecorded: true as const }
            : {}),
        });
        if (result.ok) {
          return {
            invocationId: result.invocationId,
            status: "ok",
            output: result.output,
            latencyMs: result.latencyMs,
          };
        }
        return {
          invocationId: result.invocationId,
          status: "error",
          output: result.error,
          latencyMs: result.latencyMs,
        };
      },
    };
  }
}

/**
 * Validate `value` against a minimal JSON Schema subset.
 * Returns at most SANDBOX_SCHEMA_ISSUE_LIMIT issues.
 */
export function validateToolResultSchema(
  schema: SandboxResultJsonSchema,
  value: unknown,
  path = "$",
): SandboxResultValidation {
  const issues: SandboxSchemaIssue[] = [];
  const push = (p: string, message: string): void => {
    if (issues.length < SANDBOX_SCHEMA_ISSUE_LIMIT) {
      issues.push({ path: p, message });
    }
  };

  const expectedType = schema.type;
  if (expectedType) {
    const actual = jsonTypeOf(value);
    if (actual !== expectedType) {
      push(path, `expected type ${expectedType}, got ${actual}`);
      return {
        ok: false,
        detail: `result schema violation at ${path}`,
        issues,
      };
    }
  }

  if (schema.type === "object" || (schema.properties && isPlainObject(value))) {
    if (!isPlainObject(value)) {
      push(path, "expected object");
      return {
        ok: false,
        detail: `result schema violation at ${path}`,
        issues,
      };
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required.slice(0, SANDBOX_SCHEMA_ISSUE_LIMIT)) {
      if (typeof key !== "string" || !(key in value)) {
        push(`${path}.${key}`, `required property '${key}' missing`);
      }
    }
    const props = schema.properties ?? {};
    for (const [key, child] of Object.entries(props)) {
      if (key in value) {
        const nested = validateToolResultSchema(
          child,
          value[key],
          `${path}.${key}`,
        );
        if (!nested.ok && nested.issues) {
          for (const issue of nested.issues) {
            push(issue.path, issue.message);
          }
        }
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          push(`${path}.${key}`, "additional property not allowed");
        }
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    for (let i = 0; i < Math.min(value.length, SANDBOX_SCHEMA_ISSUE_LIMIT); i++) {
      const nested = validateToolResultSchema(
        schema.items,
        value[i],
        `${path}[${i}]`,
      );
      if (!nested.ok && nested.issues) {
        for (const issue of nested.issues) {
          push(issue.path, issue.message);
        }
      }
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      detail: `result schema violation (${issues.length} issue(s))`,
      issues,
    };
  }
  return { ok: true };
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildRegistryValidateResult(
  registry: InProcessFakeToolRegistry,
): (
  descriptor: ToolDescriptor,
  output: unknown,
) => SandboxResultValidation {
  return (descriptor, output) => {
    const spec = registry.get(descriptor.name);
    if (spec?.invalidResult || typeof output === "symbol") {
      return {
        ok: false,
        detail: "result failed schema validation",
        issues: [
          {
            path: "$",
            message: "non-JSON or poison result rejected at sandbox boundary",
          },
        ],
      };
    }
    if (spec?.resultSchema) {
      return validateToolResultSchema(spec.resultSchema, output);
    }
    // No schema declared — still reject non-JSON-serializable output.
    try {
      JSON.stringify(output);
    } catch {
      return {
        ok: false,
        detail: "result is not JSON-serializable",
        issues: [{ path: "$", message: "result is not JSON-serializable" }],
      };
    }
    return { ok: true };
  };
}

/**
 * Map a seam result to an A P6 TOOL_STATUS frame (success or error).
 * Schema-invalid and other failures never put raw poison in `detail`.
 */
export function mapSandboxResultToToolStatus(
  result: SandboxInvokeResult,
  opts: MapSandboxResultOptions,
): ToolStatusFrame {
  const subjectId = opts.subjectId.trim();
  const toolCallId =
    (typeof opts.toolCallId === "string" && opts.toolCallId.trim()) ||
    result.invocationId;
  if (result.ok) {
    return {
      type: "TOOL_STATUS",
      sequenceIndex: opts.sequenceIndex,
      correlationId: opts.correlationId,
      subjectId,
      toolCallId,
      status: "success",
    };
  }
  const detail = result.error.obligationId
    ? `${result.error.obligationId}: ${result.error.message}`
    : result.error.message;
  return {
    type: "TOOL_STATUS",
    sequenceIndex: opts.sequenceIndex,
    correlationId: opts.correlationId,
    subjectId,
    toolCallId,
    status: "error",
    detail: detail.slice(0, 256),
  };
}

/**
 * Structured tool_response for model resume — status + output/error only.
 * Never embeds raw undeclared / poison payloads as success content.
 */
export function mapSandboxResultToToolResponse(
  result: SandboxInvokeResult,
): SandboxToolResponse {
  if (result.ok) {
    return {
      role: "tool",
      toolCallId: result.invocationId,
      content: JSON.stringify({
        status: "ok",
        output: result.output ?? null,
      }),
    };
  }
  return {
    role: "tool",
    toolCallId: result.invocationId,
    content: JSON.stringify({
      status: "error",
      error: {
        kind: result.error.kind,
        message: result.error.message,
        ...(result.error.obligationId
          ? { obligationId: result.error.obligationId }
          : {}),
        ...(result.error.issues ? { issues: result.error.issues } : {}),
      },
    }),
  };
}

/**
 * Invoke through the seam and map to TOOL_STATUS + tool_response in one step.
 * Used by host turns so a hung tool's deadline kill ends as typed error frames
 * without blocking the loop on a never-resolving promise.
 */
export async function invokeSandboxAndMap(
  seam: SandboxSeam,
  descriptor: ToolDescriptor,
  args: Record<string, unknown>,
  ctx: SandboxSeamContext,
  mapOpts: MapSandboxResultOptions,
): Promise<{
  result: SandboxInvokeResult;
  toolStatus: ToolStatusFrame;
  toolResponse: SandboxToolResponse;
}> {
  const result = await seam.invoke(descriptor, args, ctx);
  return {
    result,
    toolStatus: mapSandboxResultToToolStatus(result, mapOpts),
    toolResponse: mapSandboxResultToToolResponse(result),
  };
}

/**
 * Create a subject-scoped sandbox seam over an InProcessFakeToolRegistry.
 */
export function createSandboxSeam(opts: CreateSandboxSeamOptions): SandboxSeam {
  const subjectId = opts.subjectId.trim();
  if (!subjectId) {
    throw new Error("createSandboxSeam requires non-empty subjectId");
  }
  const deviceId = opts.deviceId?.trim();
  const registry = opts.registry;
  const validateResult =
    opts.validateResult ?? buildRegistryValidateResult(registry);
  const idempotent = new Map<string, Promise<SandboxInvokeResult>>();
  const inFlight = new Map<string, Promise<SandboxInvokeResult>>();

  const emitTel = (
    partial: Omit<SandboxSeamTelemetryEvent, "event" | "subjectId"> & {
      subjectId?: string | null;
    },
  ): void => {
    if (!opts.onTelemetry) return;
    opts.onTelemetry({
      event: "runtime.harness.sandbox_seam",
      subjectId:
        partial.subjectId !== undefined ? partial.subjectId : subjectId,
      outcome: partial.outcome,
      ...(deviceId ? { deviceId } : {}),
      ...(partial.toolName !== undefined ? { toolName: partial.toolName } : {}),
      ...(partial.riskClass !== undefined
        ? { riskClass: partial.riskClass }
        : {}),
      ...(partial.failureClass !== undefined
        ? { failureClass: partial.failureClass }
        : {}),
      ...(partial.invocationId !== undefined
        ? { invocationId: partial.invocationId }
        : {}),
      ...(partial.latencyMs !== undefined
        ? { latencyMs: partial.latencyMs }
        : {}),
    });
  };

  const reject = (
    failureClass: SandboxSeamFailureClass,
    message: string,
    started: number,
    invocationId: string,
    ctxSubject: string | null,
    toolName?: string,
    riskClass?: ToolDescriptor["riskClass"],
    extras?: {
      obligationId?: string;
      issues?: SandboxSchemaIssue[];
    },
  ): SandboxInvokeRejected => {
    const latencyMs = Math.max(0, Date.now() - started);
    emitTel({
      outcome: "rejected",
      subjectId: ctxSubject,
      failureClass,
      invocationId,
      latencyMs,
      ...(toolName ? { toolName } : {}),
      ...(riskClass ? { riskClass } : {}),
    });
    return {
      ok: false,
      status: "error",
      failureClass,
      invocationId,
      subjectId: ctxSubject,
      latencyMs,
      error: {
        kind: failureClass,
        message,
        ...(extras?.obligationId
          ? { obligationId: extras.obligationId }
          : {}),
        ...(extras?.issues ? { issues: extras.issues } : {}),
      },
    };
  };

  async function invokeOnce(
    descriptor: ToolDescriptor,
    args: Record<string, unknown>,
    ctx: SandboxSeamContext,
  ): Promise<SandboxInvokeResult> {
    const started = Date.now();
    const invocationId =
      typeof ctx.invocationId === "string" ? ctx.invocationId.trim() : "";
    const ctxSubject =
      typeof ctx.subjectId === "string" ? ctx.subjectId.trim() : "";

    if (!ctxSubject) {
      return reject(
        "missing_subject",
        "subjectId required for sandbox invoke",
        started,
        invocationId || "unknown",
        null,
      );
    }
    if (ctxSubject !== subjectId) {
      return reject(
        "cross_subject",
        "ctx.subjectId does not match seam subject scope",
        started,
        invocationId || "unknown",
        ctxSubject,
        descriptor.name,
        descriptor.riskClass,
      );
    }
    if (!invocationId) {
      return reject(
        "schema_invalid",
        "invocationId required",
        started,
        "unknown",
        ctxSubject,
        descriptor.name,
        descriptor.riskClass,
      );
    }

    const deadlineMs = ctx.deadlineMs;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      return reject(
        "invalid_deadline",
        "deadlineMs must be a positive finite number",
        started,
        invocationId,
        ctxSubject,
        descriptor.name,
        descriptor.riskClass,
      );
    }

    const spec = registry.get(descriptor.name);
    if (!spec || spec.descriptor.name !== descriptor.name) {
      return reject(
        "unknown_tool",
        "tool not registered in sandbox registry",
        started,
        invocationId,
        ctxSubject,
        descriptor.name,
        descriptor.riskClass,
      );
    }

    if (requiresWriteAhead(descriptor.riskClass) && !ctx.writeAheadRecorded) {
      registry.appendTrace(
        "denied",
        descriptor.name,
        invocationId,
        descriptor.riskClass,
        ctxSubject,
      );
      return reject(
        "audit_required",
        "write/critical invoke requires write-ahead audit acknowledgment",
        started,
        invocationId,
        ctxSubject,
        descriptor.name,
        descriptor.riskClass,
      );
    }

    if (requiresWriteAhead(descriptor.riskClass)) {
      registry.appendTrace(
        "audit",
        descriptor.name,
        invocationId,
        descriptor.riskClass,
        ctxSubject,
      );
    }

    const gate = { timedOut: false };

    const work = (async (): Promise<SandboxInvokeResult> => {
      try {
        const output = await registry.runEffect(
          descriptor.name,
          args,
          { ...ctx, subjectId: ctxSubject, invocationId },
        );
        if (gate.timedOut) {
          // Deadline already won — do not append effect or emit success.
          return reject(
            "deadline_exceeded",
            "tool deadline exceeded",
            started,
            invocationId,
            ctxSubject,
            descriptor.name,
            descriptor.riskClass,
          );
        }
        // Schema before oversize so poison / non-JSON results map to
        // schema_invalid (never raw Symbol / undeclared passthrough).
        const validated = validateResult(descriptor, output);
        if (!validated.ok) {
          return reject(
            "schema_invalid",
            validated.detail,
            started,
            invocationId,
            ctxSubject,
            descriptor.name,
            descriptor.riskClass,
            {
              obligationId: SANDBOX_RESULT_SCHEMA_OBLIGATION,
              ...(validated.issues ? { issues: validated.issues } : {}),
            },
          );
        }
        const maxBytes = spec.maxBytes ?? SANDBOX_MAX_BYTES_DEFAULT;
        if (utf8JsonBytes(output) > maxBytes) {
          return reject(
            "payload_oversize",
            `tool result exceeded maxBytes=${maxBytes}`,
            started,
            invocationId,
            ctxSubject,
            descriptor.name,
            descriptor.riskClass,
          );
        }
        registry.appendTrace(
          "effect",
          descriptor.name,
          invocationId,
          descriptor.riskClass,
          ctxSubject,
        );
        const latencyMs = Math.max(0, Date.now() - started);
        emitTel({
          outcome: "ok",
          toolName: descriptor.name,
          riskClass: descriptor.riskClass,
          invocationId,
          latencyMs,
        });
        return {
          ok: true,
          status: "ok",
          invocationId,
          output,
          latencyMs,
          subjectId: ctxSubject,
        };
      } catch {
        if (gate.timedOut) {
          return reject(
            "deadline_exceeded",
            "tool deadline exceeded",
            started,
            invocationId,
            ctxSubject,
            descriptor.name,
            descriptor.riskClass,
          );
        }
        return reject(
          "tool_threw",
          "tool effect rejected",
          started,
          invocationId,
          ctxSubject,
          descriptor.name,
          descriptor.riskClass,
        );
      }
    })();

    return raceDeadline(work, {
      deadlineMs,
      started,
      invocationId,
      subjectId: ctxSubject,
      toolName: descriptor.name,
      riskClass: descriptor.riskClass,
      reject,
      gate,
    });
  }

  return {
    async invoke(descriptor, args, ctx) {
      const key =
        (typeof ctx.idempotencyKey === "string" &&
          ctx.idempotencyKey.trim()) ||
        (typeof ctx.invocationId === "string" && ctx.invocationId.trim()) ||
        "";

      if (key && idempotent.has(key)) {
        return idempotent.get(key)!;
      }
      if (key && inFlight.has(key)) {
        return inFlight.get(key)!;
      }

      const pending = invokeOnce(descriptor, args, ctx).then((result) => {
        if (key) {
          inFlight.delete(key);
          idempotent.set(key, Promise.resolve(result));
          if (idempotent.size > SANDBOX_INVOKE_LOG_LIMIT) {
            const first = idempotent.keys().next().value;
            if (first !== undefined) idempotent.delete(first);
          }
        }
        return result;
      });

      if (key) inFlight.set(key, pending);
      return pending;
    },
  };
}

function raceDeadline(
  work: Promise<SandboxInvokeResult>,
  opts: {
    deadlineMs: number;
    started: number;
    invocationId: string;
    subjectId: string;
    toolName: string;
    riskClass: ToolDescriptor["riskClass"];
    gate: { timedOut: boolean };
    reject: (
      failureClass: SandboxSeamFailureClass,
      message: string,
      started: number,
      invocationId: string,
      ctxSubject: string | null,
      toolName?: string,
      riskClass?: ToolDescriptor["riskClass"],
    ) => SandboxInvokeRejected;
  },
): Promise<SandboxInvokeResult> {
  return new Promise<SandboxInvokeResult>((resolve) => {
    let settled = false;
    const finish = (value: SandboxInvokeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      opts.gate.timedOut = true;
      finish(
        opts.reject(
          "deadline_exceeded",
          "tool deadline exceeded",
          opts.started,
          opts.invocationId,
          opts.subjectId,
          opts.toolName,
          opts.riskClass,
        ),
      );
    }, opts.deadlineMs);
    work.then(
      (value) => finish(value),
      () =>
        finish(
          opts.reject(
            "deadline_exceeded",
            "tool work rejected; treated as deadline failure",
            opts.started,
            opts.invocationId,
            opts.subjectId,
            opts.toolName,
            opts.riskClass,
          ),
        ),
    );
  });
}
