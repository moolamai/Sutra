/**
 * Bounded auto-remediation executor.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRemediationPolicyCatalog } from "../dist/self_healing/remediation_policy.js";
import {
  RemediationExecutorContractError,
  createInMemoryRemediationSurfaces,
  createRemediationExecutor,
} from "../dist/self_healing/remediation_executor.js";

const SUBJECT = "subj.exec.001";
const DEVICE = "dev.exec";

function seedCatalog(events = []) {
  const catalog = createRemediationPolicyCatalog({
    subjectId: SUBJECT,
    deviceId: DEVICE,
    onTelemetry: (event) => events.push(event),
  });
  catalog.appendPolicy({
    policyId: "policy.retry",
    subjectId: SUBJECT,
    deviceId: DEVICE,
    locality: "on-device",
    failureClass: "tool_timeout",
    confidence: 0.92,
    action: {
      kind: "adjust_retry_budget",
      surface: "retry_cap",
      maxRetries: 4,
    },
    disabled: false,
    ineffectiveAttempts: 0,
    pageRequested: false,
    triageActive: false,
    idempotencyKey: "seed.retry.1",
  });
  catalog.appendPolicy({
    policyId: "policy.corr",
    subjectId: SUBJECT,
    deviceId: DEVICE,
    locality: "on-device",
    failureClass: "correction_exhaustion",
    confidence: 0.9,
    action: {
      kind: "set_correction_loop_cap",
      surface: "correction_loop",
      maxCorrectionTurns: 3,
    },
    disabled: false,
    ineffectiveAttempts: 0,
    pageRequested: false,
    triageActive: false,
    idempotencyKey: "seed.corr.1",
  });
  return catalog;
}

test("execute: matches failure to policy and applies typed retry surface", async () => {
  const events = [];
  const catalog = seedCatalog(events);
  const { ports, state } = createInMemoryRemediationSurfaces();
  const executor = createRemediationExecutor({
    subjectId: SUBJECT,
    deviceId: DEVICE,
    catalog,
    surfaces: ports,
    onTelemetry: (event) => events.push(event),
  });

  const result = await executor.execute({
    subjectId: SUBJECT,
    failureClass: "tool_timeout",
    evidenceFingerprint: "fp.timeout.1",
    executionKey: "exec.timeout.1",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.applied, true);
    assert.equal(result.action.kind, "adjust_retry_budget");
    assert.equal(result.idempotentReplay, false);
  }
  assert.equal(state.retryCap, 4);
  assert.equal(state.applyCount, 1);
  assert.ok(
    events.some(
      (event) =>
        event.event === "runtime.harness.remediation_executor" &&
        event.outcome === "ok" &&
        event.surface === "retry_cap",
    ),
  );
});

test("execute: triage suppresses; highest-version policy wins; replay is idempotent", async () => {
  const catalog = seedCatalog();
  catalog.appendPolicy({
    policyId: "policy.retry",
    subjectId: SUBJECT,
    deviceId: DEVICE,
    locality: "on-device",
    failureClass: "tool_timeout",
    confidence: 0.99,
    action: {
      kind: "adjust_retry_budget",
      surface: "retry_cap",
      maxRetries: 7,
    },
    disabled: false,
    ineffectiveAttempts: 0,
    pageRequested: false,
    triageActive: false,
    idempotencyKey: "seed.retry.2",
  });
  const { ports, state } = createInMemoryRemediationSurfaces();
  const executor = createRemediationExecutor({
    subjectId: SUBJECT,
    deviceId: DEVICE,
    catalog,
    surfaces: ports,
  });

  const first = await executor.execute({
    subjectId: SUBJECT,
    failureClass: "tool_timeout",
    evidenceFingerprint: "fp.a",
    executionKey: "exec.a",
  });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.action.maxRetries, 7);
  }
  assert.equal(state.applyCount, 1);

  const replay = await executor.execute({
    subjectId: SUBJECT,
    failureClass: "tool_timeout",
    evidenceFingerprint: "fp.a",
    executionKey: "exec.a",
  });
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.idempotentReplay, true);
  }
  assert.equal(state.applyCount, 1, "replay must not double-apply");

  catalog.setTriageActive("correction_exhaustion", true);
  const suppressed = await executor.execute({
    subjectId: SUBJECT,
    failureClass: "correction_exhaustion",
    evidenceFingerprint: "fp.triage",
    executionKey: "exec.triage",
  });
  assert.equal(suppressed.ok, false);
  if (!suppressed.ok) {
    assert.equal(suppressed.reason, "triage_suppressed");
  }
});

test("reportOutcome: ineffective attempts disable and page; forbidden surfaces refused", async () => {
  const catalog = seedCatalog();
  const { ports } = createInMemoryRemediationSurfaces();
  const executor = createRemediationExecutor({
    subjectId: SUBJECT,
    deviceId: DEVICE,
    catalog,
    surfaces: ports,
  });

  for (let i = 0; i < 3; i += 1) {
    const key = `exec.ineff.${i}`;
    const applied = await executor.execute({
      subjectId: SUBJECT,
      failureClass: "tool_timeout",
      evidenceFingerprint: `fp.${i}`,
      executionKey: key,
    });
    assert.equal(applied.ok, true);
    const updated = executor.reportOutcome({
      executionKey: key,
      resolved: false,
    });
    assert.ok(updated);
    if (i < 2) {
      assert.equal(updated.disabled, false);
    } else {
      assert.equal(updated.disabled, true);
      assert.equal(updated.pageRequested, true);
    }
  }

  const afterDisable = await executor.execute({
    subjectId: SUBJECT,
    failureClass: "tool_timeout",
    evidenceFingerprint: "fp.after",
    executionKey: "exec.after",
  });
  assert.equal(afterDisable.ok, false);
  if (!afterDisable.ok) {
    assert.equal(afterDisable.reason, "disabled_ineffective");
    assert.equal(afterDisable.pageRequested, true);
  }

  await assert.rejects(
    () =>
      executor.execute({
        subjectId: "subj.other",
        failureClass: "tool_timeout",
        evidenceFingerprint: "fp.x",
        executionKey: "exec.x",
      }),
    (error) =>
      error instanceof RemediationExecutorContractError &&
      error.obligation === "remediation_policy.cross_subject_denied",
  );

  await assert.rejects(
    () =>
      executor.execute({
        subjectId: SUBJECT,
        failureClass: "tool_timeout",
        evidenceFingerprint: "fp.perm",
        executionKey: "exec.perm",
        // @ts-expect-error intentional forbidden probe
        permissionWiden: true,
      }),
    (error) =>
      error instanceof RemediationExecutorContractError &&
      error.obligation === "remediation_executor.forbidden_action",
  );
});

test("surface failure is typed; concurrent executes serialize without double-apply", async () => {
  const catalog = seedCatalog();
  const { ports, state } = createInMemoryRemediationSurfaces({
    failOnSurface: "retry_cap",
  });
  const failing = createRemediationExecutor({
    subjectId: SUBJECT,
    deviceId: DEVICE,
    catalog,
    surfaces: ports,
  });
  await assert.rejects(
    () =>
      failing.execute({
        subjectId: SUBJECT,
        failureClass: "tool_timeout",
        evidenceFingerprint: "fp.fail",
        executionKey: "exec.fail",
      }),
    (error) =>
      error instanceof RemediationExecutorContractError &&
      error.obligation === "remediation_executor.surface_failed",
  );
  assert.equal(state.applyCount, 0);

  const { ports: okPorts, state: okState } = createInMemoryRemediationSurfaces();
  const okCatalog = seedCatalog();
  const executor = createRemediationExecutor({
    subjectId: SUBJECT,
    deviceId: DEVICE,
    catalog: okCatalog,
    surfaces: okPorts,
  });
  const results = await Promise.all([
    executor.execute({
      subjectId: SUBJECT,
      failureClass: "tool_timeout",
      evidenceFingerprint: "fp.c1",
      executionKey: "exec.concurrent.1",
    }),
    executor.execute({
      subjectId: SUBJECT,
      failureClass: "tool_timeout",
      evidenceFingerprint: "fp.c2",
      executionKey: "exec.concurrent.2",
    }),
  ]);
  assert.equal(results.every((row) => row.ok), true);
  assert.equal(okState.applyCount, 2);
  assert.equal(okState.retryCap, 4);
});
