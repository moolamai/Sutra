/**
 * ToolInterface obligations (/003).
 *
 * CK-07.1 — `invoke` MUST validate arguments against the descriptor schema
 * and return status `"error"` (not throw) on violation, with schema details.
 * CK-07.2 — `"write"` / `"critical"` invocations MUST be recorded to the
 * harness audit sink before execution begins (write-ahead); read/compute exempt.
 * CK-07.3 — Implementations MUST enforce the deadline; a hung tool cannot hang
 * the agent (typed timeout in ToolResult.output).
 */

import type {
  ToolDescriptor,
  ToolInterface,
  ToolInvocation,
  ToolResult,
} from "@moolam/contracts";

import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
  type ObligationContext,
} from "../registry.js";

/**
 * Verbatim MUST sentence from `packages/contracts/src/tool.ts`
 * (contract requirement #1).
 */
export const MUST_ARG_VALIDATION =
  '`invoke` MUST validate arguments against the descriptor schema and return status "error" (not throw) on violation.';

/**
 * Contract requirement #2 (write-ahead audit).
 */
export const MUST_WRITE_AHEAD_AUDIT =
  '"write"/"critical" invocations MUST be recorded to the audit sink before execution begins (write-ahead audit).';

/**
 * Contract requirement #3 (deadline enforcement).
 */
export const MUST_DEADLINE_ENFORCEMENT =
  "Implementations MUST enforce the deadline; a hung tool cannot hang the agent.";

export const TOOL_OBLIGATION_IDS = {
  argValidation: "CK-07.1",
  writeAheadAudit: "CK-07.2",
  deadlineEnforcement: "CK-07.3",
} as const;

/** Probe tool name used by CK-07.1 reference / violation harnesses. */
export const TOOL_PROBE_NAME = "probe.ck07.1.validate";

/** Write-class probe tool for CK-07.2. */
export const TOOL_WRITE_PROBE_NAME = "probe.ck07.2.write";

/** Read-class probe — write-ahead exempt. */
export const TOOL_READ_PROBE_NAME = "probe.ck07.2.read";

/** Hang-class compute probe for CK-07.3 (never-resolving work unless deadline-raced). */
export const TOOL_HANG_PROBE_NAME = "probe.ck07.3.hang";

/** Max audit records inspected per check (NFR / scalability). */
export const TOOL_AUDIT_SCAN_LIMIT = 64;

/** Deadline passed to hang probe during CK-07.3 check (ms). */
export const TOOL_DEADLINE_PROBE_MS = 40;

/**
 * Watchdog after which a non-returning invoke fails CK-07.3 (ms).
 * Must exceed {@link TOOL_DEADLINE_PROBE_MS} so a correct typed timeout can win.
 */
export const TOOL_DEADLINE_WATCHDOG_MS = 200;

export type ToolAuditPhase = "audit" | "effect";

/** One sequenced harness audit-sink entry (observable ordering). */
export interface ToolAuditRecord {
  phase: ToolAuditPhase;
  invocationId: string;
  toolName: string;
  riskClass: ToolDescriptor["riskClass"];
  seq: number;
}

export interface ToolAuditSink {
  /** Bounded timeline of audit/effect markers. */
  records(): readonly ToolAuditRecord[];
}

/**
 * Conformance surface for tool registries.
 * Probe only through `list` + `invoke` + harness audit sink.
 */
export interface ToolConformanceHarness {
  tools: ToolInterface;
  auditSink: ToolAuditSink;
}

function subjectToken(subjectId: string): string {
  return subjectId
    .replace(/[^A-Za-z0-9._-]/g, ".")
    .replace(/\.{2,}/g, ".");
}

/** Subject-scoped invocation id — metadata only, never learner content. */
export function buildToolInvocationId(ctx: ObligationContext): string {
  return `probe.ck07.1.inv.${subjectToken(ctx.subjectId)}`;
}

export function buildWriteAheadInvocationId(ctx: ObligationContext): string {
  return `probe.ck07.2.inv.${subjectToken(ctx.subjectId)}`;
}

