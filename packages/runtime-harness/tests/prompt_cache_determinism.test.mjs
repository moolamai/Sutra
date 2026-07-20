/**
 * Prompt assembly determinism goldens.
 * Fixtures: fixtures/prompt-assembly-determinism/ (language-neutral JSON).
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROMPT_ASSEMBLY_DETERMINISM_FIXTURE_RELPATH,
  replayPromptAssemblyDeterminismCase,
  unifiedDiff,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const FIXTURE_DIR = join(PKG, PROMPT_ASSEMBLY_DETERMINISM_FIXTURE_RELPATH);

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function loadCorpus() {
  const raw = readFileSync(join(FIXTURE_DIR, "cases.json"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  return JSON.parse(raw);
}

function loadManifest() {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8").replace(
      /\r\n/g,
      "\n",
    ),
  );
}

test("fixture: prompt-assembly-determinism corpus is wired", () => {
  const manifest = loadManifest();
  const corpus = loadCorpus();
  assert.equal(manifest.comparePolicy, "exact-byte-compare");
  assert.equal(manifest.fixtureFile, "cases.json");
  assert.ok(Array.isArray(corpus.cases));
  assert.ok(corpus.cases.length >= 5);
  const ids = new Set(corpus.cases.map((c) => c.id));
  for (const required of [
    "identical-bindings-stable",
    "key-order-flap",
    "charter-mutation",
    "binding-field-mutation",
    "static-only-empty-dynamic",
    "cross-subject-isolation",
  ]) {
    assert.ok(ids.has(required), `missing case ${required}`);
  }
  for (const c of corpus.cases) {
    assert.ok(c.specId, `${c.id}: specId required`);
    assert.ok(c.protects, `${c.id}: protects comment required`);
  }
});

test("happy path: every golden case byte-compares", () => {
  const corpus = loadCorpus();
  for (const fixtureCase of corpus.cases) {
    const result = replayPromptAssemblyDeterminismCase(fixtureCase);
    if (!result.ok) {
      if (
        result.canonicalExpectationJson &&
        result.expectedCanonicalExpectationJson
      ) {
        process.stdout.write(
          unifiedDiff(
            result.expectedCanonicalExpectationJson,
            result.canonicalExpectationJson,
            {
              fromFile: `${fixtureCase.id}.expected`,
              toFile: `${fixtureCase.id}.actual`,
            },
          ),
        );
      }
      assert.fail(`${fixtureCase.id}: ${result.detail}`);
    }
    assert.equal(
      result.canonicalExpectationJson,
      result.expectedCanonicalExpectationJson,
    );
    assert.equal(result.staticMatchesHashInvariant, true);
    assert.equal(result.bindingsHash, fixtureCase.expected.bindingsHash);
  }
  log({
    event: "runtime.harness.prompt_cache",
    outcome: "ok",
    case: "determinism_corpus",
    caseCount: corpus.cases.length,
  });
});

test("invariant: unchanged hash keeps static bytes; charter mutation flips both", () => {
  const corpus = loadCorpus();
  const byId = Object.fromEntries(corpus.cases.map((c) => [c.id, c]));
  const stable = replayPromptAssemblyDeterminismCase(
    byId["identical-bindings-stable"],
  );
  const flap = replayPromptAssemblyDeterminismCase(byId["key-order-flap"]);
  const empty = replayPromptAssemblyDeterminismCase(
    byId["static-only-empty-dynamic"],
  );
  const charter = replayPromptAssemblyDeterminismCase(
    byId["charter-mutation"],
  );
  const field = replayPromptAssemblyDeterminismCase(
    byId["binding-field-mutation"],
  );
  assert.equal(stable.ok, true);
  assert.equal(flap.ok, true);
  assert.equal(empty.ok, true);
  assert.equal(charter.ok, true);
  assert.equal(field.ok, true);

  assert.equal(stable.bindingsHash, flap.bindingsHash);
  assert.equal(stable.staticBlock, flap.staticBlock);
  assert.equal(stable.bindingsHash, empty.bindingsHash);
  assert.equal(stable.staticBlock, empty.staticBlock);

  assert.notEqual(stable.bindingsHash, charter.bindingsHash);
  assert.notEqual(stable.staticBlock, charter.staticBlock);

  assert.notEqual(stable.bindingsHash, field.bindingsHash);
  assert.equal(stable.staticBlock, field.staticBlock);
});

test("sovereignty: telemetry never carries charter or utterance plaintext", () => {
  const corpus = loadCorpus();
  for (const fixtureCase of corpus.cases) {
    const result = replayPromptAssemblyDeterminismCase(fixtureCase);
    assert.equal(result.ok, true);
    const wire = JSON.stringify(result.telemetry);
    assert.ok(
      !wire.includes(fixtureCase.profile.charter),
      `${fixtureCase.id}: charter leaked in telemetry`,
    );
    if (fixtureCase.turnContext.utterance) {
      assert.ok(
        !wire.includes(fixtureCase.turnContext.utterance),
        `${fixtureCase.id}: utterance leaked in telemetry`,
      );
    }
    assert.ok(
      result.telemetry.every((e) => e.event === "runtime.harness.prompt_cache"),
    );
    assert.ok(result.telemetry.some((e) => e.action === "hash_bindings"));
    assert.ok(result.telemetry.some((e) => e.subjectId === fixtureCase.subjectId));
  }
});

test("sovereignty: cross-subject case does not share baseline digest", () => {
  const corpus = loadCorpus();
  const byId = Object.fromEntries(corpus.cases.map((c) => [c.id, c]));
  const a = replayPromptAssemblyDeterminismCase(
    byId["identical-bindings-stable"],
  );
  const b = replayPromptAssemblyDeterminismCase(
    byId["cross-subject-isolation"],
  );
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.subjectId, b.subjectId);
  assert.notEqual(a.bindingsHash, b.bindingsHash);
  // Static prefix is content-addressed over profile/protocol — same bytes.
  assert.equal(a.staticBlock, b.staticBlock);
});

test("scalability / concurrency: parallel replays stay idempotent", async () => {
  const corpus = loadCorpus();
  const target = corpus.cases.find((c) => c.id === "identical-bindings-stable");
  assert.ok(target);
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      Promise.resolve(replayPromptAssemblyDeterminismCase(target)),
    ),
  );
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.bindingsHash, target.expected.bindingsHash);
    assert.equal(result.staticBlock, target.expected.staticBlock);
  }
});

test("edge: cross-subject turnContext is rejected with distinct failure class", () => {
  const corpus = loadCorpus();
  const base = corpus.cases.find((c) => c.id === "identical-bindings-stable");
  const bad = replayPromptAssemblyDeterminismCase({
    ...base,
    turnContext: { ...base.turnContext, subjectId: "intruder" },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "cross_subject");
});
