/**
 * Candidate red-team CI gate — constitutional erosion fixtures.
 * Run: node --experimental-strip-types --test training/eval/red_team/erosion_ci.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATE_RED_TEAM_CI_SCRIPT,
  CANDIDATE_RED_TEAM_EROSION_KINDS,
  CANDIDATE_RED_TEAM_FIXTURES_RELPATH,
  CANDIDATE_RED_TEAM_ORDER_BEFORE_SCRIPT,
  CandidateSafetyContractError,
  assertCandidateRedTeamRunsBeforeEvalGatesInCi,
  loadCandidateRedTeamErosionSuite,
  proveCandidateRedTeamCiGate,
  resetCandidateRedTeamLoadReceipts,
  resetCandidateRedTeamPreGateReceipts,
  type CandidateRedTeamTelemetryEvent,
} from "../../../packages/learning/dist/candidate_safety.js";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

test("happy path: erosion suite covers unsafe + locality + safe kinds", async () => {
  resetCandidateRedTeamLoadReceipts();
  resetCandidateRedTeamPreGateReceipts();
  const events: CandidateRedTeamTelemetryEvent[] = [];
  const suite = await loadCandidateRedTeamErosionSuite({
    repoRoot: REPO_ROOT,
    deviceId: "device.erosion.test",
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(suite.suitePath, `${CANDIDATE_RED_TEAM_FIXTURES_RELPATH}/manifest.json`);
  assert.equal(suite.manifest.runBeforeEvalGates, true);
  for (const kind of CANDIDATE_RED_TEAM_EROSION_KINDS) {
    assert.ok(
      suite.fixtures.some((fixture) => fixture.kind === kind),
      `missing kind ${kind}`,
    );
  }
  assert.ok(events.some((event) => event.action === "erosion_fixture"));
});

test("CI prove: unsafe + locality fail; safe passes; ordering + kill-switch", async () => {
  const events: CandidateRedTeamTelemetryEvent[] = [];
  const proved = await proveCandidateRedTeamCiGate({
    repoRoot: REPO_ROOT,
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(proved.ok, true);
  assert.ok(proved.unsafeBlocked.includes("unsafe-jailbreak-allow"));
  assert.ok(proved.unsafeBlocked.includes("unsafe-over-refusal"));
  assert.deepEqual([...proved.localityBlocked], ["locality-egress"]);
  assert.equal(proved.safePassed, "safe-baseline");
  assert.equal(proved.scenarioCount, 5);
  assert.equal(proved.orderingOk, true);
  assert.equal(proved.killSwitchBaseline, true);
  assert.equal(CANDIDATE_RED_TEAM_CI_SCRIPT, "red-team:check");
  assert.equal(CANDIDATE_RED_TEAM_ORDER_BEFORE_SCRIPT, "surgery:check");
  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.candidate_red_team.ci_gate" &&
        event.runBeforeEvalGates === true,
    ),
  );
});

test("edge: CI ordering violation and post-gate ordering named", () => {
  assert.throws(
    () =>
      assertCandidateRedTeamRunsBeforeEvalGatesInCi(
        "pnpm --filter @moolam/learning surgery:check\npnpm --filter @moolam/learning red-team:check\n",
      ),
    (error: unknown) => {
      assert.ok(error instanceof CandidateSafetyContractError);
      assert.equal(error.obligation, "candidate_safety.ordering_violation");
      return true;
    },
  );

  assert.throws(
    () =>
      assertCandidateRedTeamRunsBeforeEvalGatesInCi(
        "pnpm --filter @moolam/learning surgery:check\n",
      ),
    (error: unknown) => {
      assert.ok(error instanceof CandidateSafetyContractError);
      assert.equal(error.obligation, "candidate_safety.ordering_violation");
      return true;
    },
  );
});