export function buildDeadlineInvocationId(ctx: ObligationContext): string {
  return `probe.ck07.3.inv.${subjectToken(ctx.subjectId)}`;
}

/**
 * Build arguments that omit every `required` property (schema violation).
 * Falls back to `{ "__invalid": true }` when the schema has no required keys.
 */
export function buildInvalidToolArguments(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const required = Array.isArray(parameters.required)
    ? (parameters.required as unknown[]).filter(
        (k): k is string => typeof k === "string" && k.length > 0,
      )
    : [];
  if (required.length === 0) {
    return { __probeInvalid: true };
  }
  return {};
}

/** Valid minimal args for the conformance write/compute probes. */
export function buildValidToolArguments(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const required = Array.isArray(parameters.required)
    ? (parameters.required as unknown[]).filter(
        (k): k is string => typeof k === "string" && k.length > 0,
      )
    : [];
  const args: Record<string, unknown> = {};
  for (const key of required.slice(0, 32)) {
    args[key] = `probe.${key}.token`;
  }
  return args;
}

/** Detect structured or textual schema-validation details in ToolResult.output. */
export function hasSchemaErrorDetails(output: unknown): boolean {
  if (output == null) return false;
  if (typeof output === "string") {
    return /schema|required|missing|invalid|argument|parameter/i.test(output);
  }
  if (typeof output === "object") {
    const row = output as Record<string, unknown>;
    if (row.kind === "schema" || row.type === "schema_violation") return true;
    if (Array.isArray(row.errors) && row.errors.length > 0) return true;
    if (
      typeof row.message === "string" &&
      /schema|required|missing|invalid|argument/i.test(row.message)
    ) {
      return true;
    }
  }
  return false;
}

/** Detect typed deadline/timeout report in ToolResult (status error, never throw). */
export function hasTimeoutErrorDetails(output: unknown): boolean {
  if (output == null) return false;
  if (typeof output === "string") {
    return /timeout|deadline|timed.?out/i.test(output);
  }
  if (typeof output === "object") {
    const row = output as Record<string, unknown>;
    if (
      row.kind === "timeout" ||
      row.type === "timeout" ||
      row.code === "timeout" ||
      row.reason === "deadline"
    ) {
      return true;
    }
    if (
      typeof row.message === "string" &&
      /timeout|deadline|timed.?out/i.test(row.message)
    ) {
      return true;
    }
  }
  return false;
}

function requiredKeys(parameters: Record<string, unknown>): string[] {
  if (!Array.isArray(parameters.required)) return [];
  return parameters.required.filter(
    (k): k is string => typeof k === "string" && k.trim().length > 0,
  );
}

function validateAgainstDescriptor(
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

function createRecordingSink(): ToolAuditSink & {
  append(
    phase: ToolAuditPhase,
    invocation: ToolInvocation,
    riskClass: ToolDescriptor["riskClass"],
  ): void;
} {
  const log: ToolAuditRecord[] = [];
  let seq = 0;
  return {
    records: () => log,
    append(phase, invocation, riskClass) {
      if (log.length >= TOOL_AUDIT_SCAN_LIMIT) return;
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

/** Race work against deadlineMs; returns timed-out ToolResult (never throws). */
async function invokeWithDeadline(
  work: Promise<ToolResult>,
  invocation: ToolInvocation,
  deadlineMs: number,
  started: number,
): Promise<ToolResult> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return {
      invocationId: invocation.invocationId,
      status: "error",
      output: {
        kind: "timeout",
        message: "invalid deadlineMs",
        deadlineMs,
      },
      latencyMs: Date.now() - started,
    };
  }
  return new Promise<ToolResult>((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        invocationId: invocation.invocationId,
        status: "error",
        output: {
          kind: "timeout",
          message: "tool deadline exceeded",
          deadlineMs,
        },
        latencyMs: Date.now() - started,
      });
    }, deadlineMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve({
          invocationId: invocation.invocationId,
          status: "error",
          output: {
            kind: "timeout",
            message: "tool work rejected; treated as deadline failure",
            deadlineMs,
          },
          latencyMs: Date.now() - started,
        });
      },
    );
  });
}

