/**
 * Worked example adoption checklist + orphan trainer-flag CI lint.
 * Run: pnpm --filter @moolam/learning build && node --test packages/learning/tests/research_intake_adoption.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESEARCH_RFC_ADOPTION_CHECKLIST_RELPATH,
  RESEARCH_RFC_TRAINER_FLAGS_OK_FIXTURE,
  RESEARCH_RFC_TRAINER_FLAGS_ORPHAN_FIXTURE,
  assertResearchIntakeAdoptionChecklistCoherent,
  evaluateResearchRfcAdoptionChecklist,
  lintResearchIntakeTrainerFlagsFixture,
  proveResearchIntakeAdoptionChecklist,
  resetResearchIntakeAdoptionState,
} from "../dist/research_intake_adoption.js";
import { ResearchIntakeRfcError } from "../dist/research_intake_rfc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEVICE_ID = "device.research-rfc.adoption.test";

const COMPLETE_STEPS = {
  approved: true,
  manifestUpdated: true,
  regenerated: true,
  microRunGreen: true,
  progressUpdated: true,
};

test("happy path: checklist coherent; full adoption + green flags", async () => {
  resetResearchIntakeAdoptionState();
  const events = [];
  const proved = await proveResearchIntakeAdoptionChecklist({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.docsCoherent, true);
  assert.equal(proved.adoptionAccepted, true);
  assert.equal(proved.greenFlagsOk, true);
  assert.equal(proved.orphanFlagsRejected, true);
  assert.ok(
    events.some(
      (event) =>
        event.action === "assert_adoption_checklist" && event.outcome === "ok",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.action === "evaluate_adoption" && event.status === "adopted",
    ),
  );
  assert.ok(events.some((event) => event.action === "ci_prove"));
  assert.ok(!JSON.stringify(events).includes("utterance"));
});

test("edge: incomplete checklist and silent emergency bypass rejected", async () => {
  resetResearchIntakeAdoptionState();
  const events = [];
  const proved = await proveResearchIntakeAdoptionChecklist({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(proved.incompleteRejected, true);
  assert.equal(proved.silentBypassRejected, true);
  assert.ok(
    events.some(
      (event) =>
        event.failureClass === "research_rfc.adoption_incomplete" ||
        event.failureClass === "research_rfc.silent_bypass_forbidden",
    ),
  );
});

test("edge: orphan trainer flags fail; ok fixture passes; replay idempotent", async () => {
  resetResearchIntakeAdoptionState();
  const green = await lintResearchIntakeTrainerFlagsFixture({
    repoRoot: REPO_ROOT,
    fixtureRelpath: RESEARCH_RFC_TRAINER_FLAGS_OK_FIXTURE,
    deviceId: DEVICE_ID,
  });
  assert.equal(green.ok, true);

  const orphan = await lintResearchIntakeTrainerFlagsFixture({
    repoRoot: REPO_ROOT,
    fixtureRelpath: RESEARCH_RFC_TRAINER_FLAGS_ORPHAN_FIXTURE,
    deviceId: DEVICE_ID,
  });
  assert.equal(orphan.ok, false);
  if (!orphan.ok) {
    assert.equal(orphan.failureClass, "research_rfc.orphan_trainer_flag");
  }

  const contaminated = evaluateResearchRfcAdoptionChecklist({
    request: {
      operationId: "op.rfc.adopt.raw",
      rfcId: "RFC-2026-004",
      steps: { ...COMPLETE_STEPS },
      commitCitesRfc: true,
      utterance: "must never appear",
      deviceId: DEVICE_ID,
    },
  });
  assert.equal(contaminated.ok, false);
  if (!contaminated.ok) {
    assert.equal(contaminated.failureClass, "research_rfc.sovereignty");
  }

  const first = evaluateResearchRfcAdoptionChecklist({
    request: {
      operationId: "op.rfc.adopt.replay",
      rfcId: "RFC-2026-004",
      steps: { ...COMPLETE_STEPS },
      commitCitesRfc: true,
      deviceId: DEVICE_ID,
    },
  });
  const second = evaluateResearchRfcAdoptionChecklist({
    request: {
      operationId: "op.rfc.adopt.replay",
      rfcId: "RFC-2026-004",
      steps: { ...COMPLETE_STEPS },
      commitCitesRfc: true,
      deviceId: DEVICE_ID,
    },
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok) assert.equal(first.idempotentReplay, false);
  if (second.ok) assert.equal(second.idempotentReplay, true);
});

test("sovereignty: checklist path resolves; missing root is policy gap", async () => {
  const coherent = await assertResearchIntakeAdoptionChecklistCoherent({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
  });
  assert.equal(coherent.ok, true, coherent.ok === false ? coherent.detail : "");
  assert.equal(
    RESEARCH_RFC_ADOPTION_CHECKLIST_RELPATH,
    "docs/learning/research-intake/ADOPTION_CHECKLIST.md",
  );

  await assert.rejects(
    async () => {
      const bad = await assertResearchIntakeAdoptionChecklistCoherent({
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
