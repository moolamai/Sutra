/**
 * Remediation policy schema over typed control surfaces (C6).
 *
 * Allowed actions only: adjust retry budget, set correction-loop cap within
 * bounds, switch degradation mode, set routing fallback. Explicit enums —
 * never freeform surfaces, permissions widen, or approval-gate skips.
 *
 * This slice defines and validates the schema; execution belongs to a later
 * auto-remediation executor slice.
 *
 * Bounds align with harness MAX_CORRECTION_TURNS (1..64, default 8) and
 * degradation host behaviors / wire dependencies — duplicated as closed
 * enums here so the schema stays free of runtime adapter imports.
 */

/** Aligns with packages/runtime-harness MAX_CORRECTION_TURNS. */
export const REMEDIATION_CORRECTION_CAP_DEFAULT = 8 as const;

/** Host degradation behaviors (same closed set as degradation_registry). */
export const REMEDIATION_DEGRADATION_BEHAVIORS = Object.freeze([
  "stale_with_marker",
  "queue",
  "hard_stop",
] as const);

export type RemediationDegradationBehavior =
  (typeof REMEDIATION_DEGRADATION_BEHAVIORS)[number];

/** Wire dependencies remediations may retarget. */
export const REMEDIATION_DEGRADATION_DEPENDENCIES = Object.freeze([
  "model",
  "sync",
  "tool",
] as const);

export type RemediationDegradationDependency =
  (typeof REMEDIATION_DEGRADATION_DEPENDENCIES)[number];

export const REMEDIATION_POLICY_SCHEMA_VERSION =
  "runtime.harness.remediation-policy.v1" as const;

export const REMEDIATION_POLICY_FLAG =
  "runtime.harness.self_healing.remediation_policy" as const;

/** Explicit action kinds — closed enum, no freeform action strings. */
export const REMEDIATION_ACTION_KINDS = Object.freeze([
  "adjust_retry_budget",
  "set_correction_loop_cap",
  "switch_degradation_mode",
  "set_routing_fallback",
] as const);

export type RemediationActionKind = (typeof REMEDIATION_ACTION_KINDS)[number];

/** Surfaces that may be targeted — aligned with failure-mining hints. */
export const REMEDIATION_CONTROL_SURFACES = Object.freeze([
  "degradation_registry",
  "correction_loop",
  "routing_budget",
  "retry_cap",
] as const);

export type RemediationControlSurface =
  (typeof REMEDIATION_CONTROL_SURFACES)[number];

export const FORBIDDEN_REMEDIATION_SURFACES = Object.freeze([
  "permissions",
  "approval_gate",
  "tool_permission",
  "skip_approval",
] as const);

export type ForbiddenRemediationSurface =
  (typeof FORBIDDEN_REMEDIATION_SURFACES)[number];

/** Failure classes remediations may bind to (metadata codes only). */
export const REMEDIATION_FAILURE_CLASSES = Object.freeze([
  "correction_exhaustion",
  "degradation",
  "refusal_misfire",
  "tool_timeout",
] as const);

export type RemediationFailureClass =
  (typeof REMEDIATION_FAILURE_CLASSES)[number];

/** Routing fallback targets — observation-only shadow is not an action. */
export const REMEDIATION_ROUTING_FALLBACKS = Object.freeze([
  "champion",
  "challenger",
] as const);

export type RemediationRoutingFallback =
  (typeof REMEDIATION_ROUTING_FALLBACKS)[number];

/** Aligns with trajectory write retry budget precedent (0..10). */
export const REMEDIATION_RETRY_BUDGET_MIN = 0 as const;
export const REMEDIATION_RETRY_BUDGET_MAX = 10 as const;

/** Aligns with resolveMaxCorrectionTurns (1..64); default MAX_CORRECTION_TURNS. */
export const REMEDIATION_CORRECTION_CAP_MIN = 1 as const;
export const REMEDIATION_CORRECTION_CAP_MAX = 64 as const;

/** Ineffective remediation attempts before self-disable + page. */
export const REMEDIATION_INEFFECTIVE_ATTEMPT_LIMIT = 3 as const;