/**
 * Simulates a hung tool that the conforming runtime terminates at `deadlineMs`.
 */
function hangTerminatedAtDeadline(
  invocation: ToolInvocation,
  deadlineMs: number,
  started: number,
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    setTimeout(() => {
      resolve({
        invocationId: invocation.invocationId,
        status: "error",
        output: {
          kind: "timeout",
          message: "tool deadline exceeded",
          deadlineMs,
        },
        latencyMs: Date.now() - started,
      });
    }, Math.max(1, deadlineMs));
  });
}

/**
 * Violation hang: ignores deadline; settles shortly after the CK-07.3 watchdog
 * so the check observes a hang without leaving a forever-pending Promise.
 */
function hangPastWatchdog(
  invocation: ToolInvocation,
  started: number,
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    setTimeout(() => {
      resolve({
        invocationId: invocation.invocationId,
        status: "ok",
        output: { echo: invocation.arguments.token, late: true },
        latencyMs: Date.now() - started,
      });
    }, TOOL_DEADLINE_WATCHDOG_MS + 40);
  });
}

export function defineArgValidationObligation(): Obligation<ToolConformanceHarness> {
  return defineObligation({
    id: TOOL_OBLIGATION_IDS.argValidation,
    contract: "ToolInterface",
    mustText: MUST_ARG_VALIDATION,
    specIds: ["CK-07"],
    async check(impl, ctx) {
      const descriptors = impl.tools.list();
      if (!Array.isArray(descriptors) || descriptors.length === 0) {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.argValidation,
          mustText: MUST_ARG_VALIDATION,
          contract: "ToolInterface",
          message: "tools.list() returned no descriptors",
        });
      }

      const descriptor =
        descriptors.find((d) => d.name === TOOL_PROBE_NAME) ?? descriptors[0]!;
      if (
        !descriptor.parameters ||
        typeof descriptor.parameters !== "object" ||
        Array.isArray(descriptor.parameters)
      ) {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.argValidation,
          mustText: MUST_ARG_VALIDATION,
          contract: "ToolInterface",
          message: `descriptor '${descriptor.name}' missing parameters schema`,
        });
      }

      const invocation: ToolInvocation = {
        toolName: descriptor.name,
        arguments: buildInvalidToolArguments(descriptor.parameters),
        invocationId: buildToolInvocationId(ctx),
      };

      let result: ToolResult;
      try {
        result = await impl.tools.invoke(invocation, 1_000);
      } catch (err) {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.argValidation,
          mustText: MUST_ARG_VALIDATION,
          contract: "ToolInterface",
          message: `invoke() threw on schema violation instead of status "error": ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }

      if (result.invocationId !== invocation.invocationId) {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.argValidation,
          mustText: MUST_ARG_VALIDATION,
          contract: "ToolInterface",
          message: "error result invocationId does not match the probe invocation",
        });
      }
      if (result.status !== "error") {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.argValidation,
          mustText: MUST_ARG_VALIDATION,
          contract: "ToolInterface",
          message: `invalid args produced status "${result.status}" (expected "error")`,
        });
      }
      if (!hasSchemaErrorDetails(result.output)) {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.argValidation,
          mustText: MUST_ARG_VALIDATION,
          contract: "ToolInterface",
          message:
            'status "error" output lacks schema details (required / invalid / errors)',
        });
      }
    },
  });
}

export function defineWriteAheadAuditObligation(): Obligation<ToolConformanceHarness> {
  return defineObligation({
    id: TOOL_OBLIGATION_IDS.writeAheadAudit,
    contract: "ToolInterface",
    mustText: MUST_WRITE_AHEAD_AUDIT,
    specIds: ["CK-07"],
    async check(impl, ctx) {
      const descriptors = impl.tools.list();
      if (!Array.isArray(descriptors) || descriptors.length === 0) {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.writeAheadAudit,
          mustText: MUST_WRITE_AHEAD_AUDIT,
          contract: "ToolInterface",
          message: "tools.list() returned no descriptors",
        });
      }

      const writeTool =
        descriptors.find((d) => d.name === TOOL_WRITE_PROBE_NAME) ??
        descriptors.find((d) => requiresWriteAhead(d.riskClass));
      if (!writeTool) {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.writeAheadAudit,
          mustText: MUST_WRITE_AHEAD_AUDIT,
          contract: "ToolInterface",
          message:
            "no write/critical tool available to probe write-ahead audit ordering",
        });
      }

      const invocation: ToolInvocation = {
        toolName: writeTool.name,
        arguments: buildValidToolArguments(writeTool.parameters),
        invocationId: buildWriteAheadInvocationId(ctx),
      };

      const baseline = impl.auditSink.records().length;
      await impl.tools.invoke(invocation, 1_000);

      const relevant = impl.auditSink
        .records()
        .slice(baseline)
        .filter((r) => r.invocationId === invocation.invocationId)
        .slice(0, TOOL_AUDIT_SCAN_LIMIT);

      const auditIdx = relevant.findIndex((r) => r.phase === "audit");
      const effectIdx = relevant.findIndex((r) => r.phase === "effect");

      if (auditIdx < 0) {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.writeAheadAudit,
          mustText: MUST_WRITE_AHEAD_AUDIT,
          contract: "ToolInterface",
          message:
            "write/critical invoke missing audit-sink record before execution",
        });
      }
      if (effectIdx < 0) {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.writeAheadAudit,
          mustText: MUST_WRITE_AHEAD_AUDIT,
          contract: "ToolInterface",
          message:
            "write/critical invoke missing effect marker (cannot observe write-ahead ordering)",
        });
      }
      if (!(auditIdx < effectIdx)) {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.writeAheadAudit,
          mustText: MUST_WRITE_AHEAD_AUDIT,
          contract: "ToolInterface",
          message:
            "audit-sink ordering violated: effect recorded before (or without preceding) audit",
        });
      }
    },
  });
}

export function defineDeadlineEnforcementObligation(): Obligation<ToolConformanceHarness> {
  return defineObligation({
    id: TOOL_OBLIGATION_IDS.deadlineEnforcement,
    contract: "ToolInterface",
    mustText: MUST_DEADLINE_ENFORCEMENT,
    specIds: ["CK-07"],
    async check(impl, ctx) {
      const descriptors = impl.tools.list();
      if (!Array.isArray(descriptors) || descriptors.length === 0) {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.deadlineEnforcement,
          mustText: MUST_DEADLINE_ENFORCEMENT,
          contract: "ToolInterface",
          message: "tools.list() returned no descriptors",
        });
      }

      const hangTool =
        descriptors.find((d) => d.name === TOOL_HANG_PROBE_NAME) ??
        descriptors.find((d) => d.riskClass === "compute") ??
        descriptors[0]!;

      const invocation: ToolInvocation = {
        toolName: hangTool.name,
        arguments: buildValidToolArguments(hangTool.parameters),
        invocationId: buildDeadlineInvocationId(ctx),
      };

      type RaceOutcome =
        | { kind: "result"; result: ToolResult }
        | { kind: "threw"; err: unknown }
        | { kind: "watchdog" };

      const outcome = await new Promise<RaceOutcome>((resolve) => {
        const timer = setTimeout(
          () => resolve({ kind: "watchdog" }),
          TOOL_DEADLINE_WATCHDOG_MS,
        );
        impl.tools
          .invoke(invocation, TOOL_DEADLINE_PROBE_MS)
          .then(
            (result) => {
              clearTimeout(timer);
              resolve({ kind: "result", result });
            },
            (err: unknown) => {
              clearTimeout(timer);
              resolve({ kind: "threw", err });
            },
          );
      });

      if (outcome.kind === "watchdog") {
        // Give a deliberate hang a bounded window to settle so the Node
        // test runner does not see a forever-pending invoke Promise.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 60);
        });
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.deadlineEnforcement,
          mustText: MUST_DEADLINE_ENFORCEMENT,
          contract: "ToolInterface",
          message: `invoke() hung past deadlineMs=${TOOL_DEADLINE_PROBE_MS} (watchdog ${TOOL_DEADLINE_WATCHDOG_MS}ms)`,
        });
      }
      if (outcome.kind === "threw") {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.deadlineEnforcement,
          mustText: MUST_DEADLINE_ENFORCEMENT,
          contract: "ToolInterface",
          message: `invoke() threw on deadline instead of typed timeout: ${
            outcome.err instanceof Error
              ? outcome.err.message
              : String(outcome.err)
          }`,
        });
      }

      const result = outcome.result;
      if (result.invocationId !== invocation.invocationId) {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.deadlineEnforcement,
          mustText: MUST_DEADLINE_ENFORCEMENT,
          contract: "ToolInterface",
          message: "timeout result invocationId does not match the probe invocation",
        });
      }
      if (result.status !== "error") {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.deadlineEnforcement,
          mustText: MUST_DEADLINE_ENFORCEMENT,
          contract: "ToolInterface",
          message: `hung tool produced status "${result.status}" (expected typed timeout via status "error")`,
        });
      }
      if (!hasTimeoutErrorDetails(result.output)) {
        throw new ObligationViolation({
          obligationId: TOOL_OBLIGATION_IDS.deadlineEnforcement,
          mustText: MUST_DEADLINE_ENFORCEMENT,
          contract: "ToolInterface",
          message:
            'status "error" output lacks typed timeout/deadline details (kind: "timeout")',
        });
      }
    },
  });
}

export function registerArgValidationObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineArgValidationObligation());
  return registry;
}

export function registerWriteAheadAuditObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineWriteAheadAuditObligation());
  return registry;
}

export function registerDeadlineEnforcementObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineDeadlineEnforcementObligation());
  return registry;
}

/** CK-07.1 + CK-07.2 + CK-07.3 */
export function registerToolObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registerArgValidationObligation(registry);
  registerWriteAheadAuditObligation(registry);
  registerDeadlineEnforcementObligation(registry);
  return registry;
}

export function createArgValidationObligationRegistry(): ObligationRegistry {
  return registerArgValidationObligation(new ObligationRegistry());
}

export function createWriteAheadAuditObligationRegistry(): ObligationRegistry {
  return registerWriteAheadAuditObligation(new ObligationRegistry());
}

export function createDeadlineEnforcementObligationRegistry(): ObligationRegistry {
  return registerDeadlineEnforcementObligation(new ObligationRegistry());
}

export function createToolObligationsRegistry(): ObligationRegistry {
  return registerToolObligations(new ObligationRegistry());
}

/* ── Reference / violation harness factories (contract-surface only) ── */

function computeProbeDescriptor(): ToolDescriptor {
  return {
    name: TOOL_PROBE_NAME,
    description: "CK-07.1 arg-validation probe (metadata tokens only)",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string" },
      },
      required: ["token"],
    },
    riskClass: "compute",
  };
}

function writeProbeDescriptor(): ToolDescriptor {
  return {
    name: TOOL_WRITE_PROBE_NAME,
    description: "CK-07.2 write-ahead audit probe (metadata tokens only)",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string" },
      },
      required: ["token"],
    },
    riskClass: "write",
  };
}

function readProbeDescriptor(): ToolDescriptor {
  return {
    name: TOOL_READ_PROBE_NAME,
    description: "CK-07.2 read-class probe (write-ahead exempt)",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string" },
      },
      required: ["token"],
    },
    riskClass: "read",
  };
}

function hangProbeDescriptor(): ToolDescriptor {
  return {
    name: TOOL_HANG_PROBE_NAME,
    description: "CK-07.3 hang probe (never-resolving unless deadline-raced)",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string" },
      },
      required: ["token"],
    },
    riskClass: "compute",
  };
}

function schemaErrorResult(
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

type AuditMode = "write-ahead" | "audit-after-effect" | "none";

function createMultiToolHarness(options: {
  descriptors: ToolDescriptor[];
  auditMode: AuditMode;
  /** When true, invalid args throw instead of typed schema error. */
  throwOnInvalid: boolean;
  /** When true, hang probe ignores deadlineMs (violation). */
  ignoreDeadline: boolean;
}): () => ToolConformanceHarness {
  const byName = new Map(
    options.descriptors.map((d) => [d.name, d] as const),
  );

  return () => {
    const sink = createRecordingSink();
    return {
      auditSink: sink,
      tools: {
        list() {
          return [...options.descriptors];
        },
        async invoke(invocation, deadlineMs) {
          const started = Date.now();
          const descriptor = byName.get(invocation.toolName);
          if (!descriptor) {
            return schemaErrorResult(
              invocation,
              started,
              [{ path: "toolName", message: "unknown tool" }],
              "unknown tool",
            );
          }
          const validated = validateAgainstDescriptor(
            descriptor,
            invocation.arguments,
          );
          if (!validated.ok) {
            if (options.throwOnInvalid) {
              throw new Error("invalid arguments");
            }
            return schemaErrorResult(
              invocation,
              started,
              validated.errors,
              "argument schema violation",
            );
          }

          const runEffect = async (): Promise<ToolResult> => {
            if (
              options.auditMode !== "none" &&
              requiresWriteAhead(descriptor.riskClass)
            ) {
              if (options.auditMode === "write-ahead") {
                sink.append("audit", invocation, descriptor.riskClass);
                sink.append("effect", invocation, descriptor.riskClass);
              } else {
                // audit-after-effect: ordering inversion
                sink.append("effect", invocation, descriptor.riskClass);
                sink.append("audit", invocation, descriptor.riskClass);
              }
            }

            if (descriptor.name === TOOL_HANG_PROBE_NAME) {
              if (options.ignoreDeadline) {
                return hangPastWatchdog(invocation, started);
              }
              return hangTerminatedAtDeadline(
                invocation,
                deadlineMs,
                started,
              );
            }

            return {
              invocationId: invocation.invocationId,
              status: "ok",
              output: {
                echo: invocation.arguments.token,
                riskClass: descriptor.riskClass,
              },
              latencyMs: Date.now() - started,
            };
          };

          if (descriptor.name === TOOL_HANG_PROBE_NAME) {
            return runEffect();
          }
          return invokeWithDeadline(
            runEffect(),
            invocation,
            deadlineMs,
            started,
          );
        },
      },
    };
  };
}

/**
 * Known-good reference for CK-07.1: invalid args → status "error" with schema
 * details; empty audit sink (compute-only). Includes hang probe for isolation.
 */
export function createValidatingToolHarnessFactory(): () => ToolConformanceHarness {
  return createMultiToolHarness({
    descriptors: [computeProbeDescriptor(), hangProbeDescriptor()],
    auditMode: "none",
    throwOnInvalid: false,
    ignoreDeadline: false,
  });
}

/**
 * Known-good reference for CK-07.1 + CK-07.2 + CK-07.3: validates args,
 * write-ahead audit, and deadline-raced hang probe.
 */
export function createWriteAheadToolHarnessFactory(): () => ToolConformanceHarness {
  return createMultiToolHarness({
    descriptors: [
      computeProbeDescriptor(),
      writeProbeDescriptor(),
      readProbeDescriptor(),
      hangProbeDescriptor(),
    ],
    auditMode: "write-ahead",
    throwOnInvalid: false,
    ignoreDeadline: false,
  });
}

/**
 * Violation for CK-07.1: throws on invalid args instead of status "error".
 * Passes CK-07.2 / CK-07.3 so the named fixture isolates exactly one MUST.
 */
export function createThrowingToolHarnessFactory(): () => ToolConformanceHarness {
  return createMultiToolHarness({
    descriptors: [
      computeProbeDescriptor(),
      writeProbeDescriptor(),
      hangProbeDescriptor(),
    ],
    auditMode: "write-ahead",
    throwOnInvalid: true,
    ignoreDeadline: false,
  });
}

/**
 * Violation for CK-07.1: returns status "error" but without schema details.
 */
export function createOpaqueErrorToolHarnessFactory(): () => ToolConformanceHarness {
  const descriptor = computeProbeDescriptor();
  return () => {
    const sink = createRecordingSink();
    return {
      auditSink: sink,
      tools: {
        list() {
          return [descriptor];
        },
        async invoke(invocation) {
          const validated = validateAgainstDescriptor(
            descriptor,
            invocation.arguments,
          );
          if (!validated.ok) {
            return {
              invocationId: invocation.invocationId,
              status: "error",
              output: { code: 1 },
              latencyMs: 0,
            };
          }
          return {
            invocationId: invocation.invocationId,
            status: "ok",
            output: true,
            latencyMs: 0,
          };
        },
      },
    };
  };
}

/**
 * Violation for CK-07.2: records effect before audit (audit-after-effect).
 * Passes CK-07.1 / CK-07.3 for fixture isolation.
 */
export function createAuditAfterEffectToolHarnessFactory(): () => ToolConformanceHarness {
  return createMultiToolHarness({
    descriptors: [
      computeProbeDescriptor(),
      writeProbeDescriptor(),
      hangProbeDescriptor(),
    ],
    auditMode: "audit-after-effect",
    throwOnInvalid: false,
    ignoreDeadline: false,
  });
}

/**
 * Violation for CK-07.3: hang probe ignores deadlineMs (never returns).
 * Passes CK-07.1 / CK-07.2 for fixture isolation.
 */
export function createHangingToolHarnessFactory(): () => ToolConformanceHarness {
  return createMultiToolHarness({
    descriptors: [
      computeProbeDescriptor(),
      writeProbeDescriptor(),
      hangProbeDescriptor(),
    ],
    auditMode: "write-ahead",
    throwOnInvalid: false,
    ignoreDeadline: true,
  });
}

/** One deliberately-broken tool harness that fails exactly one CK-07.* MUST. */
export interface ToolViolationFixture {
  fixtureId: string;
  targetObligationId: (typeof TOOL_OBLIGATION_IDS)[keyof typeof TOOL_OBLIGATION_IDS];
  mustText: string;
  summary: string;
  createFactory: () => () => ToolConformanceHarness;
}

/**
 * Named catalog — each fixture fails its target and passes the others.
 */
export const TOOL_VIOLATION_FIXTURES = {
  throwOnInvalid: {
    fixtureId: "tool.violation.throw-on-invalid",
    targetObligationId: TOOL_OBLIGATION_IDS.argValidation,
    mustText: MUST_ARG_VALIDATION,
    summary: "invoke() throws on schema violation instead of status \"error\"",
    createFactory: createThrowingToolHarnessFactory,
  },
  auditAfterEffect: {
    fixtureId: "tool.violation.audit-after-effect",
    targetObligationId: TOOL_OBLIGATION_IDS.writeAheadAudit,
    mustText: MUST_WRITE_AHEAD_AUDIT,
    summary: "write/critical records effect before audit (ordering inversion)",
    createFactory: createAuditAfterEffectToolHarnessFactory,
  },
  hang: {
    fixtureId: "tool.violation.hang",
    targetObligationId: TOOL_OBLIGATION_IDS.deadlineEnforcement,
    mustText: MUST_DEADLINE_ENFORCEMENT,
    summary: "hang probe ignores deadlineMs and never returns",
    createFactory: createHangingToolHarnessFactory,
  },
} as const satisfies Record<string, ToolViolationFixture>;

export function listToolViolationFixtures(): readonly ToolViolationFixture[] {
  return [
    TOOL_VIOLATION_FIXTURES.throwOnInvalid,
    TOOL_VIOLATION_FIXTURES.auditAfterEffect,
    TOOL_VIOLATION_FIXTURES.hang,
  ];
}
