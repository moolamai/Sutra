/**
 * Golden replay: ToolCallParser → HarnessFrames, canonical byte-diff.
 * Run: pnpm --filter @moolam/runtime-harness test
 * Or:  pnpm --filter @moolam/runtime-harness golden:replay
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeFramesJson,
  loadGoldenTurnCorpus,
  replayGoldenTurn,
  replayGoldenTurnCorpus,
  unifiedDiff,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: every golden replays byte-identical to expectedFrames", () => {
  const telemetry = [];
  const loaded = loadGoldenTurnCorpus({
    deviceId: "edge-replay",
  });
  assert.equal(loaded.ok, true);

  for (const fixture of loaded.fixtures) {
    const result = replayGoldenTurn(fixture, {
      onTelemetry: (e) => telemetry.push(e),
    });
    if (!result.ok) {
      if (result.diff) process.stdout.write(result.diff);
      assert.fail(
        `${result.detail}\n${(result.diff || "").slice(0, 8000)}`,
      );
    }
    assert.equal(
      result.canonicalJson,
      canonicalizeFramesJson(fixture.expectedFrames),
    );
    log({
      event: "runtime.harness.golden_replay",
      outcome: "ok",
      subjectId: result.subjectId,
      deviceId: result.deviceId,
      turnId: result.turnId,
      frameCount: result.frames.length,
    });
  }

  assert.ok(telemetry.every((t) => t.outcome === "ok"));
  assert.ok(telemetry.every((t) => t.subjectId === "anika-k"));
  assert.ok(!JSON.stringify(telemetry).includes("consider ratio"));
});

test("happy path: corpus helper replays all goldens", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const corpus = replayGoldenTurnCorpus(loaded.fixtures);
  assert.equal(corpus.ok, true);
  assert.equal(corpus.turnCount, loaded.fixtures.length);
  log({ case: "corpus_replay", outcome: "ok", turnCount: corpus.turnCount });
});

test("edge: multi-chunk vs joined feed produce identical canonical frames", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  for (const fixture of loaded.fixtures) {
    // Skip truncation goldens for join — sentinel must stay a discrete chunk.
    if (fixture.input.some((c) => /^<stream truncated>$/i.test(c))) continue;
    const chunked = replayGoldenTurn(fixture, { chunked: true });
    const joined = replayGoldenTurn(fixture, { chunked: false });
    assert.equal(chunked.ok, true, fixture.id);
    assert.equal(joined.ok, true, fixture.id);
    assert.equal(chunked.canonicalJson, joined.canonicalJson, fixture.id);
  }
  log({ case: "chunk_vs_joined", outcome: "ok" });
});

test("edge: language-neutral expected JSON — no TS/Python artifacts", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  for (const fixture of loaded.fixtures) {
    const raw = loaded.rawById[fixture.id];
    assert.doesNotMatch(raw, /undefined|NaN|Infinity/);
    assert.doesNotMatch(raw, /"\$type"|"__typename"|"__class__"/);
    const result = replayGoldenTurn(fixture);
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.canonicalJson, /undefined|NaN|Infinity/);
  }
  log({ case: "language_neutral", outcome: "ok" });
});

test("edge: sync script never auto-commits (human review)", () => {
  const scripts = readdirSync(join(PKG, "scripts")).filter((f) =>
    f.includes("golden"),
  );
  assert.ok(scripts.includes("sync-a-p6-golden-turns.mjs"));
  const body = readFileSync(
    join(PKG, "scripts", "sync-a-p6-golden-turns.mjs"),
    "utf8",
  );
  assert.match(body, /never auto-commits/i);
  // Must not invoke git commit; comments about human `git add` are fine.
  assert.doesNotMatch(body, /\bgit\s+commit\b/);
  assert.doesNotMatch(body, /(?:exec|spawn|spawnSync|execSync)\s*\([^)]*git/);
  log({ case: "no_auto_commit", outcome: "ok" });
});

test("edge: unifiedDiff empty on identity; ---/+++/@@ on mismatch", () => {
  const a = '{\n  "x": 1\n}\n';
  const b = '{\n  "x": 2\n}\n';
  assert.equal(unifiedDiff(a, a), "");
  const diff = unifiedDiff(a, b, {
    fromFile: "expected.json",
    toFile: "actual.json",
  });
  assert.match(diff, /^--- expected\.json/m);
  assert.match(diff, /^\+\+\+ actual\.json/m);
  assert.match(diff, /^@@ /m);
  log({ case: "unified_diff", outcome: "ok" });
});

test("edge: canonical_drift returns unified diff (forced mismatch)", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const fixture = structuredClone(loaded.fixtures[0]);
  // Corrupt expected so replay (correct actual) drifts.
  fixture.expectedFrames = fixture.expectedFrames.map((f) =>
    f.type === "ANSWER_DELTA" ? { ...f, delta: "DRIFT-INJECTED" } : f,
  );
  // If no answer in this fixture, tweak session pinnedAt instead.
  if (!fixture.expectedFrames.some((f) => f.type === "ANSWER_DELTA")) {
    fixture.expectedFrames[0] = {
      ...fixture.expectedFrames[0],
      pinnedAt: "1999-01-01T00:00:00.000Z",
    };
  }
  const result = replayGoldenTurn(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "canonical_drift");
  assert.match(result.diff, /^--- /m);
  assert.match(result.diff, /^\+\+\+ /m);
  log({ case: "forced_drift_diff", outcome: "rejected", turnId: fixture.id });
});

test("sovereignty: replay scopes frames to fixture subjectId", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  for (const fixture of loaded.fixtures) {
    const result = replayGoldenTurn(fixture);
    assert.equal(result.ok, true);
    for (const frame of result.frames) {
      assert.equal(frame.subjectId, fixture.subjectId);
      assert.equal(frame.correlationId, fixture.correlationId);
    }
  }
  const missing = replayGoldenTurn({
    ...loaded.fixtures[0],
    subjectId: "",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_subject");
  log({ case: "subject_scope_replay", outcome: "ok" });
});

test("scalability: frame/chunk budgets stay within corpus soft caps", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  for (const fixture of loaded.fixtures) {
    assert.ok(fixture.input.length <= 64);
    assert.ok(fixture.expectedFrames.length <= 64);
    const result = replayGoldenTurn(fixture);
    assert.equal(result.ok, true);
    assert.ok(result.frames.length <= 64);
  }
  log({ case: "budget", outcome: "ok", turns: loaded.fixtures.length });
});