/** Soft cap on retained policy rows per subject (NFR — no unbounded scan). */
export const REMEDIATION_POLICY_ROW_LIMIT = 128 as const;

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export type RemediationPolicyFailureClass =
  | "remediation_policy.invalid_input"
  | "remediation_policy.forbidden_surface"
  | "remediation_policy.forbidden_action"
  | "remediation_policy.out_of_bounds"
  | "remediation_policy.subject_scope"
  | "remediation_policy.cross_subject_denied"
  | "remediation_policy.triage_suppressed"
  | "remediation_policy.below_confidence"
  | "remediation_policy.disabled_ineffective"
  | "remediation_policy.idempotent_conflict"
  | "remediation_policy.capacity"
  | "remediation_policy.locality_forbidden"
  | "remediation_policy.raw_content_forbidden";

export class RemediationPolicyContractError extends Error {
  readonly obligation: RemediationPolicyFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: RemediationPolicyFailureClass;
      subjectId?: string;
      deviceId?: string;
    },
  ) {
    super(message);
    this.name = "RemediationPolicyContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
  }
}

export type AdjustRetryBudgetAction = {
  kind: "adjust_retry_budget";
  surface: "retry_cap";
  maxRetries: number;
};

export type SetCorrectionLoopCapAction = {
  kind: "set_correction_loop_cap";
  surface: "correction_loop";
  maxCorrectionTurns: number;
};

export type SwitchDegradationModeAction = {
  kind: "switch_degradation_mode";
  surface: "degradation_registry";
  dependency: RemediationDegradationDependency;
  behavior: RemediationDegradationBehavior;
};

export type SetRoutingFallbackAction = {
  kind: "set_routing_fallback";
  surface: "routing_budget";
  fallback: RemediationRoutingFallback;
};

export type RemediationAction =
  | AdjustRetryBudgetAction
  | SetCorrectionLoopCapAction
  | SwitchDegradationModeAction
  | SetRoutingFallbackAction;

export type RemediationLocality = "on-device" | "self-hosted";

/**
 * Versioned remediation policy document.
 * Policy changes append as new versions — never mutate in place.
 */
export type RemediationPolicyDocument = {
  schemaVersion: typeof REMEDIATION_POLICY_SCHEMA_VERSION;
  policyId: string;
  version: number;
  subjectId: string;
  deviceId: string;
  locality: RemediationLocality;
  failureClass: RemediationFailureClass;
  confidence: number;
  action: RemediationAction;
  disabled: boolean;
  ineffectiveAttempts: number;
  pageRequested: boolean;
  /** When true, auto-remediation is suppressed until triage closes. */
  triageActive: boolean;
  idempotencyKey: string;
};

export type RemediationPolicyTelemetryEvent = {
  event: "runtime.harness.remediation_policy";
  outcome: "ok" | "fail" | "advisory" | "suppressed";
  subjectId: string;
  deviceId: string;
  policyId?: string;
  version?: number;
  failureClass?: RemediationFailureClass;
  actionKind?: RemediationActionKind;
  surface?: RemediationControlSurface | ForbiddenRemediationSurface | string;
  confidence?: number;
  disabled?: boolean;
  pageRequested?: boolean;
  triageActive?: boolean;
  obligation?: RemediationPolicyFailureClass;
};

function emit(
  onTelemetry: ((event: RemediationPolicyTelemetryEvent) => void) | undefined,
  event: RemediationPolicyTelemetryEvent,
): void {
  onTelemetry?.(event);
}

function assertId(
  value: unknown,
  label: string,
  meta: { subjectId?: string; deviceId?: string },
): asserts value is string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new RemediationPolicyContractError(
      `${label} must be a stable id (1..128)`,
      {
        obligation: "remediation_policy.invalid_input",
        ...(meta.subjectId !== undefined ? { subjectId: meta.subjectId } : {}),
        ...(meta.deviceId !== undefined ? { deviceId: meta.deviceId } : {}),
      },
    );
  }
}

