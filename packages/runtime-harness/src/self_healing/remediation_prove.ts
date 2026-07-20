/**
 * Remediation fixture prove harness — validates forbidden-action refusal,
 * within-budget remediation, and exhausted-policy disable against seeded
 * metadata-only fixtures.
 */

import {
  REMEDIATION_INEFFECTIVE_ATTEMPT_LIMIT,
  REMEDIATION_POLICY_SCHEMA_VERSION,
  RemediationPolicyContractError,
  createRemediationPolicyCatalog,
  parseRemediationAction,
  type RemediationAction,
  type RemediationActionKind,
  type RemediationControlSurface,
  type RemediationFailureClass,
  type RemediationLocality,
  type RemediationPolicyCatalog,
  type RemediationPolicyTelemetryEvent,
} from "./remediation_policy.js";
import {
  RemediationExecutorContractError,
  createInMemoryRemediationSurfaces,
  createRemediationExecutor,
  type RemediationExecutorTelemetryEvent,
} from "./remediation_executor.js";

export const REMEDIATION_FIXTURES_RELPATH =
  "training/self_healing/remediation_fixtures" as const;

export const REMEDIATION_FIXTURE_SCHEMA_VERSION =
  "remediation-fixtures.v1" as const;


export type RemediationFixtureKind = "refuse" | "remediate" | "exhaust";

export type RemediationFixturePolicySeed = {
  policyId: string;
  version?: number;
  failureClass: RemediationFailureClass;
  confidence: number;
  action: RemediationAction;
  disabled?: boolean;
  ineffectiveAttempts?: number;
  pageRequested?: boolean;
  triageActive?: boolean;
  idempotencyKey: string;
};

export type RemediationFixtureProbe =
  | {
      type: "parse_action";
      action: unknown;
    }
  | {
      type: "execute_forbidden_field";
      failureClass: RemediationFailureClass;
      evidenceFingerprint: string;
      executionKey: string;
      forbiddenField: string;
      seedPolicy: RemediationFixturePolicySeed;
    };

export type RemediationFixtureExpectation = {
  obligation?: string;
  applied?: boolean;
  reason?:
    | "missing_policy"
    | "triage_suppressed"
    | "below_confidence"
    | "disabled_ineffective"
    | "cross_subject_denied";
  actionKind?: RemediationActionKind;
  surface?: RemediationControlSurface;
  maxRetries?: number;
  maxApplyCount?: number;
  resolved?: boolean;
  idempotentReplay?: boolean;
  ineffectiveLimit?: number;
  disabled?: boolean;
  pageRequested?: boolean;
  finalReason?: "disabled_ineffective";
};

export type RemediationFixtureDocument = {
  id: string;
  kind: RemediationFixtureKind;
  subjectId: string;
  deviceId?: string;
  locality?: RemediationLocality;
  expect: RemediationFixtureExpectation;
  probe?: RemediationFixtureProbe;
  policies?: RemediationFixturePolicySeed[];
  execute?: {
    failureClass: RemediationFailureClass;
    evidenceFingerprint: string;
    executionKey: string;
    replay?: boolean;
  };
};

export type RemediationFixtureTelemetryEvent = {
  event: "runtime.harness.remediation_fixture";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  fixtureId: string;
  kind?: RemediationFixtureKind;
  obligation?: string;
};

function failFixture(
  fixture: RemediationFixtureDocument,
  deviceId: string,
  message: string,
  onTelemetry?: (event: RemediationFixtureTelemetryEvent) => void,
): never {
  onTelemetry?.({
    event: "runtime.harness.remediation_fixture",
    outcome: "fail",
    subjectId: fixture.subjectId,
    deviceId,
    fixtureId: fixture.id,
    kind: fixture.kind,
    obligation: "remediation_policy.invalid_input",
  });
  throw new RemediationPolicyContractError(message, {
    obligation: "remediation_policy.invalid_input",
    subjectId: fixture.subjectId,
    deviceId,
  });
}

