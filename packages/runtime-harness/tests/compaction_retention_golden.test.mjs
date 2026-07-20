/**
 * Post-compaction golden constraint retention (refusals + citations).
 * Fixtures: fixtures/compaction-retention/
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPACTION_RETENTION_FIXTURE_RELPATH,
  compileStructuredSummary,
  replayCompactionRetentionCase,
  unifiedDiff,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const FIXTURE_DIR = join(PKG, COMPACTION_RETENTION_FIXTURE_RELPATH);

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

test("fixture: compaction-retention corpus is wired", () => {
  const manifest = loadManifest();
  const corpus = loadCorpus();
  assert.equal(manifest.comparePolicy, "exact-retention-compare");
  assert.equal(manifest.fixtureFile, "cases.json");
  assert.ok(Array.isArray(manifest.requiredCases));
  assert.ok(corpus.cases.length >= 5);
  const ids = new Set(corpus.cases.map((c) => c.id));
  for (const required of manifest.requiredCases) {
    assert.ok(ids.has(required), `missing case ${required}`);
  }
  for (const c of corpus.cases) {
    assert.ok(c.specId, `${c.id}: specId required`);
    assert.ok(c.protects, `${c.id}: protects comment required`);
    assert.ok(c.subjectId, `${c.id}: subjectId required`);
  }
  // Language-neutral JSON — no NaN / Infinity artifacts.
  const raw = readFileSync(join(FIXTURE_DIR, "cases.json"), "utf8");
  assert.ok(!/\bNaN\b/.test(raw));
  assert.ok(!/\bInfinity\b/.test(raw));
});

test("happy path: every golden case byte-compares", () => {
  const corpus = loadCorpus();
  for (const fixtureCase of corpus.cases) {
    const result = replayCompactionRetentionCase(fixtureCase);
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
    event: "runtime.harness.compaction",
    outcome: "ok",
    case: "retention_corpus",
    caseCount: corpus.cases.length,
  });
});

test("invariant: refusals and citations survive forced compaction", () => {
  const corpus = loadCorpus();
  const byId = Object.fromEntries(corpus.cases.map((c) => [c.id, c]));
  const retain = replayCompactionRetentionCase(
    byId["retain-refusal-citation-numeric"],
  );
  assert.equal(retain.ok, true);
  assert.equal(retain.compacted, true);
  assert.match(retain.summaryHash, /^[0-9a-f]{64}$/);

  const second = replayCompactionRetentionCase(
    byId["second-pass-episodic-drop"],
  );
  assert.equal(second.ok, true);
  assert.equal(second.compacted, true);
});

test("edge: empty stub, tool-loop defer, cross-subject reject", () => {
  const corpus = loadCorpus();
  const byId = Object.fromEntries(corpus.cases.map((c) => [c.id, c]));
  const empty = replayCompactionRetentionCase(byId["empty-durable-stub"]);
  assert.equal(empty.ok, true);
  const deferred = replayCompactionRetentionCase(byId["tool-loop-deferred"]);
  assert.equal(deferred.ok, true);
  const cross = replayCompactionRetentionCase(byId["cross-subject-rejected"]);
  assert.equal(cross.ok, true);
});

test("invariant: same durable state → identical summaryHash (determinism)", () => {
  const corpus = loadCorpus();
  const target = corpus.cases.find(
    (c) => c.id === "retain-refusal-citation-numeric",
  );
  assert.ok(target);
  const a = compileStructuredSummary({ state: target.state });
  const b = compileStructuredSummary({ state: target.state });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.summary, b.summary);
  assert.equal(a.summaryHash, b.summaryHash);
  assert.equal(a.summaryHash, target.expected.summaryHash);
  assert.equal(a.usedLlm, false);
});

test("sovereignty: telemetry never carries constraint / citation plaintext", () => {
  const corpus = loadCorpus();
  for (const fixtureCase of corpus.cases) {
    const result = replayCompactionRetentionCase(fixtureCase);
    assert.equal(result.ok, true);
    const wire = JSON.stringify(result.telemetry);
    for (const retain of fixtureCase.mustRetainInSummary ?? []) {
      assert.ok(
        !wire.includes(retain),
        `${fixtureCase.id}: retained string leaked in telemetry: ${retain}`,
      );
    }
    if (fixtureCase.state?.openConstraints) {
      for (const c of fixtureCase.state.openConstraints) {
        assert.ok(
          !wire.includes(c),
          `${fixtureCase.id}: constraint leaked in telemetry`,
        );
      }
    }
    assert.ok(
      result.telemetry.every((e) => e.event === "runtime.harness.compaction"),
    );
    if (fixtureCase.kind !== "cross_subject") {
      assert.ok(
        result.telemetry.some((e) => e.subjectId === fixtureCase.subjectId),
      );
    }
  }
});

test("scalability / concurrency: parallel replays stay idempotent", async () => {
  const corpus = loadCorpus();
  const target = corpus.cases.find(
    (c) => c.id === "retain-refusal-citation-numeric",
  );
  assert.ok(target);
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      Promise.resolve(replayCompactionRetentionCase(target)),
    ),
  );
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.compacted, true);
    assert.equal(
      result.canonicalExpectationJson,
      result.expectedCanonicalExpectationJson,
    );
    assert.equal(result.summaryHash, target.expected.summaryHash);
  }
});
