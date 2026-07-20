/**
 * @module tool_policy
 *
 * ToolPolicy interface + risk-class routing table.
 *
 * Maps `ToolDescriptor.riskClass` to execution policy:
 *   - read / compute → auto-execute (`onReadExecute` notify only; never blocks)
 *   - write          → await host `onWriteApproval` (default deny without hook)
 *   - critical       → await host `onCriticalConfirm` (default deny without hook)
 *
 * Missing / unknown riskClass → treat as write (fail-safe) + advisory emit.
 * Denied approval → ToolResult status "denied" (never thrown).
 * Missing hook / approval timeout → typed ToolPolicyError (effect must not start).
 *
 * Wired into act-stage invoke via `invokeThroughToolPolicy`.
 * Denied approval maps to ToolResult status "error" for model consumption.
 * Per-class regression fixtures: tests/tool_policy_risk_class.test.mjs .
 * Write/critical recordInvocation before effect (CK-07.2).
 * Act-stage awaits acknowledgment; assertAuditBeforeEffect.
 * B0 CK-07.2 conformance vs composed path
 *   tests/write_ahead_conformance.test.mjs
 */

import type {
  ToolDescriptor,
  ToolInterface,
  ToolInvocation,
  ToolResult,
} from "@moolam/contracts";
import {
  recordThenInvoke,
  type AuditSink,
  type ToolAuditEvent,
} from "./tool_audit.js";

/** Verbatim risk-policy MUST for write-class tools (from ToolDescriptor docs). */
export const TOOL_POLICY_MUST_WRITE =
  '"write": mutates external state, requires policy approval';

/** Verbatim risk-policy MUST for critical-class tools (from ToolDescriptor docs). */
export const TOOL_POLICY_MUST_CRITICAL =
  '"critical": irreversible/regulated action, requires human approval';

/** Missing write/critical approval hook — hard-stop, never silent execute. */
export const TOOL_POLICY_OBLIGATION_HOOK_MISSING = "TOOL.POLICY_HOOK_MISSING";

/** Approval raced past deadlineMs — effect must not have started. */
export const TOOL_POLICY_OBLIGATION_APPROVAL_TIMEOUT =
  "TOOL.POLICY_APPROVAL_TIMEOUT";

/** Fail-safe when descriptor omits / falsifies riskClass. */
export const TOOL_POLICY_OBLIGATION_RISK_ASSUMED_WRITE =
  "TOOL.POLICY_RISK_ASSUMED_WRITE";

export type ToolRiskClass = ToolDescriptor["riskClass"];

export type ToolPolicyRouteMode = "auto" | "approval" | "confirm";

export type ToolPolicyRoute = {
  mode: ToolPolicyRouteMode;
  /** Which host hook applies for this class. */
  hook: "onReadExecute" | "onWriteApproval" | "onCriticalConfirm";
  /** True when affirmative host signal is required before effect. */
  requiresAffirmative: boolean;
};

/**
 * Canonical risk-class → execution routing table.
 * compute mirrors read (side-effect-free, auto-executable).
 */
export const RISK_CLASS_ROUTING: Readonly<
  Record<ToolRiskClass, ToolPolicyRoute>
> = {
  read: {
    mode: "auto",
    hook: "onReadExecute",
    requiresAffirmative: false,
  },
  compute: {
    mode: "auto",
    hook: "onReadExecute",
    requiresAffirmative: false,
  },
  write: {
    mode: "approval",
    hook: "onWriteApproval",
    requiresAffirmative: true,
  },
  critical: {
    mode: "confirm",
    hook: "onCriticalConfirm",
    requiresAffirmative: true,
  },
};

export type ToolPolicyContext = {
  subjectId: string;
  sessionId: string;
  /** Optional device token for operators — never learner content. */
  deviceId?: string;
  invocation: ToolInvocation;
  /** Resolved risk class after fail-safe normalization. */
  riskClass: ToolRiskClass;
  /** True when riskClass was assumed write due to missing/invalid descriptor. */
  assumedWrite: boolean;
  deadlineMs: number;
};

/**
 * Host-injectable policy hooks.
 * Write/critical hooks are required when those classes are invoked;
 * omitting them is a configuration defect (never silent execute).
 */
export type ToolPolicyHooks = {
  /**
   * Notify-only for read/compute — MAY be awaited for ordering, but MUST NOT
   * gate execution (read never blocks on approval).
   */
  onReadExecute?: (ctx: ToolPolicyContext) => void | Promise<void>;
  /** Write-class: resolve true to allow effect; false → status "denied". */
  onWriteApproval?: (ctx: ToolPolicyContext) => Promise<boolean>;
  /** Critical-class: resolve true to allow effect; false → status "denied". */
  onCriticalConfirm?: (ctx: ToolPolicyContext) => Promise<boolean>;
};

