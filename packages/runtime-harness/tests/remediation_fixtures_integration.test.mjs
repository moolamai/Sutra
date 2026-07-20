/**
 * Forbidden-action and within-budget remediation integration fixtures.
 * Run: node --experimental-strip-types --test packages/runtime-harness/tests/remediation_fixtures_integration.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRemediationFixtures,
  proveRemediationFixturesCi,
} from "../../../training/self_healing/remediation_policy.ts";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

test("remediation fixtures: permission widen refused; within budget; exhaust disables", async () => {
  const fixtures = loadRemediationFixtures({ repoRoot: REPO_ROOT });
  assert.ok(fixtures.some((fixture) => fixture.id === "permission-widen-refused"));
  assert.ok(fixtures.some((fixture) => fixture.id === "seeded-within-budget"));
  assert.ok(fixtures.some((fixture) => fixture.id === "exhausted-disables"));
  assert.ok(
    !JSON.stringify(fixtures).includes("utterance"),
    "fixtures must stay metadata-only",
  );

  const events = [];
  const proved = await proveRemediationFixturesCi({
    repoRoot: REPO_ROOT,
    deviceId: "ci-remediation-integration",
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.permissionWidenRefused, true);
  assert.equal(proved.withinBudgetOk, true);
  assert.equal(proved.exhaustedDisablesOk, true);
  assert.ok(proved.refuseFixtureIds.includes("permission-widen-refused"));
  assert.ok(proved.refuseFixtureIds.includes("skip-approval-refused"));
  assert.ok(proved.remediateFixtureIds.includes("seeded-within-budget"));
  assert.ok(proved.remediateFixtureIds.includes("triage-suppressed"));
  assert.ok(proved.remediateFixtureIds.includes("version-winner-idempotent"));
  assert.ok(proved.exhaustFixtureIds.includes("exhausted-disables"));

  assert.ok(
    events.some(
      (event) =>
        event.event === "runtime.harness.remediation_fixture" &&
        event.outcome === "ok" &&
        event.fixtureId === "prove.all",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.event === "runtime.harness.remediation_fixture" &&
        event.fixtureId === "permission-widen-refused",
    ),
  );
  assert.ok(!JSON.stringify(events).includes("secret"));
  assert.ok(
    events.every(
      (event) =>
        typeof event.subjectId === "string" &&
        typeof event.deviceId === "string",
    ),
  );
});
