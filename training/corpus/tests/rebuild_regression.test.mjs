/**
 * Byte-identical rebuild regression: golden ×2 identical; poison fixture diverges.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORPUS_PACKAGE_ROOT,
  buildCorpusFromManifest,
  compareCorpusOutTrees,
  loadCorpusManifestFile,
  poisonCorpusTreeWithWallClock,
  proveByteIdenticalRebuild,
  runProveRebuildCli,
} from "../dist/build.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const VALID_MANIFEST = path.join(PKG_ROOT, "fixtures", "valid", "minimal.json");
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

test("prove: golden rebuild is byte-identical and nondeterminism fixture diverges", () => {
  const events = [];
  const result = proveByteIdenticalRebuild({
    packageRoot: CORPUS_PACKAGE_ROOT,
    subjectId: "subj.corpus.prove.ok",
    deviceId: "dev-corpus-prove",
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.goldenIdentical, true);
  assert.equal(result.nondeterminismDetected, true);
  assert.equal(result.retExcludedFromWeight, true);
  assert.equal(result.decontaminationPassed, true);
  assert.equal(result.failures.length, 0);
  assert.ok((result.fileCount ?? 0) >= 2);

  assert.ok(
    events.some((e) => e.op === "prove_rebuild" && e.outcome === "ok"),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: wall-clock poison makes otherwise-identical trees diverge", () => {
  const loaded = loadCorpusManifestFile(VALID_MANIFEST);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const a = mkdtempSync(path.join(tmpdir(), "corpus-poison-edge-a-"));
  const b = mkdtempSync(path.join(tmpdir(), "corpus-poison-edge-b-"));
  try {
    const r1 = buildCorpusFromManifest(loaded.value, a, {
      packageRoot: CORPUS_PACKAGE_ROOT,
    });
    const r2 = buildCorpusFromManifest(loaded.value, b, {
      packageRoot: CORPUS_PACKAGE_ROOT,
    });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    if (!r1.ok || !r2.ok) return;

    assert.equal(compareCorpusOutTrees(a, b).identical, true);
    poisonCorpusTreeWithWallClock(a, 111);
    poisonCorpusTreeWithWallClock(b, 222);
    const cmp = compareCorpusOutTrees(a, b);
    assert.equal(cmp.identical, false);
    assert.ok(cmp.mismatched?.length);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("edge: missing manifest fails prove with typed outcome", () => {
  const missing = path.join(tmpdir(), "corpus-missing-manifest-does-not-exist.json");
  const events = [];
  const result = proveByteIdenticalRebuild({
    manifestPath: missing,
    packageRoot: CORPUS_PACKAGE_ROOT,
    subjectId: "subj.corpus.prove.missing",
    deviceId: "dev-corpus-prove",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, false);
  assert.equal(result.goldenIdentical, false);
  assert.ok(result.failures.length >= 1);
  assert.ok(
    events.some((e) => e.op === "prove_rebuild" && e.outcome === "error"),
  );
});

test("sovereignty: prove telemetry carries subjectId and never raw content", () => {
  const events = [];
  proveByteIdenticalRebuild({
    packageRoot: CORPUS_PACKAGE_ROOT,
    subjectId: "subj.corpus.prove.iso",
    deviceId: "dev-corpus-prove-iso",
    onTelemetry: (e) => events.push(e),
  });
  const proveEvents = events.filter((e) => e.op === "prove_rebuild");
  assert.ok(proveEvents.length >= 1);
  for (const e of proveEvents) {
    assert.equal(e.subjectId, "subj.corpus.prove.iso");
    assert.equal(e.deviceId, "dev-corpus-prove-iso");
  }
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(events).includes("A ratio compares"));
});

test("CLI: prove-rebuild exits 0 on golden fixture", () => {
  const code = runProveRebuildCli(["--manifest", VALID_MANIFEST], {
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  assert.equal(code, 0);
});

test("CLI: prove-rebuild exits non-zero on missing manifest", () => {
  const missing = path.join(
    mkdtempSync(path.join(tmpdir(), "corpus-cli-missing-")),
    "nope.json",
  );
  const code = runProveRebuildCli(["--manifest", missing], {
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  assert.equal(code, 1);
});
