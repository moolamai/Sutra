/**
 * Context budget threshold boundary goldens (74% / 75% / 76%).
 * Fixtures: fixtures/context-budget-threshold/
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTEXT_BUDGET_THRESHOLD_FIXTURE_RELPATH,
  CONTEXT_COMPACTION_THRESHOLD_DEFAULT,
  replayContextBudgetThresholdCase,
  unifiedDiff,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const FIXTURE_DIR = join(PKG, CONTEXT_BUDGET_THRESHOLD_FIXTURE_RELPATH);

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

test("fixture: context-budget-threshold corpus is wired", () => {
  const manifest = loadManifest();
  const corpus = loadCorpus();
  assert.equal(manifest.comparePolicy, "exact-threshold-compare");
  assert.equal(manifest.fixtureFile, "cases.json");
  assert.deepEqual(manifest.thresholdCases, [
    "util-74",
    "util-75",
    "util-76",
  ]);
  assert.ok(corpus.cases.length >= 7);
  const ids = new Set(corpus.cases.map((c) => c.id));
  for (const required of [
    "util-74",
    "util-75",
    "util-76",
    "pending-dynamic-tips-threshold",
    "missing-context-window",
    "zero-headroom",
    "truncate-refusals-preserved",
  ]) {
    assert.ok(ids.has(required), `missing case ${required}`);
  }
  for (const c of corpus.cases) {
    assert.ok(c.specId, `${c.id}: specId required`);
    assert.ok(c.protects, `${c.id}: protects comment required`);
  }
  assert.equal(CONTEXT_COMPACTION_THRESHOLD_DEFAULT, 0.75);
});

test("happy path: every golden case byte-compares", () => {
  const corpus = loadCorpus();
  for (const fixtureCase of corpus.cases) {
    const result = replayContextBudgetThresholdCase(fixtureCase);
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
  }
  log({
    event: "runtime.harness.context_budget",
    outcome: "ok",
    case: "threshold_corpus",
    caseCount: corpus.cases.length,
  });
});

test("invariant: compaction signal only at/above 75%", () => {
  const corpus = loadCorpus();
  const byId = Object.fromEntries(corpus.cases.map((c) => [c.id, c]));
  const u74 = replayContextBudgetThresholdCase(byId["util-74"]);
  const u75 = replayContextBudgetThresholdCase(byId["util-75"]);
  const u76 = replayContextBudgetThresholdCase(byId["util-76"]);
  assert.equal(u74.ok, true);
  assert.equal(u75.ok, true);
  assert.equal(u76.ok, true);
  assert.equal(u74.shouldCompact, false);
  assert.equal(u75.shouldCompact, true);
  assert.equal(u76.shouldCompact, true);
});

test("edge: refusals preserved under truncation; missing window advisory", () => {
  const corpus = loadCorpus();
  const byId = Object.fromEntries(corpus.cases.map((c) => [c.id, c]));
  const trunc = replayContextBudgetThresholdCase(
    byId["truncate-refusals-preserved"],
  );
  assert.equal(trunc.ok, true);
  const missing = replayContextBudgetThresholdCase(
    byId["missing-context-window"],
  );
  assert.equal(missing.ok, true);
  const zero = replayContextBudgetThresholdCase(byId["zero-headroom"]);
  assert.equal(zero.ok, true);
  assert.equal(zero.shouldCompact, true);
});

test("sovereignty: telemetry never carries refusal or dynamic plaintext", () => {
  const corpus = loadCorpus();
  for (const fixtureCase of corpus.cases) {
    const result = replayContextBudgetThresholdCase(fixtureCase);
    assert.equal(result.ok, true);
    const wire = JSON.stringify(result.telemetry);
    if (fixtureCase.input?.refusals) {
      for (const r of fixtureCase.input.refusals) {
        assert.ok(
          !wire.includes(r),
          `${fixtureCase.id}: refusal leaked in telemetry`,
        );
      }
    }
    if (fixtureCase.input?.pendingDynamicBlock) {
      // Long pads of "x" are not sensitive; skip content check for pads.
      if (!/^x+$/.test(fixtureCase.input.pendingDynamicBlock)) {
        assert.ok(
          !wire.includes(fixtureCase.input.pendingDynamicBlock),
          `${fixtureCase.id}: pending dynamic leaked`,
        );
      }
    }
    assert.ok(
      result.telemetry.every(
        (e) => e.event === "runtime.harness.context_budget",
      ),
    );
    assert.ok(
      result.telemetry.some((e) => e.subjectId === fixtureCase.subjectId),
    );
  }
});

test("scalability / concurrency: parallel replays stay idempotent", async () => {
  const corpus = loadCorpus();
  const target = corpus.cases.find((c) => c.id === "util-75");
  assert.ok(target);
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      Promise.resolve(replayContextBudgetThresholdCase(target)),
    ),
  );
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.shouldCompact, true);
    assert.equal(
      result.canonicalExpectationJson,
      result.expectedCanonicalExpectationJson,
    );
  }
});