function seedCatalog(
  fixture: RemediationFixtureDocument,
  deviceId: string,
  onTelemetry?: (
    event: RemediationPolicyTelemetryEvent | RemediationExecutorTelemetryEvent,
  ) => void,
): RemediationPolicyCatalog {
  const catalog = createRemediationPolicyCatalog({
    subjectId: fixture.subjectId,
    deviceId,
    locality: fixture.locality ?? "on-device",
    ...(onTelemetry !== undefined ? { onTelemetry } : {}),
  });
  for (const seed of fixture.policies ?? []) {
    catalog.appendPolicy({
      policyId: seed.policyId,
      subjectId: fixture.subjectId,
      deviceId,
      locality: fixture.locality ?? "on-device",
      failureClass: seed.failureClass,
      confidence: seed.confidence,
      action: seed.action,
      disabled: seed.disabled ?? false,
      ineffectiveAttempts: seed.ineffectiveAttempts ?? 0,
      pageRequested: seed.pageRequested ?? false,
      triageActive: seed.triageActive ?? false,
      idempotencyKey: seed.idempotencyKey,
      ...(seed.version !== undefined ? { version: seed.version } : {}),
      schemaVersion: REMEDIATION_POLICY_SCHEMA_VERSION,
    });
  }
  return catalog;
}

async function proveRefuseFixture(
  fixture: RemediationFixtureDocument,
  deviceId: string,
  onTelemetry?: (
    event:
      | RemediationFixtureTelemetryEvent
      | RemediationPolicyTelemetryEvent
      | RemediationExecutorTelemetryEvent,
  ) => void,
): Promise<void> {
  const expected =
    fixture.expect.obligation ?? "remediation_policy.forbidden_surface";
  const probe = fixture.probe;
  if (probe === undefined) {
    return failFixture(fixture, deviceId, "refuse fixture missing probe", onTelemetry);
  }

  let denied = false;
  try {
    if (probe.type === "parse_action") {
      parseRemediationAction(probe.action, {
        subjectId: fixture.subjectId,
        deviceId,
      });
    } else {
      const catalog = createRemediationPolicyCatalog({
        subjectId: fixture.subjectId,
        deviceId,
        locality: fixture.locality ?? "on-device",
      });
      const seed = probe.seedPolicy;
      catalog.appendPolicy({
        policyId: seed.policyId,
        subjectId: fixture.subjectId,
        deviceId,
        locality: fixture.locality ?? "on-device",
        failureClass: seed.failureClass,
        confidence: seed.confidence,
        action: seed.action,
        disabled: false,
        ineffectiveAttempts: 0,
        pageRequested: false,
        triageActive: false,
        idempotencyKey: seed.idempotencyKey,
        schemaVersion: REMEDIATION_POLICY_SCHEMA_VERSION,
      });
      const { ports } = createInMemoryRemediationSurfaces();
      const executor = createRemediationExecutor({
        subjectId: fixture.subjectId,
        deviceId,
        catalog,
        surfaces: ports,
        ...(onTelemetry !== undefined ? { onTelemetry } : {}),
      });
      await executor.execute({
        subjectId: fixture.subjectId,
        failureClass: probe.failureClass,
        evidenceFingerprint: probe.evidenceFingerprint,
        executionKey: probe.executionKey,
        [probe.forbiddenField]: true,
      } as Parameters<typeof executor.execute>[0] & Record<string, unknown>);
    }
  } catch (error) {
    const obligation =
      error instanceof RemediationPolicyContractError ||
      error instanceof RemediationExecutorContractError
        ? error.obligation
        : undefined;
    if (obligation === expected) {
      denied = true;
    } else {
      throw error;
    }
  }

  if (!denied) {
    return failFixture(
      fixture,
      deviceId,
      `fixture ${fixture.id} must refuse with ${expected}`,
      onTelemetry,
    );
  }
  onTelemetry?.({
    event: "runtime.harness.remediation_fixture",
    outcome: "ok",
    subjectId: fixture.subjectId,
    deviceId,
    fixtureId: fixture.id,
    kind: "refuse",
    obligation: expected,
  });
}