/** Deny-by-default hooks: no write/critical handlers registered. */
export const defaultDenyToolPolicyHooks: ToolPolicyHooks = Object.freeze({});

export type ToolPolicyEventOutcome =
  | "allowed"
  | "denied"
  | "assumed_write"
  | "error";

/** Structured policy telemetry — never raw arguments / learner content. */
export type ToolPolicyEvent = {
  event: "cognitive_core.tool_policy";
  subjectId: string;
  sessionId: string;
  deviceId?: string;
  outcome: ToolPolicyEventOutcome;
  riskClass: ToolRiskClass;
  toolName: string;
  assumedWrite: boolean;
  failureClass?: "validation" | "contract" | "config" | "downstream" | "cap";
  errorCode?: string;
};

export class ToolPolicyError extends Error {
  readonly obligationId: string | null;
  readonly failureClass: "validation" | "contract" | "config" | "downstream" | "cap";
  readonly errorCode: string | null;

  constructor(
    message: string,
    opts: {
      obligationId?: string | null;
      failureClass?: "validation" | "contract" | "config" | "downstream" | "cap";
      errorCode?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "ToolPolicyError";
    this.obligationId = opts.obligationId ?? null;
    this.failureClass = opts.failureClass ?? "config";
    this.errorCode = opts.errorCode ?? null;
  }
}

export type ToolPolicyAuthorization =
  | {
      outcome: "allow";
      riskClass: ToolRiskClass;
      assumedWrite: boolean;
      route: ToolPolicyRoute;
    }
  | {
      outcome: "deny";
      riskClass: ToolRiskClass;
      assumedWrite: boolean;
      route: ToolPolicyRoute;
      /** Model-facing denial — status "denied", never a thrown exception. */
      result: ToolResult;
    };

export type AuthorizeToolInput = {
  subjectId: string;
  sessionId: string;
  deviceId?: string;
  invocation: ToolInvocation;
  /**
   * Descriptor from tools.list(), or a partial. Missing/invalid riskClass
   * fails safe to write.
   */
  descriptor: Pick<ToolDescriptor, "name" | "riskClass"> | null | undefined;
  hooks: ToolPolicyHooks;
  deadlineMs: number;
  emit?: (event: ToolPolicyEvent) => void;
};

const VALID_RISK = new Set<ToolRiskClass>([
  "read",
  "compute",
  "write",
  "critical",
]);

/**
 * Resolve risk class with fail-safe: unknown / missing → write.
 */
export function resolveRiskClass(
  descriptor: Pick<ToolDescriptor, "riskClass"> | null | undefined,
): { riskClass: ToolRiskClass; assumedWrite: boolean } {
  const raw = descriptor?.riskClass;
  if (typeof raw === "string" && VALID_RISK.has(raw as ToolRiskClass)) {
    return { riskClass: raw as ToolRiskClass, assumedWrite: false };
  }
  return { riskClass: "write", assumedWrite: true };
}

export function routeForRiskClass(riskClass: ToolRiskClass): ToolPolicyRoute {
  return RISK_CLASS_ROUTING[riskClass];
}

function denyResult(
  invocation: ToolInvocation,
  reason: string,
  startedAt: number,
): ToolResult {
  return {
    invocationId: invocation.invocationId,
    status: "denied",
    output: {
      code: "POLICY_DENIED",
      reason: reason.slice(0, 128),
    },
    latencyMs: Math.max(0, Date.now() - startedAt),
  };
}

function raceDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const budget = Math.max(1, Math.min(deadlineMs, 60_000));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ ok: false });
    }, budget);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Authorize a tool invocation against the risk-class routing table.
 * Does not invoke the tool — caller (act stage / ) executes
 * only after `outcome: "allow"`.
 */
