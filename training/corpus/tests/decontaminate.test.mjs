/**
 * Exact-hash decontamination against C0 baseline registry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORPUS_PACKAGE_ROOT,
  buildCorpusFromManifest,
  loadCorpusManifestFile,
} from "../dist/build.js";
import {
  DECONTAM_METHOD_EXACT_HASH,
  runExactHashDecontamination,
  resolveCorpusBaselineRegistryPath,
  runFuzzyNearDupDedup,
  computeSimHash64Hex,
  simHashSimilarityHex,
  nearDupCheckAgainstBaselines,
} from "../dist/decontaminate.js";
import {
  loadBaselineRegistryDocumentFromFile,
} from "@moolam/learning";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const VALID_MANIFEST = path.join(PKG_ROOT, "fixtures", "valid", "minimal.json");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

function sha256Prefixed(buf) {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

test("happy path: exact-hash decontam passes clean corpus docs", () => {
  const registryPath = resolveCorpusBaselineRegistryPath(
    "training/eval/baseline_registry.json",
    CORPUS_PACKAGE_ROOT,
  );
  const events = [];
  const result = runExactHashDecontamination({
    registryPath,
    baselineRegistryRelpath: "training/eval/baseline_registry.json",
    documents: [
      {
        docId: "doc.clean.1",
        contentHash:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ],
    deviceId: "dev-decontam",
    onRegistryTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.proof.status, "passed");
  assert.equal(result.proof.method, DECONTAM_METHOD_EXACT_HASH);
  assert.ok(result.proof.registryHashCount >= 1);
  assert.ok(events.some((e) => e.action === "decontam_check" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: document hash collision emits offendingDocIds", () => {
  const registryPath = resolveCorpusBaselineRegistryPath(
    "training/eval/baseline_registry.json",
    CORPUS_PACKAGE_ROOT,
  );
  const smokeBytes = readFileSync(
    path.join(REPO_ROOT, "training/eval/fixtures/smoke-baseline.json"),
  );
  const smokeHash = sha256Prefixed(smokeBytes);
  const result = runExactHashDecontamination({
    registryPath,
    documents: [
      { docId: "doc.leaked.eval", contentHash: smokeHash },
      {
        docId: "doc.clean",
        contentHash:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "contamination");
  assert.deepEqual(result.offendingDocIds, ["doc.leaked.eval"]);
  assert.match(result.message, /offendingDocIds=\[doc\.leaked\.eval\]/);
  assert.equal(result.proof.status, "failed");
  assert.equal(result.proof.collidingSetId, "smoke.eval.v1");
});

test("edge: missing registry is a typed config failure", () => {
  const missing = path.join(tmpdir(), "no-such-baseline-registry.json");
  const result = runExactHashDecontamination({
    registryPath: missing,
    documents: [],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "config");
  assert.equal(result.proof.status, "failed");
});

test("edge: newly pinned registry requires rebuild — hash pin differs", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "corpus-decontam-pin-"));
  try {
    const loaded = loadCorpusManifestFile(VALID_MANIFEST);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const und = path.join(PKG_ROOT, "fixtures", "sources", "teacher-und-ratios.jsonl");
    const undHash = sha256Prefixed(readFileSync(und));
    const regPath = path.join(tmp, "baseline_registry.json");
    writeFileSync(
      regPath,
      JSON.stringify({
        schemaVersion: "baseline-registry.v1",
        entries: [
          {
            setId: "fixture.und.as.eval",
            version: 1,
            kind: "guidance",
            contentHash: undHash,
            sourcePath: "fixtures/sources/teacher-und-ratios.jsonl",
            sliceTags: {
              domainPack: "teacher",
              language: "en",
              binding: "edge",
            },
            pinnedSeed: 7,
            locality: "on-device",
          },
        ],
      }),
    );

    const manifest = structuredClone(loaded.value);
    manifest.decontaminationProof = {
      status: "pending",
      baselineRegistryRelpath: regPath,
    };
    const out = path.join(tmp, "out");
    const result = buildCorpusFromManifest(manifest, out, {
      packageRoot: PKG_ROOT,
      manifestDir: PKG_ROOT,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failureClass, "contamination");
      assert.match(result.message, /offendingDocIds=/);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sovereignty: build report proof has no raw content; subject-scoped telemetry", () => {
  const events = [];
  const loaded = loadCorpusManifestFile(VALID_MANIFEST);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const tmp = mkdtempSync(path.join(tmpdir(), "corpus-decontam-proof-"));
  try {
    const result = buildCorpusFromManifest(loaded.value, tmp, {
      packageRoot: CORPUS_PACKAGE_ROOT,
      subjectId: "subj.corpus.decontam",
      deviceId: "dev-decontam",
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.report.decontamination.status, "passed");
    assert.equal(
      result.report.decontamination.method,
      "exact_hash+simhash_near_dup",
    );
    assert.ok((result.report.decontamination.registryHashCount ?? 0) >= 1);
    assert.equal(result.report.dedup?.status, "recorded");
    assert.equal(result.report.dedup?.algorithm, "sha256+fuzzy");
    assert.ok(existsSync(path.join(tmp, "dedup-report.json")));
    assert.ok(
      events.some(
        (e) =>
          e.op === "decontam" &&
          e.outcome === "ok" &&
          e.subjectId === "subj.corpus.decontam",
      ),
    );
    const blob = JSON.stringify({ events, report: result.report });
    assert.ok(!blob.includes(SECRET));
    assert.ok(!blob.includes("A ratio compares"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("happy path: simhash is deterministic; fuzzy dedup drops near-dups per lane", () => {
  const a = computeSimHash64Hex("Equivalent ratios represent the same comparison.");
  const b = computeSimHash64Hex("Equivalent ratios represent the same comparison.");
  assert.equal(a, b);
  assert.equal(simHashSimilarityHex(a, b), 1);

  const paraphrase = computeSimHash64Hex(
    "Equivalent ratios represent the same comparison!",
  );
  assert.ok(simHashSimilarityHex(a, paraphrase) >= 0.85);

  const result = runFuzzyNearDupDedup(
    [
      {
        docId: "doc.a",
        laneCode: "teacher",
        text: "Equivalent ratios represent the same comparison.",
        contentHash: sha256Prefixed(
          "Equivalent ratios represent the same comparison.",
        ),
      },
      {
        docId: "doc.b",
        laneCode: "teacher",
        text: "Equivalent ratios represent the same comparison!",
        contentHash: sha256Prefixed(
          "Equivalent ratios represent the same comparison!",
        ),
      },
      {
        docId: "doc.c",
        laneCode: "smoke",
        text: "Equivalent ratios represent the same comparison!",
        contentHash: sha256Prefixed(
          "Equivalent ratios represent the same comparison!",
        ),
      },
    ],
    {
      algorithm: "sha256+fuzzy",
      fuzzyThreshold: 0.85,
      laneThresholds: { teacher: 0.85, smoke: 1.0 },
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.report.droppedDocIds, ["doc.b"]);
  assert.equal(result.kept.length, 2);
  assert.ok(result.kept.some((d) => d.docId === "doc.c"));
  assert.equal(result.report.laneThresholds.teacher, 0.85);
  assert.equal(result.report.laneThresholds.smoke, 1.0);
});

test("edge: too-tight lane threshold keeps paraphrases; too-loose drops them", () => {
  const docs = [
    {
      docId: "doc.keep",
      laneCode: "teacher",
      text: "A ratio compares two quantities by division.",
      contentHash: sha256Prefixed(
        "A ratio compares two quantities by division.",
      ),
    },
    {
      docId: "doc.para",
      laneCode: "teacher",
      text: "A ratio compares two quantities by division!",
      contentHash: sha256Prefixed(
        "A ratio compares two quantities by division!",
      ),
    },
  ];
  const tight = runFuzzyNearDupDedup(docs, {
    algorithm: "sha256+fuzzy",
    fuzzyThreshold: 0.999,
  });
  assert.equal(tight.ok, true);
  if (!tight.ok) return;
  assert.equal(tight.report.droppedDocIds.length, 0);

  const loose = runFuzzyNearDupDedup(docs, {
    algorithm: "sha256+fuzzy",
    fuzzyThreshold: 0.8,
  });
  assert.equal(loose.ok, true);
  if (!loose.ok) return;
  assert.deepEqual(loose.report.droppedDocIds, ["doc.para"]);
});

test("edge: near-dup against baseline registry fails with offendingDocIds", () => {
  const registryPath = resolveCorpusBaselineRegistryPath(
    "training/eval/baseline_registry.json",
    CORPUS_PACKAGE_ROOT,
  );
  const loaded = loadBaselineRegistryDocumentFromFile(registryPath);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const smokeText = readFileSync(
    path.join(REPO_ROOT, "training/eval/fixtures/smoke-baseline.json"),
    "utf8",
  );
  const result = nearDupCheckAgainstBaselines({
    document: loaded.document,
    repoRoot: REPO_ROOT,
    baselineRegistryRelpath: "training/eval/baseline_registry.json",
    documents: [
      {
        docId: "doc.near.eval",
        text: smokeText,
        laneCode: "smoke",
      },
    ],
    fuzzyThreshold: 0.92,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "contamination");
  assert.deepEqual(result.offendingDocIds, ["doc.near.eval"]);
  assert.match(result.message, /near-dup/i);
});