async function proveRemediateFixture(
  fixture: RemediationFixtureDocument,
  deviceId: string,
  onTelemetry?: (
    event:
      | RemediationFixtureTelemetryEvent
      | RemediationPolicyTelemetryEvent
      | RemediationExecutorTelemetryEvent,
  ) => void,
): Promise<void> {
  const catalog = seedCatalog(fixture, deviceId, onTelemetry);
  const { ports, state } = createInMemoryRemediationSurfaces();
  const executor = createRemediationExecutor({
    subjectId: fixture.subjectId,
    deviceId,
    catalog,
    surfaces: ports,
    ...(onTelemetry !== undefined ? { onTelemetry } : {}),
  });
  const exec = fixture.execute;
  if (exec === undefined) {
    return failFixture(fixture, deviceId, "remediate fixture missing execute", onTelemetry);
  }

  const first = await executor.execute({
    subjectId: fixture.subjectId,
    failureClass: exec.failureClass,
    evidenceFingerprint: exec.evidenceFingerprint,
    executionKey: exec.executionKey,
  });

  if (fixture.expect.applied === false) {
    if (first.ok || first.applied) {
      return failFixture(
        fixture,
        deviceId,
        `fixture ${fixture.id} must not apply remediation`,
        onTelemetry,
      );
    }
    if (
      fixture.expect.reason !== undefined &&
      first.reason !== fixture.expect.reason
    ) {
      return failFixture(
        fixture,
        deviceId,
        `fixture ${fixture.id} expected reason ${fixture.expect.reason}`,
        onTelemetry,
      );
    }
    onTelemetry?.({
      event: "runtime.harness.remediation_fixture",
      outcome: "advisory",
      subjectId: fixture.subjectId,
      deviceId,
      fixtureId: fixture.id,
      kind: "remediate",
    });
    return;
  }

  if (!first.ok || !first.applied) {
    return failFixture(
      fixture,
      deviceId,
      `fixture ${fixture.id} must apply remediation`,
      onTelemetry,
    );
  }
  if (
    fixture.expect.actionKind !== undefined &&
    first.action.kind !== fixture.expect.actionKind
  ) {
    return failFixture(
      fixture,
      deviceId,
      `fixture ${fixture.id} unexpected action kind`,
      onTelemetry,
    );
  }
  if (
    fixture.expect.surface !== undefined &&
    first.action.surface !== fixture.expect.surface
  ) {
    return failFixture(
      fixture,
      deviceId,
      `fixture ${fixture.id} unexpected surface`,
      onTelemetry,
    );
  }
  if (
    fixture.expect.maxRetries !== undefined &&
    first.action.kind === "adjust_retry_budget" &&
    first.action.maxRetries !== fixture.expect.maxRetries
  ) {
    return failFixture(
      fixture,
      deviceId,
      `fixture ${fixture.id} unexpected maxRetries`,
      onTelemetry,
    );
  }
  if (
    fixture.expect.maxApplyCount !== undefined &&
    state.applyCount > fixture.expect.maxApplyCount
  ) {
    return failFixture(
      fixture,
      deviceId,
      `fixture ${fixture.id} exceeded apply budget`,
      onTelemetry,
    );
  }

  if (exec.replay === true || fixture.expect.idempotentReplay === true) {
    const replay = await executor.execute({
      subjectId: fixture.subjectId,
      failureClass: exec.failureClass,
      evidenceFingerprint: exec.evidenceFingerprint,
      executionKey: exec.executionKey,
    });
    if (!replay.ok || !replay.idempotentReplay) {
      return failFixture(
        fixture,
        deviceId,
        `fixture ${fixture.id} replay must be idempotent`,
        onTelemetry,
      );
    }
    if (
      fixture.expect.maxApplyCount !== undefined &&
      state.applyCount > fixture.expect.maxApplyCount
    ) {
      return failFixture(
        fixture,
        deviceId,
        `fixture ${fixture.id} replay double-applied`,
        onTelemetry,
      );
    }
  }

  if (fixture.expect.resolved === true) {
    executor.reportOutcome({
      executionKey: exec.executionKey,
      resolved: true,
      subjectId: fixture.subjectId,
    });
  }

  onTelemetry?.({
    event: "runtime.harness.remediation_fixture",
    outcome: "ok",
    subjectId: fixture.subjectId,
    deviceId,
    fixtureId: fixture.id,
    kind: "remediate",
  });
}