export async function authorizeToolInvocation(
  input: AuthorizeToolInput,
): Promise<ToolPolicyAuthorization> {
  const subjectId = input.subjectId.trim();
  const sessionId = input.sessionId.trim();
  if (!subjectId) {
    throw new ToolPolicyError("tool policy requires subjectId (subject isolation)", {
      failureClass: "validation",
      errorCode: "SUBJECT_REQUIRED",
    });
  }
  if (!sessionId) {
    throw new ToolPolicyError("tool policy requires sessionId", {
      failureClass: "validation",
      errorCode: "SESSION_REQUIRED",
    });
  }

  const startedAt = Date.now();
  const { riskClass, assumedWrite } = resolveRiskClass(input.descriptor);
  const route = routeForRiskClass(riskClass);
  const toolName = (
    input.descriptor?.name ??
    input.invocation.toolName ??
    "unknown"
  )
    .trim()
    .slice(0, 64);

  const ctx: ToolPolicyContext = {
    subjectId,
    sessionId,
    ...(input.deviceId !== undefined
      ? { deviceId: input.deviceId.trim().slice(0, 64) }
      : {}),
    invocation: input.invocation,
    riskClass,
    assumedWrite,
    deadlineMs: input.deadlineMs,
  };

  const baseEvent = {
    event: "cognitive_core.tool_policy" as const,
    subjectId,
    sessionId,
    ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : {}),
    riskClass,
    toolName,
    assumedWrite,
  };

  try {
    if (assumedWrite) {
      input.emit?.({
        ...baseEvent,
        outcome: "assumed_write",
        failureClass: "validation",
        errorCode: TOOL_POLICY_OBLIGATION_RISK_ASSUMED_WRITE,
      });
    }

    if (route.mode === "auto") {
      // Read/compute: notify only — never gate on approval hooks.
      if (input.hooks.onReadExecute) {
        await input.hooks.onReadExecute(ctx);
      }
      input.emit?.({ ...baseEvent, outcome: "allowed" });
      return { outcome: "allow", riskClass, assumedWrite, route };
    }

    if (route.hook === "onWriteApproval") {
      const hook = input.hooks.onWriteApproval;
      if (!hook) {
        throw new ToolPolicyError(
          `write-class tool "${toolName}" requires onWriteApproval (${TOOL_POLICY_MUST_WRITE})`,
          {
            obligationId: TOOL_POLICY_OBLIGATION_HOOK_MISSING,
            failureClass: "config",
            errorCode: "WRITE_HOOK_MISSING",
          },
        );
      }
      const raced = await raceDeadline(hook(ctx), input.deadlineMs);
      if (!raced.ok) {
        throw new ToolPolicyError(
          `write approval timed out for "${toolName}"`,
          {
            obligationId: TOOL_POLICY_OBLIGATION_APPROVAL_TIMEOUT,
            failureClass: "cap",
            errorCode: "WRITE_APPROVAL_TIMEOUT",
          },
        );
      }
      if (raced.value !== true) {
        const result = denyResult(
          input.invocation,
          "write approval denied",
          startedAt,
        );
        input.emit?.({ ...baseEvent, outcome: "denied" });
        return { outcome: "deny", riskClass, assumedWrite, route, result };
      }
      input.emit?.({ ...baseEvent, outcome: "allowed" });
      return { outcome: "allow", riskClass, assumedWrite, route };
    }

    // critical
    const confirm = input.hooks.onCriticalConfirm;
    if (!confirm) {
      throw new ToolPolicyError(
        `critical-class tool "${toolName}" requires onCriticalConfirm (${TOOL_POLICY_MUST_CRITICAL})`,
        {
          obligationId: TOOL_POLICY_OBLIGATION_HOOK_MISSING,
          failureClass: "config",
          errorCode: "CRITICAL_HOOK_MISSING",
        },
      );
    }
    const raced = await raceDeadline(confirm(ctx), input.deadlineMs);
    if (!raced.ok) {
      throw new ToolPolicyError(
        `critical confirmation timed out for "${toolName}"`,
        {
          obligationId: TOOL_POLICY_OBLIGATION_APPROVAL_TIMEOUT,
          failureClass: "cap",
          errorCode: "CRITICAL_CONFIRM_TIMEOUT",
        },
      );
    }
    if (raced.value !== true) {
      const result = denyResult(
        input.invocation,
        "critical confirmation denied",
        startedAt,
      );
      input.emit?.({ ...baseEvent, outcome: "denied" });
      return { outcome: "deny", riskClass, assumedWrite, route, result };
    }
    input.emit?.({ ...baseEvent, outcome: "allowed" });
    return { outcome: "allow", riskClass, assumedWrite, route };
  } catch (err) {
    if (err instanceof ToolPolicyError) {
      input.emit?.({
        ...baseEvent,
        outcome: "error",
        failureClass: err.failureClass,
        ...(err.errorCode ? { errorCode: err.errorCode } : {}),
      });
      throw err;
    }
    input.emit?.({
      ...baseEvent,
      outcome: "error",
      failureClass: "downstream",
    });
    throw err;
  }
}

/**
 * ToolPolicy surface — injectable host policy for wiring.
 */
