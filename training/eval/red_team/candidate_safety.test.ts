/**
 * Candidate red-team suite manifest (C7 pre-gate).
 * Run: node --experimental-strip-types --test training/eval/red_team/candidate_safety.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATE_RED_TEAM_FAMILIES,
  CANDIDATE_RED_TEAM_MANIFEST_RELPATH,
  CANDIDATE_RED_TEAM_SUITE_ID,
  CandidateSafetyContractError,
  assembleCandidateRedTeamSuite,
  assertCandidateRedTeamPreGate,
  loadCandidateRedTeamSuite,
  parseCandidateRedTeamManifest,
  parseCandidateRedTeamScenario,
  resetCandidateRedTeamLoadReceipts,
  type CandidateRedTeamTelemetryEvent,
} from "../../../packages/learning/dist/candidate_safety.js";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

test("happy path: suite loads with every constitutional family + B1 locality", async () => {
  resetCandidateRedTeamLoadReceipts();
  const events: CandidateRedTeamTelemetryEvent[] = [];
  const suite = await loadCandidateRedTeamSuite({
    repoRoot: REPO_ROOT,
    deviceId: "ci.red-team",
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(suite.manifest.suiteId, CANDIDATE_RED_TEAM_SUITE_ID);
  assert.equal(suite.suitePath, CANDIDATE_RED_TEAM_MANIFEST_RELPATH);
  assert.equal(suite.manifest.runBeforeEvalGates, true);
  assert.equal(suite.manifest.adapterChangeRequiresFullSuite, true);
  assert.equal(suite.scenarios.length, 5);

  const families = new Set(suite.scenarios.map((row) => row.family));
  for (const family of CANDIDATE_RED_TEAM_FAMILIES) {
    assert.ok(families.has(family), `missing ${family}`);
  }

  const locality = suite.scenarios.find(
    (row) => row.family === "locality_proof",
  );
  assert.ok(locality);
  assert.equal(locality.bindingProfile, "on-device-sovereign");
  assert.equal(locality.expectedOutcome, "zero_egress");
  assert.ok(locality.obligationRef);

  const overRefusal = suite.scenarios.find(
    (row) => row.family === "over_refusal",
  );
  assert.equal(overRefusal?.expectedOutcome, "allow");

  assert.ok(
    suite.scenarios.every((row) => row.adapterChangeRequiresFullSuite === true),
  );
  assert.ok(events.some((event) => event.outcome === "ok"));
  assert.ok(
    events.every(
      (event) =>
        !Object.keys(event).some((key) =>
          /utterance|promptBody|replyBody|secret/i.test(key),
        ),
    ),
  );
});

test("edge: over-refusal expecting refuse is rejected as hard as under-refusal", () => {
  const parsed = parseCandidateRedTeamScenario({
    schemaVersion: "candidate-red-team.scenario.v1",
    id: "bad-over-refusal",
    family: "over_refusal",
    scenarioDoc: "must expect allow",
    subjectId: "subj.x",
    deviceId: "dev.x",
    locality: "on-device",
    pinnedSeed: 1,
    probeRef: "probe.x",
    expectedOutcome: "refuse",
    adapterChangeRequiresFullSuite: true,
  });
  assert.equal(parsed.ok, false);
  assert.ok(parsed.detail.includes("over_refusal"));
});

test("edge: post-gate and adapter-shortcut manifests are defects", () => {
  const base = {
    schemaVersion: "candidate-red-team.suite.v1",
    suiteId: CANDIDATE_RED_TEAM_SUITE_ID,
    purpose: "test",
    version: 1,
    locality: "on-device",
    pinnedSeed: 1,
    requiredFamilies: [...CANDIDATE_RED_TEAM_FAMILIES],
    entries: CANDIDATE_RED_TEAM_FAMILIES.map((family, index) => ({
      id: `s${index}`,
      file: `scenarios/s${index}.json`,
      family,
      contentHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })),
  };

  const postGate = parseCandidateRedTeamManifest({
    ...base,
    runBeforeEvalGates: false,
    adapterChangeRequiresFullSuite: true,
  });
  assert.equal(postGate.ok, false);

  const shortcut = parseCandidateRedTeamManifest({
    ...base,
    runBeforeEvalGates: true,
    adapterChangeRequiresFullSuite: false,
  });
  assert.equal(shortcut.ok, false);

  const okManifest = parseCandidateRedTeamManifest({
    ...base,
    runBeforeEvalGates: true,
    adapterChangeRequiresFullSuite: true,
  });
  assert.equal(okManifest.ok, true);
  assert.throws(
    () =>
      assertCandidateRedTeamPreGate({
        ...okManifest.document,
        runBeforeEvalGates: true,
        adapterChangeRequiresFullSuite: false as true,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CandidateSafetyContractError);
      assert.equal(
        error.obligation,
        "candidate_safety.adapter_shortcut_forbidden",
      );
      return true;
    },
  );
});

test("edge: family gap and raw content are rejected; load is idempotent", async () => {
  resetCandidateRedTeamLoadReceipts();
  const gap = parseCandidateRedTeamManifest({
    schemaVersion: "candidate-red-team.suite.v1",
    suiteId: CANDIDATE_RED_TEAM_SUITE_ID,
    purpose: "gap",
    version: 1,
    runBeforeEvalGates: true,
    locality: "on-device",
    pinnedSeed: 1,
    requiredFamilies: [...CANDIDATE_RED_TEAM_FAMILIES],
    adapterChangeRequiresFullSuite: true,
    entries: [
      {
        id: "only-jailbreak",
        file: "scenarios/jailbreak-synthetic-01.json",
        family: "jailbreak",
        contentHash:
          "sha256:fc672806b1c67015e5753845b2f713d4c9db50449a7f140fd0316e5004724e9d",
      },
    ],
  });
  assert.equal(gap.ok, false);

  assert.throws(
    () =>
      parseCandidateRedTeamScenario({
        schemaVersion: "candidate-red-team.scenario.v1",
        id: "raw",
        family: "jailbreak",
        scenarioDoc: "raw",
        subjectId: "subj.x",
        deviceId: "dev.x",
        locality: "on-device",
        pinnedSeed: 1,
        probeRef: "probe.x",
        expectedOutcome: "refuse",
        adapterChangeRequiresFullSuite: true,
        promptBody: "must never appear",
      }),
    (error: unknown) => {
      assert.ok(error instanceof CandidateSafetyContractError);
      assert.equal(error.obligation, "candidate_safety.sovereignty");
      return true;
    },
  );
  assert.throws(
    () =>
      parseCandidateRedTeamScenario({
        schemaVersion: "candidate-red-team.scenario.v1",
        id: "raw2",
        family: "jailbreak",
        scenarioDoc: "raw",
        subjectId: "subj.x",
        deviceId: "dev.x",
        locality: "on-device",
        pinnedSeed: 1,
        probeRef: "probe.x",
        expectedOutcome: "refuse",
        adapterChangeRequiresFullSuite: true,
        utterance: "leak",
      }),
    (error: unknown) => {
      assert.ok(error instanceof CandidateSafetyContractError);
      assert.equal(error.obligation, "candidate_safety.sovereignty");
      return true;
    },
  );

  const events: CandidateRedTeamTelemetryEvent[] = [];
  const first = await assembleCandidateRedTeamSuite({
    repoRoot: REPO_ROOT,
    deviceId: "ci.idempotent",
    onTelemetry: (event) => events.push(event),
  });
  const second = await loadCandidateRedTeamSuite({
    repoRoot: REPO_ROOT,
    deviceId: "ci.idempotent",
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(first.manifestHash, second.manifestHash);
  assert.ok(events.some((event) => event.outcome === "idempotent_replay"));

  await assert.rejects(
    loadCandidateRedTeamSuite({
      repoRoot: REPO_ROOT,
      expectedSubjectId: "subject.other",
      deviceId: "ci.cross",
    }),
    (error: unknown) => {
      assert.ok(error instanceof CandidateSafetyContractError);
      assert.equal(error.obligation, "candidate_safety.cross_subject_denied");
      return true;
    },
  );
});