async function proveExhaustFixture(
  fixture: RemediationFixtureDocument,
  deviceId: string,
  onTelemetry?: (
    event:
      | RemediationFixtureTelemetryEvent
      | RemediationPolicyTelemetryEvent
      | RemediationExecutorTelemetryEvent,
  ) => void,
): Promise<void> {
  const catalog = seedCatalog(fixture, deviceId, onTelemetry);
  const { ports } = createInMemoryRemediationSurfaces();
  const executor = createRemediationExecutor({
    subjectId: fixture.subjectId,
    deviceId,
    catalog,
    surfaces: ports,
    ...(onTelemetry !== undefined ? { onTelemetry } : {}),
  });
  const limit =
    fixture.expect.ineffectiveLimit ?? REMEDIATION_INEFFECTIVE_ATTEMPT_LIMIT;
  const failureClass =
    fixture.policies?.[0]?.failureClass ?? ("tool_timeout" as const);

  for (let i = 0; i < limit; i += 1) {
    const key = `exec.exhaust.${fixture.id}.${i}`;
    const applied = await executor.execute({
      subjectId: fixture.subjectId,
      failureClass,
      evidenceFingerprint: `fp.exhaust.${i}`,
      executionKey: key,
    });
    if (!applied.ok) {
      return failFixture(
        fixture,
        deviceId,
        `fixture ${fixture.id} expected apply before disable at attempt ${i}`,
        onTelemetry,
      );
    }
    const updated = executor.reportOutcome({
      executionKey: key,
      resolved: false,
      subjectId: fixture.subjectId,
    });
    if (updated === undefined) {
      return failFixture(
        fixture,
        deviceId,
        `fixture ${fixture.id} missing policy after ineffective report`,
        onTelemetry,
      );
    }
    if (i < limit - 1 && updated.disabled) {
      return failFixture(
        fixture,
        deviceId,
        `fixture ${fixture.id} disabled too early`,
        onTelemetry,
      );
    }
    if (i === limit - 1) {
      if (fixture.expect.disabled === true && !updated.disabled) {
        return failFixture(
          fixture,
          deviceId,
          `fixture ${fixture.id} must disable at limit`,
          onTelemetry,
        );
      }
      if (fixture.expect.pageRequested === true && !updated.pageRequested) {
        return failFixture(
          fixture,
          deviceId,
          `fixture ${fixture.id} must page at limit`,
          onTelemetry,
        );
      }
    }
  }

  const after = await executor.execute({
    subjectId: fixture.subjectId,
    failureClass,
    evidenceFingerprint: "fp.exhaust.after",
    executionKey: `exec.exhaust.${fixture.id}.after`,
  });
  if (
    after.ok ||
    after.reason !== (fixture.expect.finalReason ?? "disabled_ineffective")
  ) {
    return failFixture(
      fixture,
      deviceId,
      `fixture ${fixture.id} must refuse after exhaust`,
      onTelemetry,
    );
  }

  onTelemetry?.({
    event: "runtime.harness.remediation_fixture",
    outcome: "ok",
    subjectId: fixture.subjectId,
    deviceId,
    fixtureId: fixture.id,
    kind: "exhaust",
  });
}

