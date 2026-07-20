/**
 * Lineage completeness linter + candidate emission CI gate (C4).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKPOINT_LINEAGE_FIXTURE_DIR,
  CHECKPOINT_LINEAGE_SCHEMA_VERSION,
  CHECKPOINT_LINEAGE_VIOLATION_MISSING_CRITICS,
  CheckpointLineageContractError,
  admitCandidateEmission,
  admitCandidateEmissionOrThrow,
  lintCheckpointLineageCompleteness,
  openCheckpointLineageRegistry,
  proveCheckpointLineageCompletenessGateCi,
  proveCheckpointLineageSchemaMicroRun,
  resetCheckpointLineageBackendLog,
  resetCheckpointLineageCandidateCache,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const CORPUS =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CRITIC =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("happy path: completeness CI gate — fixture red, micro-run admits", () => {
  resetCheckpointLineageBackendLog();
  resetCheckpointLineageCandidateCache();
  const events = [];
  const proved = proveCheckpointLineageCompletenessGateCi({
    repoRoot: REPO_ROOT,
    subjectId: "subj.lineage.gate.happy",
    deviceId: "dev.lineage.gate.happy",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.violationFailureClass, "lineage.missing_critics");
  assert.equal(proved.microRunAdmitted, true);
  assert.equal(proved.missingRowDenied, true);
  assert.ok(events.some((e) => e.event === "learning.lineage.lint"));
  assert.ok(events.some((e) => e.event === "learning.lineage.candidate_admit"));
  assert.equal(
    /utterance|keystroke|rawContent/i.test(JSON.stringify(events)),
    false,
  );
});

test("edge: missing criticVersions fixture fails completeness lint", () => {
  const raw = JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        CHECKPOINT_LINEAGE_FIXTURE_DIR,
        CHECKPOINT_LINEAGE_VIOLATION_MISSING_CRITICS,
      ),
      "utf8",
    ),
  );
  const linted = lintCheckpointLineageCompleteness(raw, {
    subjectId: "subj.lineage.gate",
    deviceId: "dev",
  });
  assert.equal(linted.ok, false);
  assert.equal(linted.failureClass, "lineage.missing_critics");
});

test("edge: empty hyperparameters fails completeness", () => {
  const linted = lintCheckpointLineageCompleteness(
    {
      schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      runId: "run.no.hypers",
      subjectId: "subj.x",
      deviceId: "dev",
      locality: "on-device",
      checkpointHash: "ckpt:sha256:nohyper000000001",
      corpusManifestHash: CORPUS,
      baseModelHash: "base:sha256:model0000000001",
      hyperparameters: {},
      criticVersions: [
        {
          rubricId: "rubric.core",
          rubricVersion: "1.0.0",
          contentHash: CRITIC,
        },
      ],
      stage: "SFT",
      evalVerdicts: [],
      recordedAt: "2026-07-16T14:10:00.000Z",
    },
    { subjectId: "subj.x", deviceId: "dev" },
  );
  assert.equal(linted.ok, false);
  assert.equal(linted.failureClass, "lineage.missing_hyperparameters");
});

test("edge: candidate emission without lineage row denied", () => {
  resetCheckpointLineageCandidateCache();
  const reg = openCheckpointLineageRegistry({ backend: "memory" });
  const denied = admitCandidateEmission(
    {
      candidateId: "cand.orphan",
      subjectId: "subj.orphan",
      deviceId: "dev",
      lineageRunId: "run.missing",
      checkpointHash: "ckpt:sha256:orphan0000000001",
    },
    reg,
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.failureClass, "lineage.empty");
});

test("sovereignty: cross-subject lint scope rejected", () => {
  const row = {
    schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
    runId: "run.scope",
    subjectId: "subj.A",
    deviceId: "dev",
    locality: "on-device",
    checkpointHash: "ckpt:sha256:scope00000000001",
    corpusManifestHash: CORPUS,
    baseModelHash: "base:sha256:model0000000001",
    hyperparameters: { lr: 1e-4 },
    criticVersions: [
      {
        rubricId: "rubric.core",
        rubricVersion: "1.0.0",
        contentHash: CRITIC,
      },
    ],
    stage: "SFT",
    evalVerdicts: [],
    recordedAt: "2026-07-16T14:20:00.000Z",
  };
  const linted = lintCheckpointLineageCompleteness(row, {
    subjectId: "subj.B",
    deviceId: "dev",
  });
  assert.equal(linted.ok, false);
  assert.equal(linted.failureClass, "lineage.subject_scope");
});

test("idempotent candidate admit replay", () => {
  resetCheckpointLineageBackendLog();
  resetCheckpointLineageCandidateCache();
  const proved = proveCheckpointLineageSchemaMicroRun({
    subjectId: "subj.lineage.idem",
    deviceId: "dev.idem",
  });
  const req = {
    candidateId: "cand.idem.1",
    subjectId: "subj.lineage.idem",
    deviceId: "dev.idem",
    lineageRunId: proved.grpo.runId,
    checkpointHash: proved.grpo.checkpointHash,
  };
  const first = admitCandidateEmissionOrThrow(req, proved.registry);
  const again = admitCandidateEmissionOrThrow(req, proved.registry);
  assert.equal(first.idempotentReplay, false);
  assert.equal(again.idempotentReplay, true);
  assert.throws(
    () =>
      admitCandidateEmissionOrThrow(
        {
          ...req,
          checkpointHash: "ckpt:sha256:conflict00000001",
        },
        proved.registry,
      ),
    (err) =>
      err instanceof CheckpointLineageContractError &&
      err.obligation === "lineage.idempotent_conflict",
  );
});

test("integration: write → reopen path still admits from complete tip", () => {
  resetCheckpointLineageCandidateCache();
  resetCheckpointLineageBackendLog();
  const events = [];
  const proved = proveCheckpointLineageSchemaMicroRun({
    subjectId: "subj.lineage.reopen",
    deviceId: "dev.reopen",
    onTelemetry: (e) => events.push(e),
  });
  // In-memory restart simulation: list + re-admit from committed tip.
  const tip = proved.registry.listCommitted({
    subjectId: "subj.lineage.reopen",
    deviceId: "dev.reopen",
  });
  assert.ok(tip.length >= 1);
  const last = tip[tip.length - 1];
  const linted = lintCheckpointLineageCompleteness(last, {
    subjectId: "subj.lineage.reopen",
    deviceId: "dev.reopen",
  });
  assert.equal(linted.ok, true);
  const admitted = admitCandidateEmission(
    {
      candidateId: "cand.after.restart",
      subjectId: "subj.lineage.reopen",
      deviceId: "dev.reopen",
      lineageRunId: last.runId,
      checkpointHash: last.checkpointHash,
    },
    proved.registry,
  );
  assert.equal(admitted.ok, true);
});