function rejectRawContent(
  raw: Record<string, unknown>,
  meta: { subjectId?: string; deviceId?: string },
): void {
  for (const key of Object.keys(raw)) {
    if (
      /utterance|content|body|prompt|secret|raw/i.test(key) &&
      key !== "raw_content_forbidden"
    ) {
      throw new RemediationPolicyContractError(
        `raw content key ${key} is forbidden on remediation policies`,
        {
          obligation: "remediation_policy.raw_content_forbidden",
          ...(meta.subjectId !== undefined ? { subjectId: meta.subjectId } : {}),
          ...(meta.deviceId !== undefined ? { deviceId: meta.deviceId } : {}),
        },
      );
    }
  }
}

/**
 * Validate a remediation action against the closed enum and surface bounds.
 */
export function parseRemediationAction(
  raw: unknown,
  meta?: { subjectId?: string; deviceId?: string },
): RemediationAction {
  const subjectId = meta?.subjectId;
  const deviceId = meta?.deviceId;
  const fail = (
    message: string,
    obligation: RemediationPolicyFailureClass = "remediation_policy.invalid_input",
  ): never => {
    throw new RemediationPolicyContractError(message, {
      obligation,
      ...(subjectId !== undefined ? { subjectId } : {}),
      ...(deviceId !== undefined ? { deviceId } : {}),
    });
  };

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("remediation action must be an object");
  }
  const obj = raw as Record<string, unknown>;
  rejectRawContent(obj, {
    ...(subjectId !== undefined ? { subjectId } : {}),
    ...(deviceId !== undefined ? { deviceId } : {}),
  });

  const kind = obj.kind;
  if (
    typeof kind !== "string" ||
    !(REMEDIATION_ACTION_KINDS as readonly string[]).includes(kind)
  ) {
    return fail("remediation action kind is unknown or freeform");
  }

  const surface = obj.surface;
  if (typeof surface === "string") {
    if (
      (FORBIDDEN_REMEDIATION_SURFACES as readonly string[]).includes(surface)
    ) {
      return fail(
        `remediation surface ${surface} is forbidden`,
        "remediation_policy.forbidden_surface",
      );
    }
  }

  switch (kind as RemediationActionKind) {
    case "adjust_retry_budget": {
      if (surface !== "retry_cap") {
        return fail(
          "adjust_retry_budget must target retry_cap",
          "remediation_policy.forbidden_surface",
        );
      }
      const maxRetries = obj.maxRetries;
      if (
        typeof maxRetries !== "number" ||
        !Number.isInteger(maxRetries) ||
        maxRetries < REMEDIATION_RETRY_BUDGET_MIN ||
        maxRetries > REMEDIATION_RETRY_BUDGET_MAX
      ) {
        return fail(
          `maxRetries must be an integer in ${REMEDIATION_RETRY_BUDGET_MIN}..${REMEDIATION_RETRY_BUDGET_MAX}`,
          "remediation_policy.out_of_bounds",
        );
      }
      return { kind: "adjust_retry_budget", surface: "retry_cap", maxRetries };
    }
    case "set_correction_loop_cap": {
      if (surface !== "correction_loop") {
        return fail(
          "set_correction_loop_cap must target correction_loop",
          "remediation_policy.forbidden_surface",
        );
      }
      const maxCorrectionTurns = obj.maxCorrectionTurns;
      if (
        typeof maxCorrectionTurns !== "number" ||
        !Number.isInteger(maxCorrectionTurns) ||
        maxCorrectionTurns < REMEDIATION_CORRECTION_CAP_MIN ||
        maxCorrectionTurns > REMEDIATION_CORRECTION_CAP_MAX
      ) {
        return fail(
          `maxCorrectionTurns must be an integer in ${REMEDIATION_CORRECTION_CAP_MIN}..${REMEDIATION_CORRECTION_CAP_MAX}`,
          "remediation_policy.out_of_bounds",
        );
      }
      return {
        kind: "set_correction_loop_cap",
        surface: "correction_loop",
        maxCorrectionTurns,
      };
    }
    case "switch_degradation_mode": {
      if (surface !== "degradation_registry") {
        return fail(
          "switch_degradation_mode must target degradation_registry",
          "remediation_policy.forbidden_surface",
        );
      }
      const dependency = obj.dependency;
      const behavior = obj.behavior;
      if (
        typeof dependency !== "string" ||
        !(REMEDIATION_DEGRADATION_DEPENDENCIES as readonly string[]).includes(
          dependency,
        )
      ) {
        return fail("degradation dependency must be model|sync|tool");
      }
      if (
        typeof behavior !== "string" ||
        !(REMEDIATION_DEGRADATION_BEHAVIORS as readonly string[]).includes(
          behavior,
        )
      ) {
        return fail(
          "degradation behavior must be stale_with_marker|queue|hard_stop",
        );
      }
      return {
        kind: "switch_degradation_mode",
        surface: "degradation_registry",
        dependency: dependency as RemediationDegradationDependency,
        behavior: behavior as RemediationDegradationBehavior,
      };
    }
    case "set_routing_fallback": {
      if (surface !== "routing_budget") {
        return fail(
          "set_routing_fallback must target routing_budget",
          "remediation_policy.forbidden_surface",
        );
      }
      const fallback = obj.fallback;
      if (
        typeof fallback !== "string" ||
        !(REMEDIATION_ROUTING_FALLBACKS as readonly string[]).includes(fallback)
      ) {
        return fail(
          "routing fallback must be champion|challenger (shadow is not an action)",
          "remediation_policy.forbidden_action",
        );
      }
      return {
        kind: "set_routing_fallback",
        surface: "routing_budget",
        fallback: fallback as RemediationRoutingFallback,
      };
    }
  }
}

