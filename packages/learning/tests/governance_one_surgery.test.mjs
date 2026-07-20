/**
 * One-surgery-per-stage promotion-candidate linter (constitution L1).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROMOTION_CANDIDATE_OK_FIXTURE,
  PROMOTION_CANDIDATE_VIOLATION_FIXTURE,
  SURGERY_COMPONENT_CLASSES,
  assertOneSurgeryPerStage,
  lintPromotionCandidateFixture,
  lintPromotionCandidateManifest,
  proveOneSurgeryPromotionLint,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "learning.governance.test", ...event })}\n`,
  );
}

test("happy path: single-surgery candidate lint + CI prove green→red", async () => {
  const telemetry = [];
  const prove = await proveOneSurgeryPromotionLint({
    repoRoot: REPO_ROOT,
    deviceId: "dev-surgery-unit",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(prove.ok, true, prove.detail);
  assert.ok(prove.greenStageId.includes("adapter"));
  assert.ok(prove.redStageId.length > 0);

  const green = await lintPromotionCandidateFixture({
    repoRoot: REPO_ROOT,
    fixtureFile: PROMOTION_CANDIDATE_OK_FIXTURE,
  });
  assert.equal(green.ok, true);
  assert.deepEqual(green.manifest.surgeryClasses, ["adapter"]);
  assert.ok(
    SURGERY_COMPONENT_CLASSES.includes(green.manifest.surgeryClasses[0]),
  );

  assert.ok(
    telemetry.some((t) => t.action === "ci_prove" && t.outcome === "ok"),
  );
  assert.ok(!JSON.stringify(telemetry).includes("utterance"));
  log({
    outcome: "ok",
    case: "prove-green-red",
    subjectId: null,
    greenStageId: prove.greenStageId,
  });
});

test("edge: multi-surgery violation fixture fails attribution_void", async () => {
  const telemetry = [];
  const red = await lintPromotionCandidateFixture({
    repoRoot: REPO_ROOT,
    fixtureFile: PROMOTION_CANDIDATE_VIOLATION_FIXTURE,
    deviceId: "dev-surgery-void",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(red.ok, false);
  assert.equal(red.failureClass, "attribution_void");
  assert.ok(red.detail.includes("surgery") || red.detail.includes("class"));
  assert.ok(
    telemetry.some(
      (t) =>
        t.failureClass === "attribution_void" &&
        (t.action === "one_surgery" || t.action === "lint_candidate"),
    ),
  );
  log({
    outcome: "rejected",
    case: "multi-surgery",
    subjectId: null,
    failureClass: "attribution_void",
    stageId: red.stageId,
  });
});

test("edge: unknown surgery class / empty classes are schema_violation", () => {
  const unknown = assertOneSurgeryPerStage(["adapter_lora"], {
    subjectId: null,
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.failureClass, "schema_violation");

  const empty = assertOneSurgeryPerStage([], { subjectId: null });
  assert.equal(empty.ok, false);
  assert.equal(empty.failureClass, "schema_violation");

  const multi = assertOneSurgeryPerStage(["adapter", "policy"], {
    subjectId: null,
  });
  assert.equal(multi.ok, false);
  assert.equal(multi.failureClass, "attribution_void");
});

test("sovereignty: expectedSubjectId mismatch is cross_subject", () => {
  const raw = {
    schemaVersion: "promotion-candidate.v1",
    stageId: "stage-subj",
    surgeryClasses: ["mix"],
    subjectId: "subj-a",
    locality: "self-hosted",
  };
  const ok = lintPromotionCandidateManifest(raw, {
    expectedSubjectId: "subj-a",
    deviceId: "dev-iso",
  });
  assert.equal(ok.ok, true);

  const cross = lintPromotionCandidateManifest(raw, {
    expectedSubjectId: "subj-b",
    deviceId: "dev-iso",
  });
  assert.equal(cross.ok, false);
  assert.equal(cross.failureClass, "cross_subject");
  assert.equal(cross.subjectId, "subj-b");
  log({
    outcome: "rejected",
    case: "cross-subject",
    subjectId: "subj-b",
    failureClass: "cross_subject",
  });
});

test("scalability / idempotency: prove is read-only and reentrant", async () => {
  const first = await proveOneSurgeryPromotionLint({
    repoRoot: REPO_ROOT,
    deviceId: "dev-surgery-idem-1",
  });
  const second = await proveOneSurgeryPromotionLint({
    repoRoot: REPO_ROOT,
    deviceId: "dev-surgery-idem-2",
  });
  assert.equal(first.ok, true, first.detail);
  assert.equal(second.ok, true, second.detail);
  assert.equal(first.greenStageId, second.greenStageId);
});

test("edge: digest keys outside surgeryClasses void attribution", () => {
  const leaked = lintPromotionCandidateManifest(
    {
      schemaVersion: "promotion-candidate.v1",
      stageId: "stage-digest-leak",
      surgeryClasses: ["adapter"],
      subjectId: null,
      locality: "on-device",
      componentDigests: {
        adapter: "sha256:aa",
        critic: "sha256:bb",
      },
    },
    { deviceId: "dev-digest" },
  );
  assert.equal(leaked.ok, false);
  assert.equal(leaked.failureClass, "attribution_void");
});
