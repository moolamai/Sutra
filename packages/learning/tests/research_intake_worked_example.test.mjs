/**
 * Worked example RFC (GRPO G=8→G=6) coherence + gate edges.
 * Run: pnpm --filter @moolam/learning build && node --test packages/learning/tests/research_intake_worked_example.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESEARCH_RFC_WORKED_CHALLENGER_G,
  RESEARCH_RFC_WORKED_CHAMPION_G,
  RESEARCH_RFC_WORKED_CLIP_EPS,
  RESEARCH_RFC_WORKED_EXAMPLE_ID,
  RESEARCH_RFC_WORKED_EXAMPLE_RELPATH,
  assertResearchIntakeWorkedExampleCoherent,
  evaluateGrpoHyperparameterExperimentProposal,
  proveResearchIntakeWorkedExample,
  resetResearchIntakeWorkedExampleState,
} from "../dist/research_intake_worked_example.js";
import { ResearchIntakeRfcError } from "../dist/research_intake_rfc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEVICE_ID = "device.research-rfc.worked.test";

test("happy path: worked RFC coherent; G=8→G=6 proposal accepted", async () => {
  resetResearchIntakeWorkedExampleState();
  const events = [];
  const proved = await proveResearchIntakeWorkedExample({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.docsCoherent, true);
  assert.equal(proved.proposalAccepted, true);
  assert.equal(proved.gateWouldApproveWithExperiment, true);
  assert.equal(RESEARCH_RFC_WORKED_CHAMPION_G, 8);
  assert.equal(RESEARCH_RFC_WORKED_CHALLENGER_G, 6);
  assert.equal(RESEARCH_RFC_WORKED_CLIP_EPS, 0.2);
  assert.ok(
    events.some(
      (event) =>
        event.action === "assert_worked_example" &&
        event.outcome === "ok" &&
        event.rfcId === RESEARCH_RFC_WORKED_EXAMPLE_ID,
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.action === "evaluate_grpo_proposal" &&
        event.status === "experiment_running",
    ),
  );
  assert.ok(!JSON.stringify(events).includes("utterance"));
});

test("edge: wrong challenger G and silent emergency bypass rejected", async () => {
  resetResearchIntakeWorkedExampleState();
  const events = [];
  const proved = await proveResearchIntakeWorkedExample({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(proved.incompleteProposalRejected, true);
  assert.equal(proved.silentBypassRejected, true);
  assert.equal(proved.rejectedArchived, true);
  assert.ok(
    events.some(
      (event) =>
        event.failureClass === "research_rfc.incomplete_template" ||
        event.failureClass === "research_rfc.silent_bypass_forbidden",
    ),
  );
});

test("edge: raw content in proposal is sovereignty failure; replay idempotent", () => {
  resetResearchIntakeWorkedExampleState();
  const contaminated = evaluateGrpoHyperparameterExperimentProposal({
    request: {
      operationId: "op.rfc.worked.raw",
      rfcId: RESEARCH_RFC_WORKED_EXAMPLE_ID,
      championGroupSize: 8,
      challengerGroupSize: 6,
      clipEps: 0.2,
      surgeryClass: "adapter",
      manifestPaths: ["docs/stages/tracks/_generator/track-c/c4.mjs"],
      microRunDocumented: true,
      utterance: "must never appear",
      deviceId: DEVICE_ID,
    },
  });
  assert.equal(contaminated.ok, false);
  if (!contaminated.ok) {
    assert.equal(contaminated.failureClass, "research_rfc.sovereignty");
  }

  const first = evaluateGrpoHyperparameterExperimentProposal({
    request: {
      operationId: "op.rfc.worked.replay",
      rfcId: RESEARCH_RFC_WORKED_EXAMPLE_ID,
      championGroupSize: 8,
      challengerGroupSize: 6,
      clipEps: 0.2,
      surgeryClass: "adapter",
      manifestPaths: ["docs/stages/tracks/_generator/track-c/c4.mjs"],
      microRunDocumented: true,
      deviceId: DEVICE_ID,
    },
  });
  const second = evaluateGrpoHyperparameterExperimentProposal({
    request: {
      operationId: "op.rfc.worked.replay",
      rfcId: RESEARCH_RFC_WORKED_EXAMPLE_ID,
      championGroupSize: 8,
      challengerGroupSize: 6,
      clipEps: 0.2,
      surgeryClass: "adapter",
      manifestPaths: ["docs/stages/tracks/_generator/track-c/c4.mjs"],
      microRunDocumented: true,
      deviceId: DEVICE_ID,
    },
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok) assert.equal(first.idempotentReplay, false);
  if (second.ok) assert.equal(second.idempotentReplay, true);
});

test("sovereignty: worked-example path resolves; missing root is policy gap", async () => {
  const coherent = await assertResearchIntakeWorkedExampleCoherent({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
  });
  assert.equal(coherent.ok, true, coherent.ok === false ? coherent.detail : "");
  assert.equal(
    RESEARCH_RFC_WORKED_EXAMPLE_RELPATH,
    "docs/learning/research-intake/rfcs/RFC-2026-004-grpo-g8-to-g6.md",
  );

  await assert.rejects(
    async () => {
      const bad = await assertResearchIntakeWorkedExampleCoherent({
        repoRoot: path.join(REPO_ROOT, "does-not-exist"),
        deviceId: DEVICE_ID,
      });
      if (!bad.ok) {
        throw new ResearchIntakeRfcError(bad.detail, {
          obligation: bad.failureClass,
        });
      }
    },
    (error) =>
      error instanceof ResearchIntakeRfcError &&
      error.obligation === "research_rfc.policy_gap",
  );
});