/**
 * Parse and validate a full remediation policy document.
 */
export function parseRemediationPolicy(
  raw: unknown,
  options?: {
    expectedSubjectId?: string;
    onTelemetry?: (event: RemediationPolicyTelemetryEvent) => void;
  },
): RemediationPolicyDocument {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RemediationPolicyContractError(
      "remediation policy must be an object",
      { obligation: "remediation_policy.invalid_input" },
    );
  }
  const obj = raw as Record<string, unknown>;
  const subjectId =
    typeof obj.subjectId === "string" ? obj.subjectId : undefined;
  const deviceId = typeof obj.deviceId === "string" ? obj.deviceId : undefined;

  try {
    rejectRawContent(obj, {
      ...(subjectId !== undefined ? { subjectId } : {}),
      ...(deviceId !== undefined ? { deviceId } : {}),
    });

    if (obj.schemaVersion !== REMEDIATION_POLICY_SCHEMA_VERSION) {
      throw new RemediationPolicyContractError(
        "unsupported remediation policy schemaVersion",
        {
          obligation: "remediation_policy.invalid_input",
          ...(subjectId !== undefined ? { subjectId } : {}),
          ...(deviceId !== undefined ? { deviceId } : {}),
        },
      );
    }

    assertId(obj.policyId, "policyId", {
      ...(subjectId !== undefined ? { subjectId } : {}),
      ...(deviceId !== undefined ? { deviceId } : {}),
    });
    assertId(obj.subjectId, "subjectId", {
      ...(deviceId !== undefined ? { deviceId } : {}),
    });
    assertId(obj.deviceId, "deviceId", {
      subjectId: obj.subjectId,
    });
    assertId(obj.idempotencyKey, "idempotencyKey", {
      subjectId: obj.subjectId,
      deviceId: obj.deviceId,
    });

    if (
      options?.expectedSubjectId !== undefined &&
      obj.subjectId !== options.expectedSubjectId
    ) {
      throw new RemediationPolicyContractError(
        "remediation policy subjectId mismatch",
        {
          obligation: "remediation_policy.cross_subject_denied",
          subjectId: options.expectedSubjectId,
          deviceId: obj.deviceId,
        },
      );
    }

    if (obj.locality !== "on-device" && obj.locality !== "self-hosted") {
      throw new RemediationPolicyContractError(
        "locality must be on-device or self-hosted",
        {
          obligation: "remediation_policy.locality_forbidden",
          subjectId: obj.subjectId,
          deviceId: obj.deviceId,
        },
      );
    }

    if (
      typeof obj.failureClass !== "string" ||
      !(REMEDIATION_FAILURE_CLASSES as readonly string[]).includes(
        obj.failureClass,
      )
    ) {
      throw new RemediationPolicyContractError("unknown failureClass", {
        obligation: "remediation_policy.invalid_input",
        subjectId: obj.subjectId,
        deviceId: obj.deviceId,
      });
    }

    if (
      typeof obj.version !== "number" ||
      !Number.isInteger(obj.version) ||
      obj.version < 1 ||
      obj.version > 1_000_000
    ) {
      throw new RemediationPolicyContractError(
        "version must be a positive integer",
        {
          obligation: "remediation_policy.invalid_input",
          subjectId: obj.subjectId,
          deviceId: obj.deviceId,
        },
      );
    }

    if (
      typeof obj.confidence !== "number" ||
      !Number.isFinite(obj.confidence) ||
      obj.confidence < 0 ||
      obj.confidence > 1
    ) {
      throw new RemediationPolicyContractError(
        "confidence must be a finite number in [0,1]",
        {
          obligation: "remediation_policy.invalid_input",
          subjectId: obj.subjectId,
          deviceId: obj.deviceId,
        },
      );
    }

    if (typeof obj.disabled !== "boolean") {
      throw new RemediationPolicyContractError("disabled must be boolean", {
        obligation: "remediation_policy.invalid_input",
        subjectId: obj.subjectId,
        deviceId: obj.deviceId,
      });
    }
    if (
      typeof obj.ineffectiveAttempts !== "number" ||
      !Number.isInteger(obj.ineffectiveAttempts) ||
      obj.ineffectiveAttempts < 0 ||
      obj.ineffectiveAttempts > 64
    ) {
      throw new RemediationPolicyContractError(
        "ineffectiveAttempts must be an integer in 0..64",
        {
          obligation: "remediation_policy.invalid_input",
          subjectId: obj.subjectId,
          deviceId: obj.deviceId,
        },
      );
    }
    if (typeof obj.pageRequested !== "boolean") {
      throw new RemediationPolicyContractError(
        "pageRequested must be boolean",
        {
          obligation: "remediation_policy.invalid_input",
          subjectId: obj.subjectId,
          deviceId: obj.deviceId,
        },
      );
    }
    if (typeof obj.triageActive !== "boolean") {
      throw new RemediationPolicyContractError("triageActive must be boolean", {
        obligation: "remediation_policy.invalid_input",
        subjectId: obj.subjectId,
        deviceId: obj.deviceId,
      });
    }

    const action = parseRemediationAction(obj.action, {
      subjectId: obj.subjectId,
      deviceId: obj.deviceId,
    });

    const doc: RemediationPolicyDocument = {
      schemaVersion: REMEDIATION_POLICY_SCHEMA_VERSION,
      policyId: obj.policyId,
      version: obj.version,
      subjectId: obj.subjectId,
      deviceId: obj.deviceId,
      locality: obj.locality,
      failureClass: obj.failureClass as RemediationFailureClass,
      confidence: obj.confidence,
      action,
      disabled: obj.disabled,
      ineffectiveAttempts: obj.ineffectiveAttempts,
      pageRequested: obj.pageRequested,
      triageActive: obj.triageActive,
      idempotencyKey: obj.idempotencyKey,
    };

    emit(options?.onTelemetry, {
      event: "runtime.harness.remediation_policy",
      outcome: "ok",
      subjectId: doc.subjectId,
      deviceId: doc.deviceId,
      policyId: doc.policyId,
      version: doc.version,
      failureClass: doc.failureClass,
      actionKind: doc.action.kind,
      surface: doc.action.surface,
      confidence: doc.confidence,
      disabled: doc.disabled,
      pageRequested: doc.pageRequested,
      triageActive: doc.triageActive,
    });

    return doc;
  } catch (error) {
    if (error instanceof RemediationPolicyContractError) {
      emit(options?.onTelemetry, {
        event: "runtime.harness.remediation_policy",
        outcome: "fail",
        subjectId: error.subjectId ?? subjectId ?? "unknown",
        deviceId: error.deviceId ?? deviceId ?? "unknown",
        obligation: error.obligation,
      });
    }
    throw error;
  }
}

