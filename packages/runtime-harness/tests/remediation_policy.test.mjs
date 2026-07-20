/**
 * Remediation policy schema over typed control surfaces.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FORBIDDEN_REMEDIATION_SURFACES,
  REMEDIATION_ACTION_KINDS,
  REMEDIATION_CORRECTION_CAP_MAX,
  REMEDIATION_CORRECTION_CAP_MIN,
  REMEDIATION_POLICY_SCHEMA_VERSION,
  REMEDIATION_RETRY_BUDGET_MAX,
  REMEDIATION_RETRY_BUDGET_MIN,
  RemediationPolicyContractError,
  buildRemediationPolicyDraft,
  createRemediationPolicyCatalog,
  nextIneffectiveAttemptPolicy,
  parseRemediationAction,
  parseRemediationPolicy,
  selectRemediationPolicy,
} from "../dist/self_healing/remediation_policy.js";

const SUBJECT = "subj.reme.001";
const DEVICE = "dev.reme";

function basePolicy(overrides = {}) {
  return buildRemediationPolicyDraft({
    policyId: "policy.retry",
    subjectId: SUBJECT,
    deviceId: DEVICE,
    failureClass: "tool_timeout",
    action: {
      kind: "adjust_retry_budget",
      surface: "retry_cap",
      maxRetries: 3,
    },
    ...overrides,
  });
}

test("parses all four explicit remediation action kinds within bounds", () => {
  assert.equal(REMEDIATION_ACTION_KINDS.length, 4);

  assert.deepEqual(
    parseRemediationAction({
      kind: "adjust_retry_budget",
      surface: "retry_cap",
      maxRetries: REMEDIATION_RETRY_BUDGET_MIN,
    }),
    {
      kind: "adjust_retry_budget",
      surface: "retry_cap",
      maxRetries: 0,
    },
  );
  assert.deepEqual(
    parseRemediationAction({
      kind: "adjust_retry_budget",
      surface: "retry_cap",
      maxRetries: REMEDIATION_RETRY_BUDGET_MAX,
    }).maxRetries,
    10,
  );

  assert.equal(
    parseRemediationAction({
      kind: "set_correction_loop_cap",
      surface: "correction_loop",
      maxCorrectionTurns: REMEDIATION_CORRECTION_CAP_MIN,
    }).maxCorrectionTurns,
    1,
  );
  assert.equal(
    parseRemediationAction({
      kind: "set_correction_loop_cap",
      surface: "correction_loop",
      maxCorrectionTurns: REMEDIATION_CORRECTION_CAP_MAX,
    }).maxCorrectionTurns,
    64,
  );

  assert.deepEqual(
    parseRemediationAction({
      kind: "switch_degradation_mode",
      surface: "degradation_registry",
      dependency: "model",
      behavior: "stale_with_marker",
    }),
    {
      kind: "switch_degradation_mode",
      surface: "degradation_registry",
      dependency: "model",
      behavior: "stale_with_marker",
    },
  );

  assert.deepEqual(
    parseRemediationAction({
      kind: "set_routing_fallback",
      surface: "routing_budget",
      fallback: "champion",
    }),
    {
      kind: "set_routing_fallback",
      surface: "routing_budget",
      fallback: "champion",
    },
  );
});

test("refuses forbidden surfaces, freeform actions, and out-of-bounds values", () => {
  for (const surface of FORBIDDEN_REMEDIATION_SURFACES) {
    assert.throws(
      () =>
        parseRemediationAction({
          kind: "adjust_retry_budget",
          surface,
          maxRetries: 2,
        }),
      (error) =>
        error instanceof RemediationPolicyContractError &&
        error.obligation === "remediation_policy.forbidden_surface",
    );
  }

  assert.throws(
    () =>
      parseRemediationAction({
        kind: "widen_permissions",
        surface: "permissions",
        delta: 1,
      }),
    (error) =>
      error instanceof RemediationPolicyContractError &&
      error.obligation === "remediation_policy.invalid_input",
  );

  assert.throws(
    () =>
      parseRemediationAction({
        kind: "set_routing_fallback",
        surface: "routing_budget",
        fallback: "shadow",
      }),
    (error) =>
      error instanceof RemediationPolicyContractError &&
      error.obligation === "remediation_policy.forbidden_action",
  );

  assert.throws(
    () =>
      parseRemediationAction({
        kind: "adjust_retry_budget",
        surface: "retry_cap",
        maxRetries: -1,
      }),
    (error) =>
      error instanceof RemediationPolicyContractError &&
      error.obligation === "remediation_policy.out_of_bounds",
  );

  assert.throws(
    () =>
      parseRemediationAction({
        kind: "set_correction_loop_cap",
        surface: "correction_loop",
        maxCorrectionTurns: 65,
      }),
    (error) =>
      error instanceof RemediationPolicyContractError &&
      error.obligation === "remediation_policy.out_of_bounds",
  );

  assert.throws(
    () =>
      parseRemediationPolicy({
        ...basePolicy(),
        utterance: "secret learner text",
      }),
    (error) =>
      error instanceof RemediationPolicyContractError &&
      error.obligation === "remediation_policy.raw_content_forbidden",
  );
});

test("selects highest version then confidence; never double-applies", () => {
  const events = [];
  const low = basePolicy({
    policyId: "policy.a",
    version: 1,
    confidence: 0.99,
    idempotencyKey: "k.a",
  });
  const highVersion = basePolicy({
    policyId: "policy.b",
    version: 3,
    confidence: 0.85,
    idempotencyKey: "k.b",
    action: {
      kind: "adjust_retry_budget",
      surface: "retry_cap",
      maxRetries: 5,
    },
  });
  const selected = selectRemediationPolicy({
    subjectId: SUBJECT,
    failureClass: "tool_timeout",
    policies: [low, highVersion],
    deviceId: DEVICE,
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(selected.ok, true);
  if (selected.ok) {
    assert.equal(selected.policy.policyId, "policy.b");
    assert.equal(selected.policy.action.maxRetries, 5);
  }
  assert.ok(
    events.some(
      (event) =>
        event.event === "runtime.harness.remediation_policy" &&
        event.outcome === "ok",
    ),
  );
});

test("triage suppresses remediation; ineffective attempts disable and page", () => {
  const triage = basePolicy({
    policyId: "policy.triage",
    triageActive: true,
    idempotencyKey: "k.triage",
  });
  const suppressed = selectRemediationPolicy({
    subjectId: SUBJECT,
    failureClass: "tool_timeout",
    policies: [triage],
    deviceId: DEVICE,
  });
  assert.equal(suppressed.ok, false);
  if (!suppressed.ok) {
    assert.equal(suppressed.reason, "triage_suppressed");
  }

  let current = basePolicy({
    policyId: "policy.disable",
    idempotencyKey: "k.d0",
  });
  current = nextIneffectiveAttemptPolicy(current);
  current = nextIneffectiveAttemptPolicy(current);
  current = nextIneffectiveAttemptPolicy(current);
  assert.equal(current.ineffectiveAttempts, 3);
  assert.equal(current.disabled, true);
  assert.equal(current.pageRequested, true);
  assert.equal(current.version, 4);

  const disabledLookup = selectRemediationPolicy({
    subjectId: SUBJECT,
    failureClass: "tool_timeout",
    policies: [current],
    deviceId: DEVICE,
  });
  assert.equal(disabledLookup.ok, false);
  if (!disabledLookup.ok) {
    assert.equal(disabledLookup.reason, "disabled_ineffective");
  }
});

test("catalog: subject isolation, idempotent append, cross-subject deny", () => {
  const events = [];
  const catalog = createRemediationPolicyCatalog({
    subjectId: SUBJECT,
    deviceId: DEVICE,
    onTelemetry: (event) => events.push(event),
  });

  const first = catalog.appendPolicy({
    policyId: "policy.corr",
    subjectId: SUBJECT,
    deviceId: DEVICE,
    locality: "on-device",
    failureClass: "correction_exhaustion",
    confidence: 0.91,
    action: {
      kind: "set_correction_loop_cap",
      surface: "correction_loop",
      maxCorrectionTurns: 4,
    },
    disabled: false,
    ineffectiveAttempts: 0,
    pageRequested: false,
    triageActive: false,
    idempotencyKey: "idem.corr.1",
  });
  assert.equal(first.schemaVersion, REMEDIATION_POLICY_SCHEMA_VERSION);
  assert.equal(first.version, 1);

  const replay = catalog.appendPolicy({
    policyId: "policy.corr",
    subjectId: SUBJECT,
    deviceId: DEVICE,
    locality: "on-device",
    failureClass: "correction_exhaustion",
    confidence: 0.91,
    action: {
      kind: "set_correction_loop_cap",
      surface: "correction_loop",
      maxCorrectionTurns: 4,
    },
    disabled: false,
    ineffectiveAttempts: 0,
    pageRequested: false,
    triageActive: false,
    idempotencyKey: "idem.corr.1",
  });
  assert.equal(replay.version, first.version);
  assert.equal(catalog.listPolicies().length, 1);

  assert.throws(
    () =>
      catalog.appendPolicy({
        policyId: "policy.intruder",
        subjectId: "subj.other",
        deviceId: DEVICE,
        locality: "on-device",
        failureClass: "degradation",
        confidence: 0.9,
        action: {
          kind: "switch_degradation_mode",
          surface: "degradation_registry",
          dependency: "sync",
          behavior: "queue",
        },
        disabled: false,
        ineffectiveAttempts: 0,
        pageRequested: false,
        triageActive: false,
        idempotencyKey: "idem.x",
      }),
    (error) =>
      error instanceof RemediationPolicyContractError &&
      error.obligation === "remediation_policy.cross_subject_denied",
  );

  const resolved = catalog.resolveForFailureClass("correction_exhaustion");
  assert.equal(resolved.ok, true);

  catalog.setTriageActive("correction_exhaustion", true);
  const whileTriage = catalog.resolveForFailureClass("correction_exhaustion");
  assert.equal(whileTriage.ok, false);
  if (!whileTriage.ok) {
    assert.equal(whileTriage.reason, "triage_suppressed");
  }

  assert.ok(!JSON.stringify(events).includes("secret"));
  assert.ok(
    events.every(
      (event) => event.subjectId === SUBJECT || event.outcome === "fail",
    ),
  );
});
