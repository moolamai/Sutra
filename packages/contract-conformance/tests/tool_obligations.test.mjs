/**
 * Tool obligations (/003): arg validation, write-ahead,
 * deadline enforcement, and named violation fixtures.
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MUST_ARG_VALIDATION,
  MUST_DEADLINE_ENFORCEMENT,
  MUST_WRITE_AHEAD_AUDIT,
  TOOL_DEADLINE_PROBE_MS,
  TOOL_DEADLINE_WATCHDOG_MS,
  TOOL_HANG_PROBE_NAME,
  TOOL_OBLIGATION_IDS,
  TOOL_PROBE_NAME,
  TOOL_READ_PROBE_NAME,
  TOOL_VIOLATION_FIXTURES,
  TOOL_WRITE_PROBE_NAME,
  buildDeadlineInvocationId,
  buildInvalidToolArguments,
  buildToolInvocationId,
  buildValidToolArguments,
  buildWriteAheadInvocationId,
  createArgValidationObligationRegistry,
  createAuditAfterEffectToolHarnessFactory,
  createDeadlineEnforcementObligationRegistry,
  createHangingToolHarnessFactory,
  createOpaqueErrorToolHarnessFactory,
  createThrowingToolHarnessFactory,
  createToolObligationsRegistry,
  createValidatingToolHarnessFactory,
  createWriteAheadAuditObligationRegistry,
  createWriteAheadToolHarnessFactory,
  hasSchemaErrorDetails,
  hasTimeoutErrorDetails,
  listToolViolationFixtures,
  runConformance,
} from "../dist/index.js";

test("happy path: validating reference mock passes CK-07.1", async () => {
  const events = [];
  const report = await runConformance({
    registry: createArgValidationObligationRegistry(),
    factory: createValidatingToolHarnessFactory(),
    subjectId: "subj-tool-good",
    deviceId: "dev-tool",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(report.verdicts[0].obligationId, TOOL_OBLIGATION_IDS.argValidation);
  assert.equal(report.verdicts[0].mustText, MUST_ARG_VALIDATION);
  assert.ok(
    events.some(
      (e) =>
        e.event === "conformance.runner" &&
        e.outcome === "pass" &&
        e.obligationId === "CK-07.1" &&
        e.subjectId &&
        e.deviceId === "dev-tool",
    ),
  );
});

test("happy path: write-ahead reference passes CK-07.2", async () => {
  const events = [];
  const report = await runConformance({
    registry: createWriteAheadAuditObligationRegistry(),
    factory: createWriteAheadToolHarnessFactory(),
    subjectId: "subj-audit-good",
    deviceId: "dev-audit",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    TOOL_OBLIGATION_IDS.writeAheadAudit,
  );
  assert.equal(report.verdicts[0].mustText, MUST_WRITE_AHEAD_AUDIT);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "pass" &&
        e.obligationId === "CK-07.2" &&
        e.subjectId &&
        e.deviceId === "dev-audit",
    ),
  );
});

test("happy path: deadline reference passes CK-07.3", async () => {
  const events = [];
  const report = await runConformance({
    registry: createDeadlineEnforcementObligationRegistry(),
    factory: createWriteAheadToolHarnessFactory(),
    subjectId: "subj-deadline-good",
    deviceId: "dev-deadline",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    TOOL_OBLIGATION_IDS.deadlineEnforcement,
  );
  assert.equal(report.verdicts[0].mustText, MUST_DEADLINE_ENFORCEMENT);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "pass" &&
        e.obligationId === "CK-07.3" &&
        e.subjectId &&
        e.deviceId === "dev-deadline",
    ),
  );
});

test("happy path: write-ahead reference passes CK-07.1, CK-07.2, and CK-07.3", async () => {
  const report = await runConformance({
    registry: createToolObligationsRegistry(),
    factory: createWriteAheadToolHarnessFactory(),
    subjectId: "subj-tool-full",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 3);
});

test("violation: throwing on invalid args fails CK-07.1 exactly", async () => {
  const report = await runConformance({
    registry: createArgValidationObligationRegistry(),
    factory: createThrowingToolHarnessFactory(),
    subjectId: "subj-tool-throw",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(report.verdicts[0].obligationId, TOOL_OBLIGATION_IDS.argValidation);
  assert.equal(report.verdicts[0].outcome, "fail");
  assert.equal(report.verdicts[0].mustText, MUST_ARG_VALIDATION);
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(report.verdicts[0].message ?? "", /threw/i);
});

test("violation: opaque error output fails CK-07.1", async () => {
  const report = await runConformance({
    registry: createArgValidationObligationRegistry(),
    factory: createOpaqueErrorToolHarnessFactory(),
    subjectId: "subj-tool-opaque",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].obligationId, TOOL_OBLIGATION_IDS.argValidation);
  assert.match(report.verdicts[0].message ?? "", /schema details/i);
});

test("violation: audit-after-effect fails CK-07.2 exactly", async () => {
  const report = await runConformance({
    registry: createWriteAheadAuditObligationRegistry(),
    factory: createAuditAfterEffectToolHarnessFactory(),
    subjectId: "subj-audit-after",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    TOOL_OBLIGATION_IDS.writeAheadAudit,
  );
  assert.equal(report.verdicts[0].mustText, MUST_WRITE_AHEAD_AUDIT);
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(report.verdicts[0].message ?? "", /ordering|before|effect/i);
});

test("violation: hang fixture fails CK-07.3 exactly", async () => {
  const report = await runConformance({
    registry: createDeadlineEnforcementObligationRegistry(),
    factory: createHangingToolHarnessFactory(),
    subjectId: "subj-tool-hang",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    TOOL_OBLIGATION_IDS.deadlineEnforcement,
  );
  assert.equal(report.verdicts[0].mustText, MUST_DEADLINE_ENFORCEMENT);
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(report.verdicts[0].message ?? "", /hung|watchdog|deadline/i);
});

test("violation isolation: each TOOL_VIOLATION_FIXTURES entry fails only its target", async () => {
  const fixtures = listToolViolationFixtures();
  assert.equal(fixtures.length, 3);
  for (const fixture of fixtures) {
    const events = [];
    const report = await runConformance({
      registry: createToolObligationsRegistry(),
      factory: fixture.createFactory(),
      subjectId: `subj-fixture-${fixture.fixtureId.split(".").pop()}`,
      deviceId: "dev-tool-isolation",
      emit: (e) => events.push(e),
    });
    assert.equal(report.exitCode, 1, fixture.fixtureId);
    assert.equal(report.passed, 2, fixture.fixtureId);
    assert.equal(report.failed, 1, fixture.fixtureId);
    const byId = Object.fromEntries(
      report.verdicts.map((v) => [v.obligationId, v]),
    );
    for (const id of Object.values(TOOL_OBLIGATION_IDS)) {
      if (id === fixture.targetObligationId) {
        assert.equal(byId[id].outcome, "fail", `${fixture.fixtureId} → ${id}`);
        assert.equal(byId[id].mustText, fixture.mustText);
        assert.equal(byId[id].attribution, "implementation");
      } else {
        assert.equal(byId[id].outcome, "pass", `${fixture.fixtureId} → ${id}`);
      }
    }
    assert.ok(
      events.some(
        (e) =>
          e.event === "conformance.runner" &&
          e.outcome === "fail" &&
          e.obligationId === fixture.targetObligationId &&
          e.subjectId &&
          e.deviceId === "dev-tool-isolation",
      ),
      `observability for ${fixture.fixtureId}`,
    );
  }
});

test("edge: invalid args and invocation ids are subject-scoped metadata", () => {
  const ctx = {
    subjectId: "subj-a::peer",
    deviceId: "dev",
    deadlineMs: 1000,
    emit() {},
  };
  assert.match(buildToolInvocationId(ctx), /subj-a\.peer/);
  assert.match(buildWriteAheadInvocationId(ctx), /subj-a\.peer/);
  assert.match(buildDeadlineInvocationId(ctx), /subj-a\.peer/);
  assert.doesNotMatch(buildDeadlineInvocationId(ctx), /password|ssn/i);
  assert.deepEqual(
    buildInvalidToolArguments({ required: ["token"], properties: {} }),
    {},
  );
  assert.deepEqual(
    buildValidToolArguments({ required: ["token"], properties: {} }),
    { token: "probe.token.token" },
  );
});

test("edge: hasSchemaErrorDetails and hasTimeoutErrorDetails classify outputs", () => {
  assert.equal(hasSchemaErrorDetails({ kind: "schema", errors: [{ path: "x" }] }), true);
  assert.equal(hasSchemaErrorDetails("missing required argument 'token'"), true);
  assert.equal(hasSchemaErrorDetails({ code: 1 }), false);
  assert.equal(hasSchemaErrorDetails(null), false);
  assert.equal(hasTimeoutErrorDetails({ kind: "timeout", deadlineMs: 40 }), true);
  assert.equal(hasTimeoutErrorDetails("deadline exceeded"), true);
  assert.equal(hasTimeoutErrorDetails({ kind: "schema" }), false);
});

test("edge: independent factory runs share no mutable audit state", async () => {
  const factory = createWriteAheadToolHarnessFactory();
  const a = factory();
  const b = factory();
  await a.tools.invoke(
    {
      toolName: TOOL_WRITE_PROBE_NAME,
      arguments: { token: "probe.a" },
      invocationId: "inv-a",
    },
    500,
  );
  assert.ok(a.auditSink.records().some((r) => r.phase === "audit"));
  assert.equal(b.auditSink.records().length, 0);
  assert.notEqual(a, b);
});

test("edge: read-class invoke does not require write-ahead audit records", async () => {
  const harness = createWriteAheadToolHarnessFactory()();
  await harness.tools.invoke(
    {
      toolName: TOOL_READ_PROBE_NAME,
      arguments: { token: "probe.read" },
      invocationId: "inv-read",
    },
    500,
  );
  assert.equal(
    harness.auditSink.records().filter((r) => r.invocationId === "inv-read")
      .length,
    0,
  );
});

test("edge: concurrent write invokes keep audit-before-effect per invocation", async () => {
  const harness = createWriteAheadToolHarnessFactory()();
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      harness.tools.invoke(
        {
          toolName: TOOL_WRITE_PROBE_NAME,
          arguments: { token: `probe.${i}` },
          invocationId: `inv-write-${i}`,
        },
        500,
      ),
    ),
  );
  for (let i = 0; i < 8; i++) {
    const id = `inv-write-${i}`;
    const rows = harness.auditSink.records().filter((r) => r.invocationId === id);
    const auditIdx = rows.findIndex((r) => r.phase === "audit");
    const effectIdx = rows.findIndex((r) => r.phase === "effect");
    assert.ok(auditIdx >= 0 && effectIdx > auditIdx, id);
  }
});

test("edge: audit-after-effect still passes CK-07.1 when selected alone", async () => {
  const report = await runConformance({
    registry: createToolObligationsRegistry(),
    factory: createAuditAfterEffectToolHarnessFactory(),
    subjectId: "subj-audit-partial",
    obligationIds: [TOOL_OBLIGATION_IDS.argValidation],
  });
  assert.equal(report.exitCode, 0);
});

test("edge: concurrent invalid invokes stay typed errors (never throw)", async () => {
  const harness = createValidatingToolHarnessFactory()();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      harness.tools.invoke(
        {
          toolName: TOOL_PROBE_NAME,
          arguments: {},
          invocationId: `inv-conc-${i}`,
        },
        500,
      ),
    ),
  );
  assert.ok(results.every((r) => r.status === "error"));
  assert.ok(results.every((r) => hasSchemaErrorDetails(r.output)));
});

test("edge: reference hang probe returns typed timeout by deadline", async () => {
  const harness = createWriteAheadToolHarnessFactory()();
  const started = Date.now();
  const result = await harness.tools.invoke(
    {
      toolName: TOOL_HANG_PROBE_NAME,
      arguments: { token: "probe.hang" },
      invocationId: "inv-hang-ok",
    },
    TOOL_DEADLINE_PROBE_MS,
  );
  const elapsed = Date.now() - started;
  assert.equal(result.status, "error");
  assert.ok(hasTimeoutErrorDetails(result.output));
  assert.ok(
    elapsed < TOOL_DEADLINE_WATCHDOG_MS,
    `elapsed ${elapsed}ms must stay under watchdog ${TOOL_DEADLINE_WATCHDOG_MS}ms`,
  );
});

test("edge: hang fixture stays unresolved past probe deadline (then settles after watchdog)", async () => {
  const harness = createHangingToolHarnessFactory()();
  let settled = false;
  const p = harness.tools
    .invoke(
      {
        toolName: TOOL_HANG_PROBE_NAME,
        arguments: { token: "probe.hang.bad" },
        invocationId: "inv-hang-bad",
      },
      TOOL_DEADLINE_PROBE_MS,
    )
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise((r) => setTimeout(r, TOOL_DEADLINE_PROBE_MS + 20));
  assert.equal(settled, false);
  const late = await p;
  assert.equal(settled, true);
  assert.equal(late.status, "ok");
});

test("edge: catalog fixtures match named throw-on-invalid / audit-after-effect / hang", () => {
  assert.equal(
    TOOL_VIOLATION_FIXTURES.throwOnInvalid.fixtureId,
    "tool.violation.throw-on-invalid",
  );
  assert.equal(
    TOOL_VIOLATION_FIXTURES.auditAfterEffect.fixtureId,
    "tool.violation.audit-after-effect",
  );
  assert.equal(TOOL_VIOLATION_FIXTURES.hang.fixtureId, "tool.violation.hang");
});

test("edge: replay of CK-07.2 violation is idempotent", async () => {
  const opts = {
    registry: createWriteAheadAuditObligationRegistry(),
    factory: createAuditAfterEffectToolHarnessFactory(),
    subjectId: "subj-replay-audit",
  };
  const first = await runConformance(opts);
  const second = await runConformance(opts);
  assert.equal(first.exitCode, 1);
  assert.equal(second.exitCode, first.exitCode);
  assert.equal(second.failed, first.failed);
});

test("edge: replay of hang fixture isolation is idempotent", async () => {
  const fixture = TOOL_VIOLATION_FIXTURES.hang;
  const opts = {
    registry: createToolObligationsRegistry(),
    factory: fixture.createFactory(),
    subjectId: "subj-replay-hang-fixture",
  };
  const a = await runConformance(opts);
  const b = await runConformance(opts);
  assert.equal(a.exitCode, 1);
  assert.equal(b.exitCode, a.exitCode);
  assert.equal(a.failed, b.failed);
  assert.equal(a.passed, b.passed);
});