/**
 * When multiple policies match one failure class, pick highest version then
 * confidence — never double-apply.
 */
export function selectRemediationPolicy(input: {
  subjectId: string;
  failureClass: RemediationFailureClass;
  policies: readonly RemediationPolicyDocument[];
  confidenceThreshold?: number;
  deviceId?: string;
  onTelemetry?: (event: RemediationPolicyTelemetryEvent) => void;
}):
  | { ok: true; policy: RemediationPolicyDocument }
  | {
      ok: false;
      reason:
        | "missing_policy"
        | "triage_suppressed"
        | "below_confidence"
        | "disabled_ineffective"
        | "cross_subject_denied";
      policy?: RemediationPolicyDocument;
    } {
  const deviceId = input.deviceId ?? "unknown";
  const threshold = input.confidenceThreshold ?? 0.8;
  const scoped: RemediationPolicyDocument[] = [];
  for (const policy of input.policies) {
    if (policy.subjectId !== input.subjectId) {
      emit(input.onTelemetry, {
        event: "runtime.harness.remediation_policy",
        outcome: "fail",
        subjectId: input.subjectId,
        deviceId,
        policyId: policy.policyId,
        obligation: "remediation_policy.cross_subject_denied",
      });
      return { ok: false, reason: "cross_subject_denied", policy };
    }
    if (policy.failureClass === input.failureClass) {
      scoped.push(policy);
    }
  }

  if (scoped.length === 0) {
    emit(input.onTelemetry, {
      event: "runtime.harness.remediation_policy",
      outcome: "advisory",
      subjectId: input.subjectId,
      deviceId,
      failureClass: input.failureClass,
    });
    return { ok: false, reason: "missing_policy" };
  }

  scoped.sort((a, b) => {
    if (b.version !== a.version) return b.version - a.version;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.policyId < b.policyId ? -1 : a.policyId > b.policyId ? 1 : 0;
  });
  const winner = scoped[0]!;

  if (winner.triageActive) {
    emit(input.onTelemetry, {
      event: "runtime.harness.remediation_policy",
      outcome: "suppressed",
      subjectId: input.subjectId,
      deviceId,
      policyId: winner.policyId,
      version: winner.version,
      failureClass: winner.failureClass,
      triageActive: true,
      obligation: "remediation_policy.triage_suppressed",
    });
    return { ok: false, reason: "triage_suppressed", policy: winner };
  }
  if (winner.disabled || winner.pageRequested) {
    emit(input.onTelemetry, {
      event: "runtime.harness.remediation_policy",
      outcome: "advisory",
      subjectId: input.subjectId,
      deviceId,
      policyId: winner.policyId,
      version: winner.version,
      disabled: true,
      pageRequested: winner.pageRequested,
      obligation: "remediation_policy.disabled_ineffective",
    });
    return { ok: false, reason: "disabled_ineffective", policy: winner };
  }
  if (winner.confidence + 1e-12 < threshold) {
    emit(input.onTelemetry, {
      event: "runtime.harness.remediation_policy",
      outcome: "advisory",
      subjectId: input.subjectId,
      deviceId,
      policyId: winner.policyId,
      confidence: winner.confidence,
      obligation: "remediation_policy.below_confidence",
    });
    return { ok: false, reason: "below_confidence", policy: winner };
  }

  emit(input.onTelemetry, {
    event: "runtime.harness.remediation_policy",
    outcome: "ok",
    subjectId: input.subjectId,
    deviceId,
    policyId: winner.policyId,
    version: winner.version,
    failureClass: winner.failureClass,
    actionKind: winner.action.kind,
    surface: winner.action.surface,
    confidence: winner.confidence,
  });
  return { ok: true, policy: winner };
}

