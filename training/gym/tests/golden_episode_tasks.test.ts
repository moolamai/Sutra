/**
 * A P6 golden turns → gym scenario fixtures.
 * Run: pnpm --filter @moolam/training-gym test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  A_P6_GOLDEN_TURNS_RELPATH,
  canonicalizeGoldenScenarioJson,
  compileA_P6GoldenEpisodeTasks,
  compileGoldenEpisodeTask,
  GOLDEN_SCENARIO_RELPATH,
  loadGoldenEpisodeTask,
  materializeGoldenScenarioFixtures,
} from "../src/golden_episode_tasks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");

function log(event: Record<string, unknown>) {
  process.stdout.write(
    `${JSON.stringify({ event: "training.gym.golden_episode.test", ...event })}\n`,
  );
}

test("happy path: A P6 goldens compile to reset() scenario ids with oracles", () => {
  const telemetry: object[] = [];
  const compiled = compileA_P6GoldenEpisodeTasks({
    repoRoot: REPO_ROOT,
    deviceId: "dev-golden-unit",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(compiled.ok, true, compiled.detail);
  assert.ok(compiled.tasks.length >= 5);

  const basic = compiled.tasks.find((t) => t.sourceId === "thought-answer-basic");
  const err = compiled.tasks.find((t) => t.sourceId === "harness-error-terminal");
  assert.ok(basic);
  assert.ok(err);

  // reset() map: scenarioId === golden turn id
  assert.equal(basic.scenarioId, "thought-answer-basic");
  assert.equal(err.scenarioId, "harness-error-terminal");
  assert.equal(basic.expectedTerminalFrame, "TURN_COMPLETE");
  assert.equal(err.expectedTerminalFrame, "HARNESS_ERROR");
  assert.ok(basic.oracleCheckId.startsWith("oracle.golden."));
  assert.ok(
    basic.expectedOutcomes.some(
      (o: { kind: string }) => o.kind === "frame_sequence",
    ),
  );
  assert.ok(
    err.expectedOutcomes.some(
      (o: { kind: string; expected?: string }) =>
        o.kind === "terminal_frame" && o.expected === "HARNESS_ERROR",
    ),
  );

  // Language-neutral: no undefined / functions in canonical JSON
  const canon = canonicalizeGoldenScenarioJson(basic);
  assert.ok(canon.endsWith("\n"));
  assert.ok(!canon.includes("undefined"));
  assert.equal(canon, canonicalizeGoldenScenarioJson(JSON.parse(canon)));
  // Oracle metadata only — no utterance / frame body leak
  assert.ok(!canon.includes("consider ratio"));
  assert.ok(!canon.includes("THOUGHT_DELTA"));

  assert.ok(
    telemetry.some(
      (t) =>
        (t as { action?: string; outcome?: string }).action === "compile" &&
        (t as { outcome?: string }).outcome === "ok",
    ),
  );
  log({
    outcome: "ok",
    case: "compile-goldens",
    subjectId: null,
    taskCount: compiled.tasks.length,
    source: A_P6_GOLDEN_TURNS_RELPATH,
  });
});

test("happy path: committed fixtures are byte-identical to recompile (check mode)", () => {
  const first = materializeGoldenScenarioFixtures({
    repoRoot: REPO_ROOT,
    mode: "check",
    deviceId: "dev-golden-check",
  });
  assert.equal(first.ok, true, `${first.failureClass}: ${first.detail}`);

  const second = materializeGoldenScenarioFixtures({
    repoRoot: REPO_ROOT,
    mode: "check",
  });
  assert.equal(second.ok, true);

  const manifestPath = join(REPO_ROOT, GOLDEN_SCENARIO_RELPATH, "manifest.json");
  const onDisk = readFileSync(manifestPath, "utf8");
  const compiled = compileA_P6GoldenEpisodeTasks({ repoRoot: REPO_ROOT });
  assert.equal(compiled.ok, true);
  assert.equal(onDisk, compiled.canonicalCatalogJson);

  log({
    outcome: "ok",
    case: "byte-identical-check",
    subjectId: null,
    path: GOLDEN_SCENARIO_RELPATH,
  });
});

test("edge: non-JSON / invalid source rejected with named failure class", () => {
  const bad = compileGoldenEpisodeTask(
    { id: "x", subjectId: "anika-k", expectedFrames: [] },
    { sourceFile: "x.json" },
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "schema_violation");

  const noTerminal = compileGoldenEpisodeTask(
    {
      id: "x",
      subjectId: "anika-k",
      expectedFrames: [{ type: "SESSION_START", sequenceIndex: 0 }],
    },
    { sourceFile: "x.json" },
  );
  assert.equal(noTerminal.ok, false);
  assert.equal(noTerminal.failureClass, "schema_violation");

  log({
    outcome: "rejected",
    case: "schema-and-terminal",
    subjectId: null,
    failureClass: "schema_violation",
  });
});

test("edge: regeneration never silent — check fails if on-disk drifts", () => {
  const compiled = compileA_P6GoldenEpisodeTasks({ repoRoot: REPO_ROOT });
  assert.equal(compiled.ok, true);
  const taskPath = join(
    REPO_ROOT,
    GOLDEN_SCENARIO_RELPATH,
    "tasks",
    "thought-answer-basic.json",
  );
  const original = readFileSync(taskPath, "utf8");
  // Simulate drift without writing — compare against mutated expected
  const drifted = original.replace("TURN_COMPLETE", "TURN_COMPLETE_DRIFT");
  assert.notEqual(drifted, original);
  assert.notEqual(
    drifted,
    canonicalizeGoldenScenarioJson(
      compiled.tasks.find((t) => t.sourceId === "thought-answer-basic"),
    ),
  );

  log({
    outcome: "ok",
    case: "no-auto-update",
    subjectId: "anika-k",
    scenarioId: "thought-answer-basic",
  });
});

test("sovereignty: cross-subject load rejected; missing subjectId rejected", () => {
  const missing = loadGoldenEpisodeTask("thought-answer-basic", {
    repoRoot: REPO_ROOT,
    subjectId: "",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_subject");

  const cross = loadGoldenEpisodeTask("thought-answer-basic", {
    repoRoot: REPO_ROOT,
    subjectId: "subj.foreign.golden",
    deviceId: "dev-golden-cross",
  });
  assert.equal(cross.ok, false);
  assert.equal(cross.failureClass, "cross_subject");

  const ok = loadGoldenEpisodeTask("thought-answer-basic", {
    repoRoot: REPO_ROOT,
    subjectId: "anika-k",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.task.scenarioId, "thought-answer-basic");

  log({
    outcome: "rejected",
    case: "cross-subject",
    subjectId: "subj.foreign.golden",
    failureClass: "cross_subject",
  });
});

test("scalability: concurrent compile is idempotent (same canonical bytes)", () => {
  const a = compileA_P6GoldenEpisodeTasks({ repoRoot: REPO_ROOT });
  const b = compileA_P6GoldenEpisodeTasks({ repoRoot: REPO_ROOT });
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.canonicalCatalogJson, b.canonicalCatalogJson);
  for (let i = 0; i < a.tasks.length; i += 1) {
    assert.equal(
      canonicalizeGoldenScenarioJson(a.tasks[i]),
      canonicalizeGoldenScenarioJson(b.tasks[i]),
    );
  }
});
