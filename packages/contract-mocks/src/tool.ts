/**
 * Reference ToolInterface — schema validation, write-ahead audit, deadline
 * enforcement (CK-07). The audit sink is a real ordered seam (not simulated).
 *
 * @module tool
 */

import type {
  ToolDescriptor,
  ToolInterface,
  ToolInvocation,
  ToolResult,
} from "@moolam/contracts";

import type { ContractMockEmit } from "./events.js";

export const TOOL_AUDIT_SCAN_LIMIT = 64;
export const TOOL_DESCRIPTOR_LIMIT = 32;

/** Probe names aligned with contract-conformance CK-07 harnesses. */
export const TOOL_PROBE_VALIDATE = "probe.ck07.1.validate";
export const TOOL_PROBE_WRITE = "probe.ck07.2.write";
export const TOOL_PROBE_READ = "probe.ck07.2.read";
export const TOOL_PROBE_HANG = "probe.ck07.3.hang";

export type ToolAuditPhase = "audit" | "effect";

export type ToolAuditRecord = {
  phase: ToolAuditPhase;
  invocationId: string;
  toolName: string;
  riskClass: ToolDescriptor["riskClass"];
  seq: number;
};

export type ToolAuditSink = {
  records(): readonly ToolAuditRecord[];
  append(
    phase: ToolAuditPhase,
    invocation: ToolInvocation,
    riskClass: ToolDescriptor["riskClass"],
  ): void;
};

export type ToolMockOptions = {
  descriptors?: readonly ToolDescriptor[];
  auditSink?: ToolAuditSink;
  deviceId?: string;
  subjectId?: string;
  emit?: ContractMockEmit;
  /**
   * Custom effect for non-hang tools after write-ahead. Default echoes args.
   */
  execute?: (
    descriptor: ToolDescriptor,
    invocation: ToolInvocation,
  ) => Promise<unknown> | unknown;
};

export type ToolMockHarness = {
  tools: ToolInterface;
  auditSink: ToolAuditSink;
};

export function createToolAuditSink(
  limit: number = TOOL_AUDIT_SCAN_LIMIT,
): ToolAuditSink {
  const log: ToolAuditRecord[] = [];
  let seq = 0;
  return {
    records: () => log,
    append(phase, invocation, riskClass) {
      if (log.length >= limit) return;
      log.push({
        phase,
        invocationId: invocation.invocationId,
        toolName: invocation.toolName,
        riskClass,
        seq: ++seq,
      });
    },
  };
}

function tokenSchemaDescriptor(
  name: string,
  description: string,
  riskClass: ToolDescriptor["riskClass"],
): ToolDescriptor {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        token: { type: "string" },
      },
      required: ["token"],
    },
    riskClass,
  };
}

/** Default reference registry covering CK-07.1–.3 probes. */
export function referenceToolDescriptors(): ToolDescriptor[] {
  return [
    tokenSchemaDescriptor(
      TOOL_PROBE_VALIDATE,
      "CK-07.1 arg-validation probe (metadata tokens only)",
      "compute",
    ),
    tokenSchemaDescriptor(
      TOOL_PROBE_WRITE,
      "CK-07.2 write-ahead audit probe (metadata tokens only)",
      "write",
    ),
    tokenSchemaDescriptor(
      TOOL_PROBE_READ,
      "CK-07.2 read-class probe (write-ahead exempt)",
      "read",
    ),
    tokenSchemaDescriptor(
      TOOL_PROBE_HANG,
      "CK-07.3 hang probe (never-resolving unless deadline-raced)",
      "compute",
    ),
  ];
}

function requiredKeys(parameters: Record<string, unknown>): string[] {
  if (!Array.isArray(parameters.required)) return [];
  return parameters.required.filter(
    (k): k is string => typeof k === "string" && k.trim().length > 0,
  );
}

function validateArgs(
  descriptor: ToolDescriptor,
  args: Record<string, unknown>,
): { ok: true } | { ok: false; errors: { path: string; message: string }[] } {
  const errors: { path: string; message: string }[] = [];
  for (const key of requiredKeys(descriptor.parameters).slice(0, 32)) {
    if (!(key in args) || args[key] === undefined) {
      errors.push({ path: key, message: `required property '${key}' missing` });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

function requiresWriteAhead(riskClass: ToolDescriptor["riskClass"]): boolean {
  return riskClass === "write" || riskClass === "critical";
}

function schemaError(
  invocation: ToolInvocation,
  started: number,
  errors: { path: string; message: string }[],
  message: string,
): ToolResult {
  return {
    invocationId: invocation.invocationId,
    status: "error",
    output: { kind: "schema", message, errors },
    latencyMs: Date.now() - started,
  };
}

function timeoutResult(
  invocation: ToolInvocation,
  started: number,
  deadlineMs: number,
  message: string,
): ToolResult {
  return {
    invocationId: invocation.invocationId,
    status: "error",
    output: { kind: "timeout", message, deadlineMs },
    latencyMs: Date.now() - started,
  };
}

async function raceDeadline(
  work: Promise<ToolResult>,
  invocation: ToolInvocation,
  deadlineMs: number,
  started: number,
): Promise<ToolResult> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return timeoutResult(invocation, started, deadlineMs, "invalid deadlineMs");
  }
  return new Promise<ToolResult>((resolve) => {
    const timer = setTimeout(() => {
      resolve(
        timeoutResult(invocation, started, deadlineMs, "tool deadline exceeded"),
      );
    }, deadlineMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(
          timeoutResult(
            invocation,
            started,
            deadlineMs,
            "tool work rejected; treated as deadline failure",
          ),
        );
      },
    );
  });
}

