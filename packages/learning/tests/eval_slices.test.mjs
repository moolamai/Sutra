/**
 * Frozen eval slice taxonomy + registry mapping.
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVAL_SLICE_COVERAGE_SCHEMA_VERSION,
  EVAL_SLICE_RUN_SCHEMA_VERSION,
  EVAL_SLICE_TAXONOMY_RELPATH,
  EVAL_SLICE_TAXONOMY_SCHEMA_VERSION,
  assertEvalSliceCoverageComplete,
  assertGateSlicesHaveBaselines,
  assertNoCrossSliceContamination,
  buildEvalSliceMapping,
  buildEvalSliceRunReport,
  createDeterministicSliceScorer,
  createPinnedSeedRng,
  evaluateSlicePromotionGate,
  formatSliceId,
  loadAndAssertEvalSliceCoverage,
  loadBaselineRegistry,
  loadEvalSliceTaxonomy,
  mapRegistryToEvalSlices,
  parseSliceId,
  runEvalSliceSuite,
  runSliceChampionChallengerGate,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "learning.eval_slices.test", ...event })}\n`,
  );
}

test("happy path: taxonomy loads; naming is domainPackId/language/bindingId", async () => {
  const telemetry = [];
  const taxonomy = await loadEvalSliceTaxonomy({
    repoRoot: REPO_ROOT,
    deviceId: "ci-slices",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(taxonomy.ok, true);
  assert.equal(
    taxonomy.document.schemaVersion,
    EVAL_SLICE_TAXONOMY_SCHEMA_VERSION,
  );
  assert.equal(taxonomy.taxonomyPath, EVAL_SLICE_TAXONOMY_RELPATH);
  assert.equal(
    taxonomy.document.naming.pattern,
    "{domainPackId}/{language}/{bindingId}",
  );
  assert.equal(taxonomy.document.naming.gateReportField, "failingSlice");

  const teacher = formatSliceId({
    domainPackId: "teacher",
    language: "en",
    bindingId: "b8",
  });
  assert.equal(teacher, "teacher/en/b8");
  const parsed = parseSliceId(teacher);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.key.domainPackId, "teacher");

  const memory = taxonomy.document.slices.find(
    (s) => s.domainPackId === "memory" && s.emptyMarker === true,
  );
  assert.ok(memory, "explicit empty marker for packs with zero guidance evals");

  const namingDoc = await readFile(
    path.join(REPO_ROOT, "training/eval/slices/NAMING.md"),
    "utf8",
  );
  assert.ok(namingDoc.includes("{domainPackId}/{language}/{bindingId}"));
  assert.ok(telemetry.every((t) => t.subjectId === null));
  log({
    outcome: "ok",
    case: "taxonomy-load",
    subjectId: null,
    entryCount: taxonomy.document.slices.length,
  });
});

test("happy path: registry maps into slices; known-good gate promotes", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const telemetry = [];
  const built = await buildEvalSliceMapping({
    repoRoot: REPO_ROOT,
    registry: loaded.document,
    deviceId: "ci-map",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(built.ok, true);

  const protocol = built.mappings.find((m) => m.sliceId === "protocol/en/a-p6");
  assert.ok(protocol);
  assert.ok(protocol.baselineSetIds.length >= 1);
  assert.ok(protocol.pinnedSeeds.length >= 1);
  assert.equal(protocol.tolerance, null);

  const teacher = built.mappings.find((m) => m.sliceId === "teacher/en/b8");
  assert.ok(teacher);
  assert.ok(teacher.baselineSetIds.includes("b8.guidance.teacher-guidance-tone"));

  const required = [
    "smoke/en/edge",
    "protocol/en/a-p6",
    "teacher/en/b8",
    "lawyer/en/b8",
  ];
  const lint = assertGateSlicesHaveBaselines(built.mappings, required);
  assert.equal(lint.ok, true);

  const champion = Object.fromEntries(required.map((id) => [id, 0.9]));
  const challenger = { ...champion, "smoke/en/edge": 0.95 };
  const gate = evaluateSlicePromotionGate({
    mappings: built.mappings,
    requiredSliceIds: required,
    championScores: champion,
    challengerScores: challenger,
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.verdict, "promote");
  assert.ok(telemetry.some((t) => t.action === "map" && t.outcome === "ok"));
  assert.ok(
    telemetry.some((t) => t.action === "promote_gate" && t.outcome === "ok"),
  );
  log({
    outcome: "ok",
    case: "map-promote",
    subjectId: null,
    entryCount: built.mappings.length,
  });
});

test("edge: empty-marker slice fails gate definition linter when referenced", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const built = await buildEvalSliceMapping({
    repoRoot: REPO_ROOT,
    registry: loaded.document,
  });
  assert.equal(built.ok, true);

  const memory = built.mappings.find((m) => m.sliceId === "memory/en/b8");
  assert.ok(memory);
  assert.equal(memory.emptyMarker, true);
  assert.equal(memory.baselineSetIds.length, 0);

  const telemetry = [];
  const lint = assertGateSlicesHaveBaselines(
    built.mappings,
    ["memory/en/b8"],
    { onTelemetry: (e) => telemetry.push(e) },
  );
  assert.equal(lint.ok, false);
  assert.equal(lint.failureClass, "empty_slice");
  assert.equal(lint.failingSlice, "memory/en/b8");
  assert.ok(
    telemetry.some(
      (t) => t.failureClass === "empty_slice" && t.failingSlice === "memory/en/b8",
    ),
  );
  log({
    outcome: "rejected",
    case: "empty_slice",
    subjectId: null,
    failingSlice: "memory/en/b8",
  });
});

test("edge: cross-slice contamination and slice regression name failingSlice", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const built = await buildEvalSliceMapping({
    repoRoot: REPO_ROOT,
    registry: loaded.document,
  });
  assert.equal(built.ok, true);

  const ok = assertNoCrossSliceContamination({
    trainingShardDomainPackId: "teacher",
    evalSliceId: "teacher/en/b8",
  });
  assert.equal(ok.ok, true);

  const telemetry = [];
  const contaminated = assertNoCrossSliceContamination({
    trainingShardDomainPackId: "teacher",
    evalSliceId: "lawyer/en/b8",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(contaminated.ok, false);
  assert.equal(contaminated.failureClass, "cross_slice_contamination");
  assert.equal(contaminated.failingSlice, "lawyer/en/b8");

  const required = ["teacher/en/b8", "lawyer/en/b8"];
  const champion = Object.fromEntries(required.map((id) => [id, 0.9]));
  const challenger = { ...champion, "lawyer/en/b8": 0.5 };
  const gate = evaluateSlicePromotionGate({
    mappings: built.mappings,
    requiredSliceIds: required,
    championScores: champion,
    challengerScores: challenger,
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.verdict, "reject");
  assert.equal(gate.failureClass, "slice_regression");
  assert.equal(gate.failingSlice, "lawyer/en/b8");
  log({
    outcome: "rejected",
    case: "contamination-regression",
    subjectId: null,
    failingSlice: "lawyer/en/b8",
  });
});

test("sovereignty: slice telemetry stays metadata-only; unmapped registry slice rejected", async () => {
  const taxonomy = await loadEvalSliceTaxonomy({ repoRoot: REPO_ROOT });
  assert.equal(taxonomy.ok, true);
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);

  const rogue = {
    schemaVersion: loaded.document.schemaVersion,
    entries: [
      ...loaded.document.entries,
      {
        ...loaded.document.entries[0],
        setId: "rogue.eval.v1",
        sliceTags: {
          domainPack: "not-in-taxonomy",
          language: "en",
          binding: "edge",
        },
      },
    ],
  };
  const telemetry = [];
  const mapped = mapRegistryToEvalSlices(rogue, taxonomy.document, {
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(mapped.ok, false);
  assert.equal(mapped.failureClass, "missing_slice");
  assert.equal(mapped.failingSlice, "not-in-taxonomy/en/edge");

  const blob = JSON.stringify(telemetry);
  assert.ok(!blob.includes("utterance"));
  assert.ok(!blob.includes("learner"));
  assert.ok(telemetry.every((t) => t.subjectId === null));
});

test("happy path: per-slice runner injects pinned seeds; aggregate is derived", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const built = await buildEvalSliceMapping({
    repoRoot: REPO_ROOT,
    registry: loaded.document,
  });
  assert.equal(built.ok, true);

  const sliceIds = ["smoke/en/edge", "protocol/en/a-p6", "teacher/en/b8"];
  const telemetry = [];
  const scorer = createDeterministicSliceScorer({
    rubric: {
      "smoke.eval.v1": 1,
      "a-p6.golden-turns.manifest": 0.9,
    },
  });

  const first = await runEvalSliceSuite({
    mappings: built.mappings,
    registry: loaded.document,
    sliceIds,
    scoreBaseline: scorer,
    deviceId: "ci-runner",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(first.ok, true);
  assert.equal(first.report.schemaVersion, EVAL_SLICE_RUN_SCHEMA_VERSION);
  assert.equal(first.report.slices.length, 3);
  assert.equal(first.report.aggregate.sliceCount, 3);
  assert.ok(first.report.slices.every((s) => s.pinnedSeeds.length >= 1));
  const mean =
    first.report.slices.reduce((a, s) => a + s.score, 0) /
    first.report.slices.length;
  assert.ok(Math.abs(first.report.aggregate.mean - mean) < 1e-12);

  const second = await runEvalSliceSuite({
    mappings: built.mappings,
    registry: loaded.document,
    sliceIds,
    scoreBaseline: scorer,
  });
  assert.equal(second.ok, true);
  assert.equal(
    JSON.stringify(second.report.slices.map((s) => s.score)),
    JSON.stringify(first.report.slices.map((s) => s.score)),
  );

  const aggregateOnly = buildEvalSliceRunReport([]);
  assert.equal(aggregateOnly.ok, false);
  assert.equal(aggregateOnly.failureClass, "aggregate_only_forbidden");

  assert.ok(telemetry.some((t) => t.action === "seed_inject"));
  assert.ok(telemetry.some((t) => t.action === "run_suite" && t.outcome === "ok"));
  assert.ok(telemetry.every((t) => t.subjectId === null));
  log({
    outcome: "ok",
    case: "run-suite",
    subjectId: null,
    entryCount: first.report.slices.length,
  });
});

test("happy path: known-good challenger promotes via per-slice runner gate", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const built = await buildEvalSliceMapping({
    repoRoot: REPO_ROOT,
    registry: loaded.document,
  });
  assert.equal(built.ok, true);
  const sliceIds = ["smoke/en/edge", "lawyer/en/b8"];

  const gate = await runSliceChampionChallengerGate({
    mappings: built.mappings,
    registry: loaded.document,
    sliceIds,
    scoreChampion: createDeterministicSliceScorer({
      rubric: { "smoke.eval.v1": 0.8 },
    }),
    scoreChallenger: createDeterministicSliceScorer({
      rubric: { "smoke.eval.v1": 0.95 },
    }),
    surgeryClasses: ["adapter_lora"],
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.verdict, "promote");
  assert.ok(gate.champion.slices.length >= 1);
  assert.ok(gate.challenger.aggregate.sliceCount >= 1);
});

test("edge: empty slice / timeout / multi-surgery / regression name failingSlice", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const built = await buildEvalSliceMapping({
    repoRoot: REPO_ROOT,
    registry: loaded.document,
  });
  assert.equal(built.ok, true);

  const empty = await runEvalSliceSuite({
    mappings: built.mappings,
    registry: loaded.document,
    sliceIds: ["memory/en/b8"],
    scoreBaseline: createDeterministicSliceScorer(),
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.failureClass, "empty_slice");
  assert.equal(empty.failingSlice, "memory/en/b8");

  const multi = await runEvalSliceSuite({
    mappings: built.mappings,
    registry: loaded.document,
    sliceIds: ["smoke/en/edge"],
    scoreBaseline: createDeterministicSliceScorer(),
    surgeryClasses: ["adapter_lora", "router_weights"],
  });
  assert.equal(multi.ok, false);
  assert.equal(multi.failingSlice, "adapter_lora+router_weights");

  const hang = await runEvalSliceSuite({
    mappings: built.mappings,
    registry: loaded.document,
    sliceIds: ["smoke/en/edge"],
    timeoutMs: 20,
    scoreBaseline: async () =>
      new Promise(() => {
        /* intentionally never resolves */
      }),
  });
  assert.equal(hang.ok, false);
  assert.equal(hang.failureClass, "timeout");
  assert.equal(hang.failingSlice, "smoke/en/edge");

  const regressed = await runSliceChampionChallengerGate({
    mappings: built.mappings,
    registry: loaded.document,
    sliceIds: ["teacher/en/b8", "lawyer/en/b8"],
    scoreChampion: createDeterministicSliceScorer({
      rubric: {
        "b8.guidance.teacher-guidance-tone": 0.9,
        "b8.guidance.lawyer-scope-refusal": 0.9,
      },
    }),
    scoreChallenger: createDeterministicSliceScorer({
      rubric: {
        "b8.guidance.teacher-guidance-tone": 0.9,
        "b8.guidance.lawyer-scope-refusal": 0.4,
      },
    }),
    surgeryClasses: ["adapter_lora"],
  });
  assert.equal(regressed.ok, false);
  assert.equal(regressed.verdict, "reject");
  assert.equal(regressed.failureClass, "slice_regression");
  assert.equal(regressed.failingSlice, "lawyer/en/b8");
  log({
    outcome: "rejected",
    case: "runner-edges",
    subjectId: null,
    failingSlice: "lawyer/en/b8",
  });
});

