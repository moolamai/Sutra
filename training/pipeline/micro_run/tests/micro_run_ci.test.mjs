/**
 * Micro-run CI: lineage assertion + broken GRPO fixture red→green prove.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  CHECKPOINT_LINEAGE_SCHEMA_VERSION,
  openCheckpointLineageRegistry,
} from "../../../../packages/learning/dist/index.js";
import { assertMicroRunLineageComplete } from "../assert_lineage.mjs";
import {
  MicroRunOrchestratorError,
  createMicroRunFlatCritic,
  formatOrchestratorFailure,
  runMicroRunOrchestrator,
} from "../orchestrate.mjs";
import { proveMicroRunCiGate } from "../prove_micro_run.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "../fixtures");

test("happy path: orchestrator + lineage assert complete", async () => {
  const events = [];
  const outDir = mkdtempSync(path.join(tmpdir(), "micro-run-ci-happy-"));
  const result = await runMicroRunOrchestrator({
    fixturesDir: FIXTURES,
    outDir,
    onTelemetry: (e) => events.push(e),
  });

  const asserted = assertMicroRunLineageComplete({
    outDir: result.outDir,
    subjectId: result.subjectId,
    deviceId: result.deviceId,
    lineageRunId: result.candidate.lineageRunId,
    checkpointHash: result.grpoCheckpointHash,
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(asserted.ok, true);
  assert.equal(asserted.complete, true);
  assert.equal(asserted.row.stage, "GRPO");
  assert.ok(asserted.row.criticVersions.length >= 1);
  assert.ok(
    events.some((e) => e.event === "training.micro_run.lineage_assert"),
  );
});

test("edge: flat-critic broken GRPO names stage=grpo with DIFF", async () => {
  await assert.rejects(
    () =>
      runMicroRunOrchestrator({
        fixturesDir: FIXTURES,
        outDir: mkdtempSync(path.join(tmpdir(), "micro-run-ci-flat-")),
        critic: createMicroRunFlatCritic(),
      }),
    (err) => {
      assert.ok(err instanceof MicroRunOrchestratorError);
      assert.equal(err.stage, "grpo");
      assert.equal(err.obligation, "micro_run.grpo_group");
      assert.ok(err.diff);
      const formatted = formatOrchestratorFailure(err);
      assert.match(formatted, /stage=grpo/);
      assert.match(formatted, /DIFF/);
      return true;
    },
  );
});

test("edge: incomplete lineage row fails assertion with stage=lineage", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "micro-run-ci-incomplete-"));
  const lineageDir = path.join(outDir, "lineage");
  const registry = openCheckpointLineageRegistry({
    backend: "fs",
    rootDir: lineageDir,
  });
  const incompleteHash =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  registry.appendCommitted({
    row: {
      schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      runId: "run.micro-run.incomplete",
      subjectId: "subj.micro.run",
      deviceId: "dev.micro.run",
      locality: "on-device",
      checkpointHash: incompleteHash,
      corpusManifestHash:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      baseModelHash:
        "ckpt:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      hyperparameters: { lr: 1e-4 },
      criticVersions: [],
      stage: "SFT",
      evalVerdicts: [],
      recordedAt: "2026-07-16T15:10:00.000Z",
    },
  });

  assert.throws(
    () =>
      assertMicroRunLineageComplete({
        outDir,
        subjectId: "subj.micro.run",
        deviceId: "dev.micro.run",
        lineageRunId: "run.micro-run.incomplete",
        checkpointHash: incompleteHash,
      }),
    (err) => {
      assert.ok(err instanceof MicroRunOrchestratorError);
      assert.equal(err.stage, "lineage");
      assert.equal(err.obligation, "micro_run.lineage_incomplete");
      assert.match(formatOrchestratorFailure(err), /stage=lineage/);
      assert.ok(err.diff?.includes("lineage.missing_critics"));
      return true;
    },
  );
});

test("sovereignty: lineage assert rejects cross-subject runId lookup", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "micro-run-ci-scope-"));
  const result = await runMicroRunOrchestrator({
    fixturesDir: FIXTURES,
    outDir,
  });

  assert.throws(
    () =>
      assertMicroRunLineageComplete({
        outDir: result.outDir,
        subjectId: "subj.other",
        deviceId: result.deviceId,
        lineageRunId: result.candidate.lineageRunId,
        checkpointHash: result.grpoCheckpointHash,
      }),
    (err) => {
      assert.ok(err instanceof MicroRunOrchestratorError);
      assert.equal(err.stage, "lineage");
      assert.ok(
        err.obligation === "micro_run.lineage_assert" ||
          err.obligation === "micro_run.subject_scope",
      );
      return true;
    },
  );
});

test("prove gate: green → broken GRPO red → green", async () => {
  const proved = await proveMicroRunCiGate();
  assert.equal(proved.ok, true);
  assert.equal(proved.lineageComplete, true);
  assert.equal(proved.violationRejected, true);
  assert.equal(proved.violationId, "broken-grpo-flat-critic");
  assert.equal(proved.grpoObligation, "micro_run.grpo_group");
});