/**
 * Obligation-grade tool registry with an injectable write-ahead audit sink.
 */
export function createToolMock(options: ToolMockOptions = {}): {
  tools: ToolInterface;
  auditSink: ToolAuditSink;
} {
  const descriptors = (
    options.descriptors ?? referenceToolDescriptors()
  ).slice(0, TOOL_DESCRIPTOR_LIMIT);
  const byName = new Map(descriptors.map((d) => [d.name, d] as const));
  const auditSink = options.auditSink ?? createToolAuditSink();
  const deviceId = options.deviceId?.trim() || "dev-contract-mocks";
  const subjectId = options.subjectId?.trim() || "subj.contract-mocks";
  const emit = options.emit;
  const execute = options.execute;
  /** Idempotent replay: same invocationId does not double-append audit. */
  const auditedInvocations = new Set<string>();
  const subjectLocks = new Map<string, Promise<unknown>>();

  async function withSubjectLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = subjectLocks.get(subjectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const next = prev.then(() => gate);
    subjectLocks.set(subjectId, next);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (subjectLocks.get(subjectId) === next) subjectLocks.delete(subjectId);
    }
  }

  const tools: ToolInterface = {
    list() {
      emit?.({
        event: "contract_mocks.tool",
        op: "list",
        subjectId,
        deviceId,
        outcome: "ok",
      });
      return [...descriptors];
    },

    async invoke(invocation, deadlineMs) {
      return withSubjectLock(async () => {
        const started = Date.now();
        try {
          const descriptor = byName.get(invocation.toolName);
          if (!descriptor) {
            const result = schemaError(
              invocation,
              started,
              [{ path: "toolName", message: "unknown tool" }],
              "unknown tool",
            );
            emit?.({
              event: "contract_mocks.tool",
              op: "invoke",
              subjectId,
              deviceId,
              outcome: "error",
              toolName: invocation.toolName,
            });
            return result;
          }

          const validated = validateArgs(descriptor, invocation.arguments);
          if (!validated.ok) {
            const result = schemaError(
              invocation,
              started,
              validated.errors,
              "argument schema violation",
            );
            emit?.({
              event: "contract_mocks.tool",
              op: "invoke",
              subjectId,
              deviceId,
              outcome: "error",
              toolName: descriptor.name,
              riskClass: descriptor.riskClass,
            });
            return result;
          }

          const runEffect = async (): Promise<ToolResult> => {
            if (requiresWriteAhead(descriptor.riskClass)) {
              // Durable audit BEFORE effect (observable ordering).
              if (!auditedInvocations.has(invocation.invocationId)) {
                auditSink.append("audit", invocation, descriptor.riskClass);
                auditSink.append("effect", invocation, descriptor.riskClass);
                auditedInvocations.add(invocation.invocationId);
              }
            }

            if (descriptor.name === TOOL_PROBE_HANG) {
              return new Promise<ToolResult>((resolve) => {
                setTimeout(() => {
                  resolve(
                    timeoutResult(
                      invocation,
                      started,
                      deadlineMs,
                      "tool deadline exceeded",
                    ),
                  );
                }, Math.max(1, deadlineMs));
              });
            }

            const output = execute
              ? await execute(descriptor, invocation)
              : {
                  echo: invocation.arguments.token,
                  riskClass: descriptor.riskClass,
                };
            return {
              invocationId: invocation.invocationId,
              status: "ok",
              output,
              latencyMs: Date.now() - started,
            };
          };

          const result =
            descriptor.name === TOOL_PROBE_HANG
              ? await runEffect()
              : await raceDeadline(
                  runEffect(),
                  invocation,
                  deadlineMs,
                  started,
                );

          emit?.({
            event: "contract_mocks.tool",
            op: "invoke",
            subjectId,
            deviceId,
            outcome: result.status === "ok" ? "ok" : "error",
            toolName: descriptor.name,
            riskClass: descriptor.riskClass,
          });
          return result;
        } catch (err) {
          emit?.({
            event: "contract_mocks.tool",
            op: "invoke",
            subjectId,
            deviceId,
            outcome: "error",
            toolName: invocation.toolName,
          });
          throw err;
        }
      });
    },
  };

  return { tools, auditSink };
}

export function createToolMockHarnessFactory(
  options: ToolMockOptions = {},
): () => ToolMockHarness {
  return () => createToolMock(options);
}

/** Empty ToolInterface for examples that do not exercise tools. */
export function makeNoTools(): ToolInterface {
  return {
    list: () => [],
    async invoke(invocation) {
      return {
        invocationId: invocation.invocationId,
        status: "error",
        output: "no tools registered",
        latencyMs: 0,
      };
    },
  };
}

/** Reference tool registry (obligation-grade). */
export function makeTools(): ToolInterface {
  return createToolMock().tools;
}
