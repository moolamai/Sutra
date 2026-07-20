/**
 * Chunk-boundary fuzz over A P6 golden-turn transcripts.
 * Run: pnpm --filter @moolam/runtime-harness golden:fuzz
 *
 * Set PARSER_CHUNK_FUZZ_SEED_DRIFT=1 to force a red (prove gate only).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHUNK_FUZZ_DEFAULT_SEED,
  CHUNK_FUZZ_MAX_EXHAUSTIVE_LEN,
  CHUNK_FUZZ_MAX_RANDOM_TRIALS,
  SEED_DRIFT_MARKER,
  canonicalizeEventsJson,
  createSeededRng,
  loadGoldenTurnCorpus,
  parseableGoldenStream,
  runChunkBoundaryFuzz,
  runChunkBoundaryFuzzCorpus,
  splitStreamAtCuts,
  summarizeParseEvents,
  parseChunks,
  unifiedDiff,
} from "../dist/index.js";

const injectDrift = process.env.PARSER_CHUNK_FUZZ_SEED_DRIFT === "1";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: every golden is chunk-boundary invariant", () => {
  const telemetry = [];
  const loaded = loadGoldenTurnCorpus({ deviceId: "edge-fuzz" });
  assert.equal(loaded.ok, true);

  for (const fixture of loaded.fixtures) {
    const result = runChunkBoundaryFuzz(fixture, {
      injectDrift,
      seed: CHUNK_FUZZ_DEFAULT_SEED,
      onTelemetry: (e) => telemetry.push(e),
    });
    if (injectDrift) {
      assert.equal(result.ok, false, fixture.id);
      assert.equal(result.failureClass, "chunk_boundary_drift");
      assert.match(result.diff, /^--- fuzz\//m);
      assert.match(result.diff, /^\+\+\+ fuzz\//m);
      assert.match(result.diff, /@@ /);
      assert.match(result.diff, new RegExp(SEED_DRIFT_MARKER));
      process.stdout.write(result.diff);
      assert.fail(
        `${result.detail}\n${(result.diff || "").slice(0, 8000)}`,
      );
    }
    if (!result.ok) {
      if (result.diff) process.stdout.write(result.diff);
      assert.fail(
        `${result.detail}\n${(result.diff || "").slice(0, 8000)}`,
      );
    }
    log({
      event: "runtime.harness.chunk_boundary_fuzz",
      outcome: "ok",
      subjectId: result.subjectId,
      deviceId: result.deviceId,
      turnId: result.turnId,
      streamLen: result.streamLen,
      trials: result.trials,
    });
  }

  assert.ok(telemetry.every((t) => t.outcome === "ok"));
  assert.ok(telemetry.every((t) => t.subjectId === "anika-k"));
  assert.ok(!JSON.stringify(telemetry).includes("consider ratio"));
  assert.ok(!JSON.stringify(telemetry).includes("lookup"));
});

test("happy path: corpus helper fuzzes all goldens", () => {
  if (injectDrift) return; // covered by previous test under seed
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const corpus = runChunkBoundaryFuzzCorpus(loaded.fixtures, {
    seed: CHUNK_FUZZ_DEFAULT_SEED,
  });
  assert.equal(corpus.ok, true);
  assert.equal(corpus.turnCount, loaded.fixtures.length);
  assert.ok(corpus.trials > 0);
  log({
    case: "corpus_fuzz",
    outcome: "ok",
    turnCount: corpus.turnCount,
    trials: corpus.trials,
  });
});

test("edge: multi-chunk fixture stream equals joined parseable bytes", () => {
  if (injectDrift) return;
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  for (const fixture of loaded.fixtures) {
    const stream = parseableGoldenStream(fixture.input);
    const fromChunks = summarizeParseEvents(
      parseChunks(fixture.input.filter((c) => !/^<stream truncated>$/i.test(c)), {
        subjectId: fixture.subjectId,
        deviceId: fixture.deviceId,
      }),
    );
    const fromJoined = summarizeParseEvents(
      parseChunks([stream], {
        subjectId: fixture.subjectId,
        deviceId: fixture.deviceId,
      }),
    );
    assert.equal(
      canonicalizeEventsJson(fromChunks),
      canonicalizeEventsJson(fromJoined),
      fixture.id,
    );
  }
  log({ case: "multi_vs_joined_parseable", outcome: "ok" });
});

test("edge: failing fuzz always prints unified diff (forced injectDrift)", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const fixture = loaded.fixtures[0];
  const result = runChunkBoundaryFuzz(fixture, { injectDrift: true });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "chunk_boundary_drift");
  assert.match(result.diff, /^--- fuzz\//m);
  assert.match(result.diff, /^\+\+\+ fuzz\//m);
  assert.match(result.diff, /@@ /);
  assert.match(result.detail, /CHUNK_BOUNDARY_FUZZ_DRIFT/);
  assert.match(result.diff, new RegExp(SEED_DRIFT_MARKER));
  log({
    case: "forced_drift_diff",
    outcome: "rejected",
    turnId: fixture.id,
  });
});

test("edge: seeded RNG + splitStreamAtCuts are deterministic", () => {
  const a = createSeededRng(CHUNK_FUZZ_DEFAULT_SEED);
  const b = createSeededRng(CHUNK_FUZZ_DEFAULT_SEED);
  const seqA = Array.from({ length: 8 }, () => a());
  const seqB = Array.from({ length: 8 }, () => b());
  assert.deepEqual(seqA, seqB);
  assert.deepEqual(splitStreamAtCuts("abcdef", [2, 4]), ["ab", "cd", "ef"]);
  assert.deepEqual(splitStreamAtCuts("abcdef", []), ["abcdef"]);
  log({ case: "rng_determinism", outcome: "ok", seed: CHUNK_FUZZ_DEFAULT_SEED });
});

test("sovereignty: fuzz scopes parser to fixture subjectId", () => {
  if (injectDrift) return;
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  for (const fixture of loaded.fixtures) {
    const result = runChunkBoundaryFuzz(fixture);
    assert.equal(result.ok, true);
    assert.equal(result.subjectId, fixture.subjectId);
  }
  const missing = runChunkBoundaryFuzz({
    ...loaded.fixtures[0],
    subjectId: "",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_subject");
  log({ case: "subject_scope_fuzz", outcome: "ok" });
});

test("scalability: soft caps bound exhaustive + random work", () => {
  if (injectDrift) return;
  assert.ok(CHUNK_FUZZ_MAX_EXHAUSTIVE_LEN <= 256);
  assert.ok(CHUNK_FUZZ_MAX_RANDOM_TRIALS <= 64);
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  for (const fixture of loaded.fixtures) {
    const stream = parseableGoldenStream(fixture.input);
    assert.ok(stream.length <= CHUNK_FUZZ_MAX_EXHAUSTIVE_LEN * 4);
    const result = runChunkBoundaryFuzz(fixture, {
      maxExhaustiveLen: 32,
      maxRandomTrials: 8,
      maxCuts: 3,
    });
    assert.equal(result.ok, true, fixture.id);
    // exhaustive (33 offsets * 2) + random 8 when stream short enough
    assert.ok(result.trials <= 32 * 2 + 8 + 40);
  }
  log({ case: "budget", outcome: "ok" });
});

test("edge: unifiedDiff surface for drift log usefulness", () => {
  const a = canonicalizeEventsJson([{ type: "answer_delta", delta: "ok" }]);
  const b = canonicalizeEventsJson([
    { type: "answer_delta", delta: SEED_DRIFT_MARKER },
  ]);
  const diff = unifiedDiff(a, b, {
    fromFile: "fuzz/x.single-chunk.json",
    toFile: "fuzz/x.split.json",
  });
  assert.match(diff, /^--- fuzz\/x\.single-chunk\.json/m);
  assert.match(diff, /^\+\+\+ fuzz\/x\.split\.json/m);
  log({ case: "unified_diff_markers", outcome: "ok" });
});
