/**
 * Micro-run end-to-end orchestrator.
 * Run: pnpm --filter @moolam/training-pipeline micro-run:test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MicroRunOrchestratorError,
  formatOrchestratorFailure,
  runMicroRunOrchestrator,
} from "../orchestrate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "../fixtures");

test("happy path: SFT → rollout → GRPO → lineage → candidate", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "micro-run-orch-"));
  const events = [];
  try {
    const result = await runMicroRunOrchestrator({
      fixturesDir: FIXTURES,
      outDir,
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(result.ok, true);
    assert.match(result.sftCheckpointHash, /sha256:|[a-f0-9]{8}/i);
    assert.match(result.grpoCheckpointHash, /^sha256:/);
    assert.equal(result.candidate.stagesCompleted.length, 6);
    const artifact = JSON.parse(readFileSync(result.candidatePath, "utf8"));
    assert.equal(artifact.candidateId, result.candidate.candidateId);
    assert.equal(artifact.subjectId, "subj.micro.run");
    assert.ok(events.some((e) => e.stage === "sft" || e.orchStage === "sft"));
    assert.ok(events.some((e) => e.stage === "grpo" || e.orchStage === "grpo"));
    assert.ok(
      events.some((e) => e.stage === "lineage" || e.orchStage === "lineage"),
    );
    assert.equal(
      /utterance|keystroke|rawContent/i.test(JSON.stringify(events)),
      false,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("edge: injected SFT failure prints stage + checkpoint hash", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "micro-run-fail-sft-"));
  try {
    await assert.rejects(
      () =>
        runMicroRunOrchestrator({
          fixturesDir: FIXTURES,
          outDir,
          failAt: "sft",
        }),
      (err) => {
        assert.ok(err instanceof MicroRunOrchestratorError);
        assert.equal(err.stage, "sft");
        assert.equal(err.obligation, "micro_run.injected_fail");
        assert.ok(err.checkpointHash);
        const formatted = formatOrchestratorFailure(err);
        assert.match(formatted, /stage=sft/);
        assert.match(formatted, /checkpointHash=/);
        return true;
      },
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("edge: wall-clock budget exceeded names deadline stage with DIFF", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "micro-run-deadline-"));
  try {
    await assert.rejects(
      () =>
        runMicroRunOrchestrator({
          fixturesDir: FIXTURES,
          outDir,
          wallClockMs: 0,
        }),
      (err) => {
        assert.ok(err instanceof MicroRunOrchestratorError);
        assert.equal(err.stage, "deadline");
        assert.equal(err.obligation, "micro_run.wall_clock");
        assert.ok(err.diff?.includes("budgetMs=0"));
        return true;
      },
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("sovereignty: subjectId is scoped through candidate artifact", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "micro-run-scope-"));
  try {
    const result = await runMicroRunOrchestrator({
      fixturesDir: FIXTURES,
      outDir,
    });
    assert.equal(result.subjectId, "subj.micro.run");
    assert.equal(result.candidate.subjectId, "subj.micro.run");
    assert.equal(result.candidate.locality, "on-device");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
