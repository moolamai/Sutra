/**
 * Scenario catalog index + CI smoke (one episode per slice).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildScenarioCatalog,
  canonicalizeCatalogJson,
  formatSmokeFailure,
  loadScenarioCatalog,
  materializeScenarioCatalog,
  runScenarioCatalogSmoke,
  SCENARIO_CATALOG_RELPATH,
  sliceTagsForGolden,
  sliceTagsForGuidance,
} from "../src/scenario_catalog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

function log(event: Record<string, unknown>) {
  process.stdout.write(
    `${JSON.stringify({ event: "training.gym.scenario_catalog.test", ...event })}\n`,
  );
}

test("happy path: catalog indexes golden + guidance with slice tags", () => {
  const telemetry: object[] = [];
  const built = buildScenarioCatalog({
    repoRoot: REPO_ROOT,
    deviceId: "dev-catalog-unit",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(built.ok, true, built.detail);
  assert.ok(built.catalog.scenarioCount >= 7);
  assert.ok(built.catalog.sliceCount >= 2);

  const basic = built.catalog.scenarios.find(
    (s: { scenarioId: string }) => s.scenarioId === "thought-answer-basic",
  );
  const teacher = built.catalog.scenarios.find(
    (s: { scenarioId: string }) =>
      s.scenarioId === "guidance/teacher/teacher-guidance-tone",
  );
  assert.ok(basic);
  assert.ok(teacher);
  assert.ok(basic.sliceTags.includes("a_p6_golden"));
  assert.ok(basic.sliceTags.includes("a_p6_golden.terminal.TURN_COMPLETE"));
  assert.ok(teacher.sliceTags.includes("b8_guidance"));
  assert.ok(teacher.sliceTags.includes("b8_guidance.teacher"));
  assert.match(teacher.sourceRelPath, /^training\/gym\//);
  assert.ok(basic.oracleCheckId);
  assert.ok(teacher.expectedTerminalFrame);

  const canon = canonicalizeCatalogJson(built.catalog);
  assert.ok(canon.endsWith("\n"));
  assert.ok(!canon.includes("undefined"));
  assert.equal(canon, canonicalizeCatalogJson(JSON.parse(canon)));
  assert.ok(!JSON.stringify(telemetry).includes(SECRET));

  log({
    outcome: "ok",
    case: "build-catalog",
    subjectId: null,
    scenarioCount: built.catalog.scenarioCount,
    sliceCount: built.catalog.sliceCount,
  });
});

test("happy path: committed catalog is byte-identical (check mode)", () => {
  const check = materializeScenarioCatalog({
    repoRoot: REPO_ROOT,
    mode: "check",
    deviceId: "dev-catalog-check",
  });
  assert.equal(check.ok, true, `${check.failureClass}: ${check.detail}`);

  const onDisk = readFileSync(
    join(REPO_ROOT, SCENARIO_CATALOG_RELPATH),
    "utf8",
  );
  const built = buildScenarioCatalog({ repoRoot: REPO_ROOT });
  assert.equal(built.ok, true);
  assert.equal(onDisk, built.canonicalJson);

  const loaded = loadScenarioCatalog({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);

  log({
    outcome: "ok",
    case: "byte-identical-check",
    subjectId: null,
    path: SCENARIO_CATALOG_RELPATH,
  });
});

test("happy path: smoke runs one seeded episode per slice", async () => {
  const telemetry: object[] = [];
  const smoke = await runScenarioCatalogSmoke({
    repoRoot: REPO_ROOT,
    deviceId: "dev-catalog-smoke",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(smoke.ok, true, smoke.detail);
  assert.ok((smoke.smoked ?? 0) >= 2);
  assert.equal(smoke.smoked, smoke.sliceCount);

  assert.ok(
    telemetry.some(
      (t) =>
        (t as { action?: string; outcome?: string }).action === "smoke_slice" &&
        (t as { outcome?: string }).outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(telemetry).includes(SECRET));

  log({
    outcome: "ok",
    case: "smoke-per-slice",
    subjectId: null,
    smoked: smoke.smoked,
    sliceCount: smoke.sliceCount,
  });
});

test("edge: smoke failure message names scenarioId and slice", () => {
  const msg = formatSmokeFailure({
    scenarioId: "thought-answer-basic",
    sliceId: "a_p6_golden",
    failureClass: "oracle_mismatch",
    detail: "terminal mismatch",
  });
  assert.match(msg, /scenarioId=thought-answer-basic/);
  assert.match(msg, /slice=a_p6_golden/);
  assert.match(msg, /failureClass=oracle_mismatch/);
});

test("edge: language-neutral slice tags; no TS artifacts", () => {
  const g = sliceTagsForGolden({
    scenarioId: "x",
    expectedTerminalFrame: "HARNESS_ERROR",
  });
  const b = sliceTagsForGuidance({
    scenarioId: "guidance/lawyer/x",
    domainPack: "lawyer",
    expectedTerminalFrame: "TURN_COMPLETE",
  });
  assert.deepEqual(g, [
    "a_p6_golden",
    "a_p6_golden.terminal.HARNESS_ERROR",
  ]);
  assert.ok(b.includes("b8_guidance.lawyer"));
  const json = canonicalizeCatalogJson({ tags: g.concat(b) });
  assert.ok(!json.includes("undefined"));
  assert.ok(!json.includes("Symbol"));
});

test("sovereignty: guidance smoke is subject-scoped (cross-subject rejected)", async () => {
  const { loadGuidanceEpisodeTask } = await import(
    "../src/guidance_episode_tasks.mjs"
  );
  const cross = loadGuidanceEpisodeTask(
    "guidance/teacher/teacher-guidance-tone",
    {
      repoRoot: REPO_ROOT,
      subjectId: "subj.foreign.catalog",
      deviceId: "dev-catalog-cross",
    },
  );
  assert.equal(cross.ok, false);
  assert.equal(cross.failureClass, "cross_subject");

  log({
    outcome: "rejected",
    case: "cross-subject",
    subjectId: "subj.foreign.catalog",
    failureClass: "cross_subject",
  });
});

test("scalability: concurrent catalog builds are idempotent", () => {
  const a = buildScenarioCatalog({ repoRoot: REPO_ROOT });
  const b = buildScenarioCatalog({ repoRoot: REPO_ROOT });
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.canonicalJson, b.canonicalJson);
});
