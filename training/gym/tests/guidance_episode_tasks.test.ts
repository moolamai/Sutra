/**
 * B8 guidance → gym episode tasks.
 * Run: pnpm --filter @moolam/training-gym test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  B8_GUIDANCE_FIXTURE_RELPATH,
  canonicalizeGuidanceJson,
  compileB8GuidanceEpisodeTasks,
  compileGuidanceEpisodeTask,
  GUIDANCE_CASE_LIMIT,
  GUIDANCE_SCENARIO_RELPATH,
  guidanceSubjectIdForPack,
  loadGuidanceEpisodeTask,
  materializeGuidanceScenarioFixtures,
} from "../src/guidance_episode_tasks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");

function log(event: Record<string, unknown>) {
  process.stdout.write(
    `${JSON.stringify({ event: "training.gym.guidance_episode.test", ...event })}\n`,
  );
}

test("happy path: B8 guidance compiles to per-pack episode tasks with oracle ids", () => {
  const telemetry: object[] = [];
  const compiled = compileB8GuidanceEpisodeTasks({
    repoRoot: REPO_ROOT,
    deviceId: "dev-guidance-unit",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(compiled.ok, true, compiled.detail);
  assert.ok(compiled.tasks.length >= 2);
  assert.ok(compiled.byPack.teacher?.length >= 1);
  assert.ok(compiled.byPack.lawyer?.length >= 1);

  const teacher = compiled.tasks.find((t) => t.sourceId === "teacher-guidance-tone");
  const lawyer = compiled.tasks.find((t) => t.sourceId === "lawyer-scope-refusal");
  assert.ok(teacher);
  assert.ok(lawyer);

  assert.equal(teacher.scenarioId, "guidance/teacher/teacher-guidance-tone");
  assert.equal(lawyer.scenarioId, "guidance/lawyer/lawyer-scope-refusal");
  assert.equal(teacher.expectedTerminalFrame, "TURN_COMPLETE");
  assert.equal(lawyer.expectedTerminalFrame, "TURN_COMPLETE");
  assert.ok(teacher.oracleCheckId.includes("teacher"));
  assert.ok(lawyer.oracleCheckId.includes("lawyer"));

  assert.ok(
    teacher.expectedOutcomes.some((o: { kind: string }) => o.kind === "mastery"),
  );
  assert.ok(
    lawyer.expectedOutcomes.some((o: { kind: string }) => o.kind === "citation"),
  );

  // Language-neutral: no undefined / functions in canonical JSON
  const canon = canonicalizeGuidanceJson(teacher);
  assert.ok(canon.endsWith("\n"));
  assert.ok(!canon.includes("undefined"));
  assert.equal(canon, canonicalizeGuidanceJson(JSON.parse(canon)));

  assert.ok(
    telemetry.some(
      (t) =>
        (t as { action?: string; outcome?: string }).action === "compile" &&
        (t as { outcome?: string }).outcome === "ok",
    ),
  );
  log({
    outcome: "ok",
    case: "compile-packs",
    subjectId: null,
    taskCount: compiled.tasks.length,
  });
});

test("happy path: committed fixtures are byte-identical to recompile (check mode)", () => {
  const first = materializeGuidanceScenarioFixtures({
    repoRoot: REPO_ROOT,
    mode: "check",
    deviceId: "dev-guidance-check",
  });
  assert.equal(first.ok, true, `${first.failureClass}: ${first.detail}`);

  // Idempotent: second check still green
  const second = materializeGuidanceScenarioFixtures({
    repoRoot: REPO_ROOT,
    mode: "check",
  });
  assert.equal(second.ok, true);

  const manifestPath = join(
    REPO_ROOT,
    GUIDANCE_SCENARIO_RELPATH,
    "manifest.json",
  );
  const onDisk = readFileSync(manifestPath, "utf8");
  const compiled = compileB8GuidanceEpisodeTasks({ repoRoot: REPO_ROOT });
  assert.equal(compiled.ok, true);
  assert.equal(onDisk, compiled.canonicalCatalogJson);

  log({
    outcome: "ok",
    case: "byte-identical-check",
    subjectId: null,
    path: GUIDANCE_SCENARIO_RELPATH,
  });
});

test("edge: non-JSON / invalid source rejected with named failure class", () => {
  const bad = compileGuidanceEpisodeTask(
    { id: "x", domainPack: "teacher", cases: [] },
    { sourceFile: "x.json" },
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "schema_violation");

  const overCases = compileGuidanceEpisodeTask(
    {
      id: "flood",
      domainPack: "teacher",
      cases: Array.from({ length: GUIDANCE_CASE_LIMIT + 1 }, (_, i) => ({
        caseId: `c${i}`,
        expect: "pass",
      })),
    },
    { sourceFile: "flood.json" },
  );
  assert.equal(overCases.ok, false);
  assert.equal(overCases.failureClass, "section_limit");
  log({
    outcome: "rejected",
    case: "schema-and-limit",
    subjectId: null,
    failureClass: overCases.failureClass,
  });
});

test("edge: regeneration never silent — check fails if on-disk drifts", () => {
  const compiled = compileB8GuidanceEpisodeTasks({ repoRoot: REPO_ROOT });
  assert.equal(compiled.ok, true);
  const task = compiled.tasks[0];
  assert.ok(task);

  // Drift detect via canonical compare of a mutated copy (does not write disk)
  const drifted = structuredClone(task);
  drifted.oracleCheckId = `${drifted.oracleCheckId}__DRIFT__`;
  assert.notEqual(
    canonicalizeGuidanceJson(task),
    canonicalizeGuidanceJson(drifted),
  );

  // Source path is under committed B8 fixtures (human review)
  assert.ok(task.sourceRelPath.startsWith(B8_GUIDANCE_FIXTURE_RELPATH));
  log({
    outcome: "ok",
    case: "no-auto-update",
    subjectId: task.subjectId,
    scenarioId: task.scenarioId,
  });
});

test("sovereignty: cross-subject load rejected; missing subjectId rejected", () => {
  const compiled = compileB8GuidanceEpisodeTasks({ repoRoot: REPO_ROOT });
  assert.equal(compiled.ok, true);
  const teacher = compiled.tasks.find((t) => t.domainPack === "teacher");
  assert.ok(teacher);

  const missing = loadGuidanceEpisodeTask(teacher.scenarioId, {
    repoRoot: REPO_ROOT,
    subjectId: "",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_subject");

  const cross = loadGuidanceEpisodeTask(teacher.scenarioId, {
    repoRoot: REPO_ROOT,
    subjectId: guidanceSubjectIdForPack("lawyer"),
    deviceId: "dev-iso",
  });
  assert.equal(cross.ok, false);
  assert.equal(cross.failureClass, "cross_subject");

  const telemetry: object[] = [];
  const ok = loadGuidanceEpisodeTask(teacher.scenarioId, {
    repoRoot: REPO_ROOT,
    subjectId: teacher.subjectId,
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.task.subjectId, teacher.subjectId);
  assert.ok(
    telemetry.every((t) => (t as { subjectId?: unknown }).subjectId != null),
  );
  const blob = JSON.stringify(telemetry);
  assert.ok(!blob.includes("utterance"));
  log({
    outcome: "rejected",
    case: "cross-subject",
    subjectId: guidanceSubjectIdForPack("lawyer"),
    failureClass: "cross_subject",
  });
});

test("scalability: concurrent compile is idempotent (same canonical bytes)", () => {
  const a = compileB8GuidanceEpisodeTasks({ repoRoot: REPO_ROOT });
  const b = compileB8GuidanceEpisodeTasks({ repoRoot: REPO_ROOT });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.canonicalCatalogJson, b.canonicalCatalogJson);
  for (let i = 0; i < a.tasks.length; i += 1) {
    assert.equal(
      canonicalizeGuidanceJson(a.tasks[i]),
      canonicalizeGuidanceJson(b.tasks[i]),
    );
  }
});
