/**
 * Golden-turn fixture format and initial corpus.
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/golden_turns.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeGoldenTurn,
  goldenTurnCorpusManifestSchema,
  goldenTurnFixtureSchema,
  validateGoldenTurnCorpus,
} from "../dist/index.js";
import {
  canonicalizeFramesJson,
  parseGoldenTurnStub,
  parseGoldenTurnStubCanonical,
} from "./golden_turn_parser_stub.mjs";
import { unifiedDiff } from "./golden_turn_unified_diff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const FIXTURE_DIR = join(PKG, "fixtures", "golden-turns");
const MANIFEST = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"),
);

function parseContext(fixture) {
  return {
    subjectId: fixture.subjectId,
    deviceId: fixture.deviceId,
    correlationId: fixture.correlationId,
    coverage: fixture.coverage,
  };
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function loadTurn(file) {
  const raw = readFileSync(join(FIXTURE_DIR, file), "utf8");
  return { raw, value: JSON.parse(raw) };
}

test("happy path: manifest + ≥5 goldens validate; required coverage present", () => {
  const manifest = goldenTurnCorpusManifestSchema.parse(MANIFEST);
  assert.ok(manifest.turns.length >= 5);

  const fixtures = [];
  const rawFiles = [];
  for (const entry of manifest.turns) {
    const { raw, value } = loadTurn(entry.file);
    const parsed = goldenTurnFixtureSchema.parse(value);
    assert.equal(parsed.id, entry.id);
    fixtures.push(parsed);
    rawFiles.push({ id: parsed.id, raw });
    emit({
      event: "golden.turn.fixture",
      outcome: "ok",
      subjectId: parsed.subjectId,
      deviceId: parsed.deviceId,
      correlationId: parsed.correlationId,
      turnId: parsed.id,
      frameCount: parsed.expectedFrames.length,
      chunkCount: parsed.input.length,
    });
  }

  const corpus = validateGoldenTurnCorpus(fixtures, {
    subjectId: "anika-k",
    rawFiles,
  });
  assert.equal(corpus.ok, true, corpus.ok ? "" : corpus.detail);
  assert.equal(corpus.turnCount, fixtures.length);
  for (const tag of [
    "thought_delta",
    "answer_delta",
    "tool_call_fence",
    "correction_loop",
    "meter_tick",
    "harness_error",
  ]) {
    assert.ok(corpus.coverage.includes(tag), `missing coverage ${tag}`);
  }
});

test("happy path: each golden is byte-identical to canonicalizeGoldenTurn", () => {
  for (const entry of MANIFEST.turns) {
    const { raw, value } = loadTurn(entry.file);
    const parsed = goldenTurnFixtureSchema.parse(value);
    const canonical = canonicalizeGoldenTurn(parsed);
    assert.equal(
      raw.replace(/\r\n/g, "\n"),
      canonical,
      `${entry.id} not canonical`,
    );
  }
});

test("edge: language-neutral files have no TS/Python type artifacts", () => {
  for (const entry of MANIFEST.turns) {
    const { raw } = loadTurn(entry.file);
    assert.doesNotMatch(raw, /undefined|NaN|Infinity/);
    assert.doesNotMatch(raw, /"\$type"|"__typename"|"__class__"/);
  }
});

test("edge: regeneration helper must not auto-commit (no git write script)", () => {
  const scripts = readdirSync(join(PKG, "scripts")).filter((f) =>
    f.includes("golden"),
  );
  assert.ok(scripts.includes("write-golden-turns.mjs"));
  const body = readFileSync(
    join(PKG, "scripts", "write-golden-turns.mjs"),
    "utf8",
  );
  assert.match(body, /never auto-commits/i);
  assert.doesNotMatch(body, /git\s+commit|git\s+add/);
});

test("sovereignty: cross-subject frame is rejected", () => {
  const { value } = loadTurn(MANIFEST.turns[0].file);
  const bad = structuredClone(value);
  bad.expectedFrames[1].subjectId = "other-subject";
  const result = goldenTurnFixtureSchema.safeParse(bad);
  assert.equal(result.success, false);
  emit({
    event: "golden.turn.fixture",
    outcome: "rejected",
    failureClass: "subject_scope",
    subjectId: value.subjectId,
    deviceId: value.deviceId,
  });
});

test("edge: missing advisory / non-terminal last frame / tiny corpus fail distinctly", () => {
  const { value } = loadTurn(MANIFEST.turns[0].file);
  const noAdvisory = structuredClone(value);
  noAdvisory.expectedFrames = noAdvisory.expectedFrames.filter(
    (f) => f.type !== "ADVISORY_ATTACH",
  );
  assert.equal(goldenTurnFixtureSchema.safeParse(noAdvisory).success, false);

  const noTerminal = structuredClone(value);
  noTerminal.expectedFrames = noTerminal.expectedFrames.filter(
    (f) => f.type !== "TURN_COMPLETE" && f.type !== "HARNESS_ERROR",
  );
  assert.equal(goldenTurnFixtureSchema.safeParse(noTerminal).success, false);

  const corpus = validateGoldenTurnCorpus([value, value, value, value], {
    subjectId: "anika-k",
  });
  assert.equal(corpus.ok, false);
  assert.equal(corpus.failureClass, "insufficient_corpus");
  emit({
    event: "golden.turn.corpus",
    outcome: "rejected",
    failureClass: corpus.failureClass,
    subjectId: "anika-k",
    deviceId: value.deviceId,
  });
});

test("scalability: fixture bounds keep corpus hot-path friendly", () => {
  for (const entry of MANIFEST.turns) {
    const parsed = goldenTurnFixtureSchema.parse(loadTurn(entry.file).value);
    assert.ok(parsed.input.length <= 64);
    assert.ok(parsed.expectedFrames.length <= 64);
  }
  assert.ok(MANIFEST.turns.length <= 64);
});

test("happy path: reference parser stub matches every golden byte-identically", () => {
  for (const entry of MANIFEST.turns) {
    const fixture = goldenTurnFixtureSchema.parse(loadTurn(entry.file).value);
    const result = parseGoldenTurnStubCanonical(
      fixture.input,
      parseContext(fixture),
    );
    assert.equal(result.ok, true, `${entry.id}: ${result.detail}`);
    const expectedJson = canonicalizeFramesJson(fixture.expectedFrames);
    if (result.canonicalJson !== expectedJson) {
      const diff = unifiedDiff(expectedJson, result.canonicalJson, {
        fromFile: `golden/${entry.id}.expected.json`,
        toFile: `golden/${entry.id}.actual.json`,
      });
      process.stdout.write(diff);
      emit({
        event: "golden.turn.parse",
        outcome: "rejected",
        failureClass: "canonical_drift",
        subjectId: fixture.subjectId,
        deviceId: fixture.deviceId,
        correlationId: fixture.correlationId,
        turnId: fixture.id,
      });
      assert.fail(
        `GOLDEN_TURN_DRIFT:${entry.id}\n${diff.slice(0, 8000)}`,
      );
    }
    emit({
      event: "golden.turn.parse",
      outcome: "ok",
      subjectId: result.subjectId,
      deviceId: result.deviceId,
      correlationId: fixture.correlationId,
      turnId: fixture.id,
      frameCount: result.frames.length,
    });
  }
});

test("edge: unifiedDiff emits ---/+++/@@ on mismatch and empty on identity", () => {
  const a = '{\n  "x": 1\n}\n';
  const b = '{\n  "x": 2\n}\n';
  const diff = unifiedDiff(a, b, {
    fromFile: "expected.json",
    toFile: "actual.json",
  });
  assert.match(diff, /^--- expected\.json/m);
  assert.match(diff, /^\+\+\+ actual\.json/m);
  assert.match(diff, /^@@ /m);
  assert.match(diff, /^-.*"x": 1/m);
  assert.match(diff, /^\+.*"x": 2/m);
  assert.equal(unifiedDiff(a, a), "");
});

test("edge: stub parse is idempotent under replay of the same input", () => {
  const fixture = goldenTurnFixtureSchema.parse(
    loadTurn(MANIFEST.turns[0].file).value,
  );
  const ctx = parseContext(fixture);
  const a = parseGoldenTurnStubCanonical(fixture.input, ctx);
  const b = parseGoldenTurnStubCanonical(fixture.input, ctx);
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.canonicalJson, b.canonicalJson);
});

test("edge: stub rejects empty subjectId with distinct failure class", () => {
  const fixture = goldenTurnFixtureSchema.parse(
    loadTurn(MANIFEST.turns[0].file).value,
  );
  const result = parseGoldenTurnStub(fixture.input, {
    ...parseContext(fixture),
    subjectId: "",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "missing_subject");
  emit({
    event: "golden.turn.parse",
    outcome: "rejected",
    failureClass: result.failureClass,
    subjectId: null,
    deviceId: fixture.deviceId,
  });
});

test("sovereignty: stub frames never carry a foreign subjectId", () => {
  const fixture = goldenTurnFixtureSchema.parse(
    loadTurn(MANIFEST.turns[0].file).value,
  );
  const result = parseGoldenTurnStub(fixture.input, parseContext(fixture));
  assert.equal(result.ok, true);
  for (const frame of result.frames) {
    assert.equal(frame.subjectId, fixture.subjectId);
    assert.notEqual(frame.subjectId, "other-subject");
  }
});

test("scalability: stub rejects unbounded input chunk lists", () => {
  const fixture = goldenTurnFixtureSchema.parse(
    loadTurn(MANIFEST.turns[0].file).value,
  );
  const huge = Array.from({ length: 65 }, () => "x");
  const result = parseGoldenTurnStub(huge, parseContext(fixture));
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "frame_budget_exceeded");
  emit({
    event: "golden.turn.parse",
    outcome: "rejected",
    failureClass: result.failureClass,
    subjectId: fixture.subjectId,
    deviceId: fixture.deviceId,
  });
});