export type ToolPolicy = {
  hooks: ToolPolicyHooks;
  authorize: (
    input: Omit<AuthorizeToolInput, "hooks">,
  ) => Promise<ToolPolicyAuthorization>;
};

export function createToolPolicy(hooks: ToolPolicyHooks = defaultDenyToolPolicyHooks): ToolPolicy {
  return {
    hooks,
    authorize: (input) => authorizeToolInvocation({ ...input, hooks }),
  };
}

/** Bound tools.list() scan when resolving descriptors (NFR). */
export const TOOL_POLICY_LIST_SCAN_LIMIT = 64;

/**
 * Inner invoke after policy allow — mirrors act-stage ToolInvokeHook without
 * importing tool_stage (avoids cycles).
 */
export type PolicyInnerInvoke = (
  invocation: ToolInvocation,
  deadlineMs: number,
  tools: ToolInterface,
) => Promise<ToolResult>;

export const defaultPolicyInnerInvoke: PolicyInnerInvoke = (
  invocation,
  deadlineMs,
  tools,
) => tools.invoke(invocation, deadlineMs);

/**
 * Lookup descriptor by name; missing → null (authorize fail-safes to write).
 */
export function lookupToolDescriptor(
  tools: ToolInterface,
  toolName: string,
): ToolDescriptor | null {
  const name = toolName.trim();
  if (!name) return null;
  const list = tools.list();
  const limit = Math.min(
    Array.isArray(list) ? list.length : 0,
    TOOL_POLICY_LIST_SCAN_LIMIT,
  );
  for (let i = 0; i < limit; i++) {
    const d = list[i];
    if (d && d.name === name) return d;
  }
  return null;
}

/**
 * Map policy denial to a model-facing tool error (status "error", not throw).
 * Denials must surface in the transcript for re-generation.
 */
export function policyDenialAsModelToolError(denied: ToolResult): ToolResult {
  const prior =
    denied.output &&
    typeof denied.output === "object" &&
    denied.output !== null &&
    !Array.isArray(denied.output)
      ? (denied.output as Record<string, unknown>)
      : {};
  return {
    invocationId: denied.invocationId,
    status: "error",
    output: {
      code:
        typeof prior.code === "string" ? prior.code.slice(0, 64) : "POLICY_DENIED",
      reason:
        typeof prior.reason === "string"
          ? prior.reason.slice(0, 128)
          : "policy denied",
    },
    latencyMs: denied.latencyMs,
  };
}

export type InvokeThroughToolPolicyInput = {
  subjectId: string;
  sessionId: string;
  deviceId?: string;
  invocation: ToolInvocation;
  tools: ToolInterface;
  hooks: ToolPolicyHooks;
  deadlineMs: number;
  emit?: (event: ToolPolicyEvent | ToolAuditEvent) => void;
  /** Post-allow effect path; default tools.invoke. */
  invokeHook?: PolicyInnerInvoke;
  /**
   * Write-ahead audit sink . Required for write/critical
   * after policy allow; read/compute skip.
   */
  auditSink?: AuditSink | null;
};

/**
 * Authorize then invoke. Deny → status "error" ToolResult (no throw).
 * Missing hook / approval timeout → ToolPolicyError (effect never started).
 * Write/critical: recordInvocation before await invoke (CK-07.2).
 */
export async function invokeThroughToolPolicy(
  input: InvokeThroughToolPolicyInput,
): Promise<ToolResult> {
  const descriptor = lookupToolDescriptor(
    input.tools,
    input.invocation.toolName,
  );
  const auth = await authorizeToolInvocation({
    subjectId: input.subjectId,
    sessionId: input.sessionId,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    invocation: input.invocation,
    descriptor,
    hooks: input.hooks,
    deadlineMs: input.deadlineMs,
    ...(input.emit
      ? {
          emit: (e: ToolPolicyEvent) => {
            input.emit?.(e);
          },
        }
      : {}),
  });

  if (auth.outcome === "deny") {
    return policyDenialAsModelToolError(auth.result);
  }

  const inner = input.invokeHook ?? defaultPolicyInnerInvoke;
  return recordThenInvoke({
    subjectId: input.subjectId,
    sessionId: input.sessionId,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    invocation: input.invocation,
    riskClass: auth.riskClass,
    deadlineMs: input.deadlineMs,
    auditSink: input.auditSink,
    ...(input.emit
      ? {
          emit: (e: ToolAuditEvent) => {
            input.emit?.(e);
          },
        }
      : {}),
    invoke: () => inner(input.invocation, input.deadlineMs, input.tools),
  });
}
