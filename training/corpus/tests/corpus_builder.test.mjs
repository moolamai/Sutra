/**
 * Deterministic corpus builder: filters, content-addressed shards, byte-identical rebuild.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORPUS_PACKAGE_ROOT,
  buildCorpusFromManifest,
  loadCorpusManifestFile,
  runBuildCorpusCli,
} from "../dist/build.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const VALID_MANIFEST = path.join(PKG_ROOT, "fixtures", "valid", "minimal.json");
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

function listFilesRecursive(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

test("happy path: build emits weight + retrieve shards and report", () => {
  const events = [];
  const tmp = mkdtempSync(path.join(tmpdir(), "corpus-build-"));
  try {
    const loaded = loadCorpusManifestFile(VALID_MANIFEST);
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    if (!loaded.ok) return;

    const result = buildCorpusFromManifest(loaded.value, tmp, {
      packageRoot: CORPUS_PACKAGE_ROOT,
      manifestDir: path.dirname(VALID_MANIFEST),
      subjectId: "subj.corpus.build.ok",
      deviceId: "dev-corpus",
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;

    assert.equal(result.report.weightShardCount, 1);
    assert.equal(result.report.retrieveShardCount, 1);
    assert.equal(result.report.decontamination.status, "passed");
    assert.ok(existsSync(path.join(tmp, "build-report.json")));
    assert.ok(existsSync(path.join(tmp, result.licenseLedgerRelpath)));
    assert.match(result.report.licenseLedgerHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.report.licenseLedgerRelpath, "license-ledger.json");
    assert.ok(Array.isArray(result.report.excludedShards));

    const ledger = JSON.parse(
      readFileSync(path.join(tmp, result.licenseLedgerRelpath), "utf8"),
    );
    assert.equal(ledger.schemaVersion, "training.license-ledger.v1");
    assert.equal(ledger.manifestId, loaded.value.manifestId);
    assert.equal(ledger.entries.length, 2);
    assert.ok(ledger.entries.every((e) => e.syntheticFlag === true));
    assert.ok(ledger.entries.every((e) => e.governmentFlag === false));
    assert.ok(result.weightShardRelpaths.every((p) => p.startsWith("weight/")));
    assert.ok(
      result.retrieveShardRelpaths.every((p) => p.startsWith("retrieve/")),
    );

    const weightShard = JSON.parse(
      readFileSync(path.join(tmp, result.weightShardRelpaths[0]), "utf8"),
    );
    assert.equal(weightShard.mix, "weight");
    assert.equal(weightShard.knowledgeMode, "UND");
    assert.notEqual(weightShard.knowledgeMode, "RET");

    const retShard = JSON.parse(
      readFileSync(path.join(tmp, result.retrieveShardRelpaths[0]), "utf8"),
    );
    assert.equal(retShard.mix, "retrieve");
    assert.equal(retShard.knowledgeMode, "RET");

    assert.ok(events.some((e) => e.op === "build" && e.outcome === "ok"));
    assert.ok(events.some((e) => e.op === "decontam" && e.outcome === "ok"));
    assert.ok(
      events.some((e) => e.op === "license_ledger" && e.outcome === "ok"),
    );
    assert.ok(!JSON.stringify(events).includes(SECRET));
    assert.ok(!JSON.stringify(events).includes("A ratio compares"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("happy path: two builds are byte-identical", () => {
  const loaded = loadCorpusManifestFile(VALID_MANIFEST);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const a = mkdtempSync(path.join(tmpdir(), "corpus-build-a-"));
  const b = mkdtempSync(path.join(tmpdir(), "corpus-build-b-"));
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

    const filesA = listFilesRecursive(a).map((p) => path.relative(a, p));
    const filesB = listFilesRecursive(b).map((p) => path.relative(b, p));
    assert.deepEqual(filesA, filesB);
    for (const rel of filesA) {
      assert.deepEqual(
        readFileSync(path.join(a, rel)),
        readFileSync(path.join(b, rel)),
        rel,
      );
    }
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("edge: contentHash mismatch fails the build", () => {
  const loaded = loadCorpusManifestFile(VALID_MANIFEST);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const bad = structuredClone(loaded.value);
  bad.sources[0].contentHash =
    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

  const tmp = mkdtempSync(path.join(tmpdir(), "corpus-build-hash-"));
  try {
    const result = buildCorpusFromManifest(bad, tmp, {
      packageRoot: CORPUS_PACKAGE_ROOT,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failureClass, "hash_mismatch");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: eval contamination is a hard build failure", () => {
  const loaded = loadCorpusManifestFile(VALID_MANIFEST);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const tmpRoot = mkdtempSync(path.join(tmpdir(), "corpus-contam-"));
  try {
    const srcDir = path.join(tmpRoot, "fixtures", "sources");
    mkdirSync(srcDir, { recursive: true });
    // Copy smoke baseline bytes as a "training" source → must collide.
    const smoke = path.resolve(
      CORPUS_PACKAGE_ROOT,
      "..",
      "eval",
      "fixtures",
      "smoke-baseline.json",
    );
    const contamPath = path.join(srcDir, "contam.jsonl");
    // Use the exact baseline file bytes but name as jsonl path in manifest;
    // decontam checks contentHash against registry.
    cpSync(smoke, contamPath);

    const hash = `sha256:${createHash("sha256").update(readFileSync(contamPath)).digest("hex")}`;

    const manifest = structuredClone(loaded.value);
    manifest.sources = [
      {
        sourceId: "src.contam.smoke",
        relpath: "fixtures/sources/contam.jsonl",
        licenseId: "lic.cc-by-4.0",
        knowledgeMode: "UND",
        laneCode: "teacher",
        contentHash: hash,
      },
    ];
    manifest.knowledgeModes = ["UND"];

    // Write a tiny registry that includes this hash.
    const regPath = path.join(tmpRoot, "baseline_registry.json");
    writeFileSync(
      regPath,
      JSON.stringify({
        schemaVersion: "baseline-registry.v1",
        entries: [
          {
            setId: "smoke.eval.v1",
            version: 1,
            kind: "nfr",
            contentHash: hash,
            sourcePath: "fixtures/sources/contam.jsonl",
            sliceTags: {
              domainPack: "smoke",
              language: "en",
              binding: "edge",
            },
            pinnedSeed: 42,
            locality: "on-device",
          },
        ],
      }),
    );
    manifest.decontaminationProof = {
      status: "pending",
      baselineRegistryRelpath: regPath,
    };

    const out = path.join(tmpRoot, "out");
    const result = buildCorpusFromManifest(manifest, out, {
      packageRoot: tmpRoot,
      manifestDir: tmpRoot,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failureClass, "contamination");
      assert.match(result.message, /train-on-eval|offendingDocIds/i);
      assert.match(result.message, /src\.contam\.smoke/);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("happy path: CLI exits 0 and writes shards", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "corpus-cli-"));
  try {
    const out = [];
    const err = [];
    const code = runBuildCorpusCli(
      ["--manifest", VALID_MANIFEST, "--out", tmp, "--package-root", PKG_ROOT],
      {
        stdout: { write(s) { out.push(s); } },
        stderr: { write(s) { err.push(s); } },
      },
    );
    assert.equal(code, 0, err.join(""));
    assert.match(out.join(""), /"outcome":"ok"/);
    assert.ok(existsSync(path.join(tmp, "build-report.json")));
    assert.ok(existsSync(path.join(tmp, "weight")));
    assert.ok(existsSync(path.join(tmp, "retrieve")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sovereignty: RET never appears in weight mix shards", () => {
  const loaded = loadCorpusManifestFile(VALID_MANIFEST);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const tmp = mkdtempSync(path.join(tmpdir(), "corpus-ret-"));
  try {
    const result = buildCorpusFromManifest(loaded.value, tmp, {
      packageRoot: CORPUS_PACKAGE_ROOT,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    for (const rel of result.weightShardRelpaths) {
      const shard = JSON.parse(readFileSync(path.join(tmp, rel), "utf8"));
      assert.notEqual(shard.knowledgeMode, "RET");
      assert.equal(shard.mix, "weight");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: unknown license source excluded with reason; ledger omits it", () => {
  const loaded = loadCorpusManifestFile(VALID_MANIFEST);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const tmp = mkdtempSync(path.join(tmpdir(), "corpus-unk-lic-"));
  try {
    const manifest = structuredClone(loaded.value);
    // Keep catalog valid; add a source with unknown licenseId → excluded at build.
    manifest.sources.push({
      sourceId: "src.unknown.license",
      relpath: "fixtures/sources/teacher-und-ratios.jsonl",
      licenseId: "lic.not-in-ledger",
      knowledgeMode: "UND",
      laneCode: "teacher",
      contentHash: manifest.sources[0].contentHash,
    });
    const result = buildCorpusFromManifest(manifest, tmp, {
      packageRoot: CORPUS_PACKAGE_ROOT,
      manifestDir: path.dirname(VALID_MANIFEST),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(result.report.excludedSourceIds.includes("src.unknown.license"));
    const excl = result.report.excludedShards.find(
      (e) => e.sourceId === "src.unknown.license",
    );
    assert.ok(excl);
    assert.equal(excl.reason, "unknown_license");
    const ledger = JSON.parse(
      readFileSync(path.join(tmp, result.licenseLedgerRelpath), "utf8"),
    );
    assert.ok(
      !ledger.entries.some((e) => e.sourceId === "src.unknown.license"),
    );
    assert.equal(ledger.entries.length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