/**
 * Pure transition: record an ineffective remediation attempt.
 * At the attempt limit, disables the policy and requests a page.
 * Returns a new version row (append-only).
 */
export function nextIneffectiveAttemptPolicy(
  policy: RemediationPolicyDocument,
  options?: { limit?: number },
): RemediationPolicyDocument {
  const limit = options?.limit ?? REMEDIATION_INEFFECTIVE_ATTEMPT_LIMIT;
  const attempts = policy.ineffectiveAttempts + 1;
  const disabled = attempts >= limit;
  return {
    ...policy,
    version: policy.version + 1,
    ineffectiveAttempts: attempts,
    disabled,
    pageRequested: disabled ? true : policy.pageRequested,
    idempotencyKey: `${policy.idempotencyKey}.ineffective.${attempts}`,
  };
}

export function isRemediationAction(value: unknown): value is RemediationAction {
  try {
    parseRemediationAction(value);
    return true;
  } catch {
    return false;
  }
}

export type RemediationPolicyCatalog = {
  readonly subjectId: string;
  readonly deviceId: string;
  appendPolicy(
    input: Omit<RemediationPolicyDocument, "schemaVersion" | "version"> & {
      schemaVersion?: typeof REMEDIATION_POLICY_SCHEMA_VERSION;
      version?: number;
    },
  ): RemediationPolicyDocument;
  listPolicies(): RemediationPolicyDocument[];
  resolveForFailureClass(
    failureClass: RemediationFailureClass,
    options?: { confidenceThreshold?: number },
  ): ReturnType<typeof selectRemediationPolicy>;
  setTriageActive(
    failureClass: RemediationFailureClass,
    active: boolean,
  ): RemediationPolicyDocument | undefined;
  recordIneffectiveAttempt(
    policyId: string,
  ): RemediationPolicyDocument | undefined;
};