/**
 * Run a single seeded remediation fixture to completion.
 */
export async function proveRemediationFixture(
  fixture: RemediationFixtureDocument,
  options?: {
    deviceId?: string;
    onTelemetry?: (
      event:
        | RemediationFixtureTelemetryEvent
        | RemediationPolicyTelemetryEvent
        | RemediationExecutorTelemetryEvent,
    ) => void;
  },
): Promise<{ ok: true; fixtureId: string }> {
  const deviceId = options?.deviceId ?? fixture.deviceId ?? "ci-remediation";
  const onTelemetry = options?.onTelemetry;
  switch (fixture.kind) {
    case "refuse":
      await proveRefuseFixture(fixture, deviceId, onTelemetry);
      break;
    case "remediate":
      await proveRemediateFixture(fixture, deviceId, onTelemetry);
      break;
    case "exhaust":
      await proveExhaustFixture(fixture, deviceId, onTelemetry);
      break;
    default:
      return failFixture(
        fixture,
        deviceId,
        `unknown fixture kind ${(fixture as RemediationFixtureDocument).kind}`,
        onTelemetry,
      );
  }
  return { ok: true, fixtureId: fixture.id };
}

/**
 * CI prove over an in-memory fixture catalog (loader belongs to training façade).
 */
export async function proveRemediationFixturesCi(options: {
  fixtures: readonly RemediationFixtureDocument[];
  deviceId?: string;
  onTelemetry?: (
    event:
      | RemediationFixtureTelemetryEvent
      | RemediationPolicyTelemetryEvent
      | RemediationExecutorTelemetryEvent,
  ) => void;
}): Promise<{
  ok: true;
  refuseFixtureIds: string[];
  remediateFixtureIds: string[];
  exhaustFixtureIds: string[];
  permissionWidenRefused: true;
  withinBudgetOk: true;
  exhaustedDisablesOk: true;
}> {
  const deviceId = options.deviceId ?? "ci-remediation";
  if (options.fixtures.length < 3 || options.fixtures.length > 64) {
    throw new RemediationPolicyContractError(
      "remediation fixture catalog size out of bounds",
      { obligation: "remediation_policy.invalid_input", deviceId },
    );
  }

  const refuseFixtureIds: string[] = [];
  const remediateFixtureIds: string[] = [];
  const exhaustFixtureIds: string[] = [];

  for (const fixture of options.fixtures) {
    await proveRemediationFixture(fixture, {
      deviceId,
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    });
    if (fixture.kind === "refuse") refuseFixtureIds.push(fixture.id);
    else if (fixture.kind === "remediate") remediateFixtureIds.push(fixture.id);
    else exhaustFixtureIds.push(fixture.id);
  }

  if (!refuseFixtureIds.includes("permission-widen-refused")) {
    throw new RemediationPolicyContractError(
      "permission-widen-refused fixture required",
      { obligation: "remediation_policy.invalid_input", deviceId },
    );
  }
  if (!remediateFixtureIds.includes("seeded-within-budget")) {
    throw new RemediationPolicyContractError(
      "seeded-within-budget fixture required",
      { obligation: "remediation_policy.invalid_input", deviceId },
    );
  }
  if (!exhaustFixtureIds.includes("exhausted-disables")) {
    throw new RemediationPolicyContractError(
      "exhausted-disables fixture required",
      { obligation: "remediation_policy.invalid_input", deviceId },
    );
  }

  options.onTelemetry?.({
    event: "runtime.harness.remediation_fixture",
    outcome: "ok",
    subjectId: "ci",
    deviceId,
    fixtureId: "prove.all",
  });

  return {
    ok: true,
    refuseFixtureIds,
    remediateFixtureIds,
    exhaustFixtureIds,
    permissionWidenRefused: true,
    withinBudgetOk: true,
    exhaustedDisablesOk: true,
  };
}