test("sovereignty: pinned RNG is deterministic; scorer must use injected seed", () => {
  const a = createPinnedSeedRng(42);
  const b = createPinnedSeedRng(42);
  const seqA = [a.next(), a.next(), a.nextInt(100)];
  const seqB = [b.next(), b.next(), b.nextInt(100)];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, [
    createPinnedSeedRng(43).next(),
    createPinnedSeedRng(43).next(),
    createPinnedSeedRng(43).nextInt(100),
  ]);
});

test("happy path: slice coverage complete for committed registry (known-good)", async () => {
  const telemetry = [];
  const result = await loadAndAssertEvalSliceCoverage({
    repoRoot: REPO_ROOT,
    deviceId: "ci-coverage",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(result.ok, true);
  assert.equal(
    result.report.schemaVersion,
    EVAL_SLICE_COVERAGE_SCHEMA_VERSION,
  );
  assert.ok(result.report.coveredSliceIds.includes("teacher/en/b8"));
  assert.ok(result.report.coveredSliceIds.includes("protocol/en/a-p6"));
  assert.ok(result.report.emptyMarkerSliceIds.includes("memory/en/b8"));
  assert.equal(result.report.missingSliceIds.length, 0);
  assert.equal(result.report.uncoveredDomainPackIds.length, 0);
  assert.equal(result.report.uncoveredBindingIds.length, 0);
  assert.ok(
    telemetry.some((t) => t.action === "coverage_check" && t.outcome === "ok"),
  );
  assert.ok(telemetry.every((t) => t.subjectId === null));
  log({
    outcome: "ok",
    case: "coverage-complete",
    subjectId: null,
    entryCount: result.report.coveredSliceIds.length,
  });
});

test("edge: coverage incomplete lists missing slices by name (known-regressed)", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const taxonomy = await loadEvalSliceTaxonomy({ repoRoot: REPO_ROOT });
  assert.equal(taxonomy.ok, true);

  const stripped = {
    schemaVersion: loaded.document.schemaVersion,
    entries: loaded.document.entries.filter(
      (e) => e.sliceTags.domainPack !== "lawyer",
    ),
  };
  const telemetry = [];
  const result = assertEvalSliceCoverageComplete({
    registry: stripped,
    taxonomy: taxonomy.document,
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "coverage_incomplete");
  assert.ok(result.missingSliceIds.includes("lawyer/en/b8"));
  // Taxonomy still declares lawyer/en/b8 non-empty; with baselines removed it is missing.
  assert.equal(result.failingSlice, "lawyer/en/b8");
  assert.ok(
    telemetry.some(
      (t) =>
        t.failureClass === "coverage_incomplete" &&
        Array.isArray(t.missingSliceIds) &&
        t.missingSliceIds.includes("lawyer/en/b8"),
    ),
  );
  log({
    outcome: "rejected",
    case: "coverage-incomplete",
    subjectId: null,
    failingSlice: "lawyer/en/b8",
  });
});

test("edge: empty marker does not satisfy coverage; unmapped pack fails by name", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const taxonomy = await loadEvalSliceTaxonomy({ repoRoot: REPO_ROOT });
  assert.equal(taxonomy.ok, true);

  const withVision = {
    schemaVersion: loaded.document.schemaVersion,
    entries: [
      ...loaded.document.entries,
      {
        ...loaded.document.entries[0],
        setId: "vision.eval.v1",
        sliceTags: {
          domainPack: "vision",
          language: "en",
          binding: "edge",
        },
      },
    ],
  };
  const unmapped = assertEvalSliceCoverageComplete({
    registry: withVision,
    taxonomy: taxonomy.document,
  });
  assert.equal(unmapped.ok, false);
  assert.equal(unmapped.failureClass, "missing_slice");
  assert.equal(unmapped.failingSlice, "vision/en/edge");
  assert.ok(unmapped.missingSliceIds.includes("vision/en/edge"));

  const ok = assertEvalSliceCoverageComplete({
    registry: loaded.document,
    taxonomy: taxonomy.document,
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.report.emptyMarkerSliceIds.includes("memory/en/b8"));
  assert.ok(!ok.report.coveredSliceIds.includes("memory/en/b8"));
});