/**
 * Subject-scoped append-only remediation policy catalog.
 * Cross-subject appends are refused; versions are monotonic per subject.
 */
export function createRemediationPolicyCatalog(options: {
  subjectId: string;
  deviceId: string;
  locality?: RemediationLocality;
  onTelemetry?: (event: RemediationPolicyTelemetryEvent) => void;
}): RemediationPolicyCatalog {
  const subjectId = options.subjectId;
  const deviceId = options.deviceId;
  const locality = options.locality ?? "on-device";
  const rows: RemediationPolicyDocument[] = [];
  const byIdempotency = new Map<string, RemediationPolicyDocument>();
  let nextVersion = 1;

  const assertSubject = (candidate: string): void => {
    if (candidate !== subjectId) {
      throw new RemediationPolicyContractError(
        "cross-subject remediation policy access denied",
        {
          obligation: "remediation_policy.cross_subject_denied",
          subjectId,
          deviceId,
        },
      );
    }
  };

  return {
    subjectId,
    deviceId,

    appendPolicy(input) {
      assertSubject(input.subjectId);
      if (rows.length >= REMEDIATION_POLICY_ROW_LIMIT) {
        throw new RemediationPolicyContractError(
          "remediation policy catalog capacity exceeded",
          {
            obligation: "remediation_policy.capacity",
            subjectId,
            deviceId,
          },
        );
      }

      const existing = byIdempotency.get(input.idempotencyKey);
      if (existing !== undefined) {
        if (
          existing.policyId !== input.policyId ||
          existing.failureClass !== input.failureClass ||
          JSON.stringify(existing.action) !== JSON.stringify(input.action)
        ) {
          throw new RemediationPolicyContractError(
            "idempotency key conflict for remediation policy",
            {
              obligation: "remediation_policy.idempotent_conflict",
              subjectId,
              deviceId,
            },
          );
        }
        emit(options.onTelemetry, {
          event: "runtime.harness.remediation_policy",
          outcome: "ok",
          subjectId,
          deviceId,
          policyId: existing.policyId,
          version: existing.version,
          failureClass: existing.failureClass,
          actionKind: existing.action.kind,
          surface: existing.action.surface,
        });
        return existing;
      }

      const action = parseRemediationAction(input.action, {
        subjectId,
        deviceId,
      });
      const version = input.version ?? nextVersion;
      if (version < nextVersion) {
        throw new RemediationPolicyContractError(
          "remediation policy versions are append-only",
          {
            obligation: "remediation_policy.invalid_input",
            subjectId,
            deviceId,
          },
        );
      }
      const draft: RemediationPolicyDocument = {
        schemaVersion: REMEDIATION_POLICY_SCHEMA_VERSION,
        policyId: input.policyId,
        version,
        subjectId,
        deviceId: input.deviceId,
        locality: input.locality ?? locality,
        failureClass: input.failureClass,
        confidence: input.confidence,
        action,
        disabled: input.disabled,
        ineffectiveAttempts: input.ineffectiveAttempts,
        pageRequested: input.pageRequested,
        triageActive: input.triageActive,
        idempotencyKey: input.idempotencyKey,
      };
      const parsed = parseRemediationPolicy(draft, {
        expectedSubjectId: subjectId,
        ...(options.onTelemetry !== undefined
          ? { onTelemetry: options.onTelemetry }
          : {}),
      });
      rows.push(parsed);
      byIdempotency.set(parsed.idempotencyKey, parsed);
      nextVersion = Math.max(nextVersion, parsed.version + 1);
      return parsed;
    },

    listPolicies() {
      return rows.slice();
    },

    resolveForFailureClass(failureClass, resolveOptions) {
      return selectRemediationPolicy({
        subjectId,
        failureClass,
        policies: rows,
        deviceId,
        ...(resolveOptions?.confidenceThreshold !== undefined
          ? { confidenceThreshold: resolveOptions.confidenceThreshold }
          : {}),
        ...(options.onTelemetry !== undefined
          ? { onTelemetry: options.onTelemetry }
          : {}),
      });
    },

    setTriageActive(failureClass, active) {
      const resolved = selectRemediationPolicy({
        subjectId,
        failureClass,
        policies: rows,
        deviceId,
        confidenceThreshold: 0,
      });
      if (!resolved.ok && resolved.reason === "missing_policy") {
        return undefined;
      }
      const base =
        resolved.ok === true
          ? resolved.policy
          : resolved.policy !== undefined
            ? resolved.policy
            : undefined;
      if (base === undefined) return undefined;
      const next: RemediationPolicyDocument = {
        ...base,
        version: nextVersion,
        triageActive: active,
        idempotencyKey: `${base.idempotencyKey}.triage.${active ? "on" : "off"}.${nextVersion}`,
      };
      nextVersion += 1;
      const parsed = parseRemediationPolicy(next, {
        expectedSubjectId: subjectId,
        ...(options.onTelemetry !== undefined
          ? { onTelemetry: options.onTelemetry }
          : {}),
      });
      rows.push(parsed);
      byIdempotency.set(parsed.idempotencyKey, parsed);
      return parsed;
    },

    recordIneffectiveAttempt(policyId) {
      const latest = [...rows].reverse().find((row) => row.policyId === policyId);
      if (latest === undefined) return undefined;
      assertSubject(latest.subjectId);
      const next = nextIneffectiveAttemptPolicy(latest, {
        limit: REMEDIATION_INEFFECTIVE_ATTEMPT_LIMIT,
      });
      const forced: RemediationPolicyDocument = {
        ...next,
        version: nextVersion,
      };
      nextVersion += 1;
      const parsed = parseRemediationPolicy(forced, {
        expectedSubjectId: subjectId,
        ...(options.onTelemetry !== undefined
          ? { onTelemetry: options.onTelemetry }
          : {}),
      });
      rows.push(parsed);
      byIdempotency.set(parsed.idempotencyKey, parsed);
      return parsed;
    },
  };
}

/** Build a well-formed policy draft for tests and offline catalogs. */
export function buildRemediationPolicyDraft(input: {
  policyId: string;
  subjectId: string;
  deviceId: string;
  failureClass: RemediationFailureClass;
  action: RemediationAction;
  confidence?: number;
  version?: number;
  locality?: RemediationLocality;
  disabled?: boolean;
  ineffectiveAttempts?: number;
  pageRequested?: boolean;
  triageActive?: boolean;
  idempotencyKey?: string;
}): RemediationPolicyDocument {
  return parseRemediationPolicy({
    schemaVersion: REMEDIATION_POLICY_SCHEMA_VERSION,
    policyId: input.policyId,
    version: input.version ?? 1,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    locality: input.locality ?? "on-device",
    failureClass: input.failureClass,
    confidence: input.confidence ?? 0.9,
    action: input.action,
    disabled: input.disabled ?? false,
    ineffectiveAttempts: input.ineffectiveAttempts ?? 0,
    pageRequested: input.pageRequested ?? false,
    triageActive: input.triageActive ?? false,
    idempotencyKey:
      input.idempotencyKey ?? `${input.policyId}.v${input.version ?? 1}`,
  });
}
