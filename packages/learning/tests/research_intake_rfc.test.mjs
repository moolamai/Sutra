/**
 * Research-intake RFC template + review workflow coherence.
 * Run: pnpm --filter @moolam/learning build && node --test packages/learning/tests/research_intake_rfc.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESEARCH_RFC_GENERATOR_HOOK_RELPATH,
  RESEARCH_RFC_REVIEW_ROLES,
  RESEARCH_RFC_TEMPLATE_RELPATH,
  RESEARCH_RFC_WORKFLOW_RELPATH,
  ResearchIntakeRfcError,
  archiveRejectedRfcExperiment,
  assertResearchIntakeRfcDocumentsCoherent,
  evaluateResearchRfcApprovalGate,
  proveResearchIntakeRfcWorkflow,
  resetResearchIntakeRfcState,
} from "../dist/research_intake_rfc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEVICE_ID = "device.research-rfc.test";

test("happy path: docs coherent; complete RFC with experiment approves", async () => {
  resetResearchIntakeRfcState();
  const events = [];
  const proved = await proveResearchIntakeRfcWorkflow({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.docsCoherent, true);
  assert.equal(proved.happyApproved, true);
  assert.ok(
    RESEARCH_RFC_REVIEW_ROLES.includes("track-c-maintainer"),
  );
  assert.ok(
    events.some((event) => event.action === "assert_docs" && event.outcome === "ok"),
  );
  assert.ok(
    events.some(
      (event) =>
        event.action === "evaluate_gate" &&
        event.status === "approved" &&
        event.rfcId === "RFC-2026-001",
    ),
  );
  assert.ok(!JSON.stringify(events).includes("utterance"));
});

test("edge: incomplete template and silent emergency bypass rejected", async () => {
  resetResearchIntakeRfcState();
  const events = [];
  const proved = await proveResearchIntakeRfcWorkflow({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(proved.incompleteRejected, true);
  assert.equal(proved.silentBypassRejected, true);
  assert.equal(proved.rejectedArchived, true);
  assert.ok(
    events.some(
      (event) =>
        event.failureClass === "research_rfc.incomplete_template",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.failureClass === "research_rfc.silent_bypass_forbidden",
    ),
  );
});

test("edge: raw content in gate request is sovereignty failure; archive idempotent", () => {
  resetResearchIntakeRfcState();
  const contaminated = evaluateResearchRfcApprovalGate({
    request: {
      operationId: "op.rfc.raw",
      rfcId: "RFC-2026-010",
      status: "in_review",
      sections: {
        hypothesis: true,
        relatedWork: true,
        evalPlanVsChampion: true,
        rollbackPlan: true,
        manifestChangeList: true,
      },
      approvals: { "track-c-maintainer": "approve" },
      requiresSafetyReview: false,
      touchesConstitutionLaws: false,
      experiment: {
        completed: true,
        challengerStrictlyBeatsChampion: true,
        safetySuitesGreen: true,
      },
      manifestChangeCount: 1,
      utterance: "must never appear",
      deviceId: DEVICE_ID,
    },
  });
  assert.equal(contaminated.ok, false);
  if (!contaminated.ok) {
    assert.equal(contaminated.failureClass, "research_rfc.sovereignty");
  }

  const first = archiveRejectedRfcExperiment({
    operationId: "op.rfc.arch.1",
    rfcId: "RFC-2026-010",
    experimentReceiptId: "exp.010",
    deviceId: DEVICE_ID,
  });
  const second = archiveRejectedRfcExperiment({
    operationId: "op.rfc.arch.2",
    rfcId: "RFC-2026-010",
    experimentReceiptId: "exp.010",
    deviceId: DEVICE_ID,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.idempotentReplay, true);
});

test("sovereignty: document paths and cross-links resolve under repo root", async () => {
  const coherent = await assertResearchIntakeRfcDocumentsCoherent({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
  });
  assert.equal(coherent.ok, true, coherent.ok === false ? coherent.detail : "");
  assert.equal(
    RESEARCH_RFC_TEMPLATE_RELPATH,
    "docs/learning/research-intake/RFC_TEMPLATE.md",
  );
  assert.equal(
    RESEARCH_RFC_WORKFLOW_RELPATH,
    "docs/learning/research-intake/REVIEW_WORKFLOW.md",
  );
  assert.equal(
    RESEARCH_RFC_GENERATOR_HOOK_RELPATH,
    "docs/learning/research-intake/GENERATOR_HOOK.md",
  );

  await assert.rejects(
    async () => {
      const bad = await assertResearchIntakeRfcDocumentsCoherent({
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
