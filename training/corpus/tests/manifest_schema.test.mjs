/**
 * Corpus manifest schema + validate-on-write tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORPUS_CONSENT_CLASSES,
  CORPUS_KNOWLEDGE_MODES,
  CORPUS_MANIFEST_JSON_SCHEMA_PATH,
  CORPUS_MANIFEST_SCHEMA_VERSION,
  assertCommittedManifestSchemaPresent,
  canonicalManifestBytes,
  canonicalManifestSha256,
  loadCorpusManifestFile,
  parseCorpusManifest,
  weightEligibleKnowledgeModes,
  writeCorpusManifest,
} from "../dist/build.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const VALID_FIXTURE = path.join(PKG_ROOT, "fixtures", "valid", "minimal.json");
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

function loadValid() {
  return JSON.parse(readFileSync(VALID_FIXTURE, "utf8"));
}

test("unit: committed manifest_schema.json declares schema version", () => {
  assertCommittedManifestSchemaPresent();
  assert.ok(existsSync(CORPUS_MANIFEST_JSON_SCHEMA_PATH));
  const schema = JSON.parse(
    readFileSync(CORPUS_MANIFEST_JSON_SCHEMA_PATH, "utf8"),
  );
  assert.equal(schema.properties.schemaVersion.const, CORPUS_MANIFEST_SCHEMA_VERSION);
  assert.deepEqual(schema.properties.knowledgeModes.items.enum, [
    ...CORPUS_KNOWLEDGE_MODES,
  ]);
  assert.deepEqual(schema.properties.consentClass.enum, [
    ...CORPUS_CONSENT_CLASSES,
  ]);
  assert.ok(schema.properties.dedupReport);
  assert.ok(schema.properties.licenseLedger);
  assert.ok(schema.properties.weightTrainingPolicy);
});

test("happy path: valid fixture parses and validates", () => {
  const events = [];
  const result = parseCorpusManifest(loadValid(), {
    subjectId: "subj.corpus.ok",
    deviceId: "dev-corpus",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.value.schemaVersion, CORPUS_MANIFEST_SCHEMA_VERSION);
    assert.equal(result.value.consentClass, "synthetic");
    assert.ok(result.value.weightTrainingPolicy.excludeKnowledgeModes.includes("RET"));
    assert.ok(
      !weightEligibleKnowledgeModes(result.value).includes("RET"),
    );
    assert.ok(result.value.laneCodes.includes("teacher"));
    assert.equal(result.value.dedupReport.status, "pending");
  }
  assert.ok(events.some((e) => e.op === "validate" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(events).includes("fixtures/sources"));
});

test("happy path: writeCorpusManifest is byte-identical across writes", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "corpus-manifest-"));
  try {
    const a = path.join(tmp, "a", "manifest.json");
    const b = path.join(tmp, "b", "manifest.json");
    const input = loadValid();
    // Shuffle array order — canonical write must normalize.
    input.sources = [...input.sources].reverse();
    input.laneCodes = [...input.laneCodes].reverse();

    const w1 = writeCorpusManifest(a, input, {
      subjectId: "subj.corpus.write",
      deviceId: "dev-corpus",
    });
    const w2 = writeCorpusManifest(b, input, {
      subjectId: "subj.corpus.write",
      deviceId: "dev-corpus",
    });
    assert.equal(w1.ok, true);
    assert.equal(w2.ok, true);
    const bytesA = readFileSync(a);
    const bytesB = readFileSync(b);
    assert.deepEqual(bytesA, bytesB);
    if (w1.ok) {
      assert.deepEqual(bytesA, canonicalManifestBytes(w1.value));
      assert.match(canonicalManifestSha256(w1.value), /^sha256:[a-f0-9]{64}$/);
    }
    const reloaded = loadCorpusManifestFile(a);
    assert.equal(reloaded.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: unknown licenseId is rejected (exclude / hard fail on write)", () => {
  const bad = loadValid();
  bad.sources[0].licenseId = "lic.unknown";
  const result = parseCorpusManifest(bad, {
    subjectId: "subj.corpus.license",
    deviceId: "dev-corpus",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failureClass, "license");
    assert.match(result.message, /unknown licenseId/i);
  }
});

test("edge: RET not excluded from weight policy fails ret_policy", () => {
  const bad = loadValid();
  bad.weightTrainingPolicy.excludeKnowledgeModes = ["MEM"];
  const result = parseCorpusManifest(bad, {
    subjectId: "subj.corpus.ret",
    deviceId: "dev-corpus",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failureClass, "ret_policy");
  }
});

test("edge: RET sources without exclude_ret_from_weights filter fail", () => {
  const bad = loadValid();
  bad.filters = bad.filters.filter((f) => f.kind !== "exclude_ret_from_weights");
  const result = parseCorpusManifest(bad);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failureClass, "ret_policy");
  }
});

test("edge: write rejects invalid and does not create a partial file", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "corpus-manifest-bad-"));
  try {
    const out = path.join(tmp, "manifest.json");
    const bad = loadValid();
    bad.consentClass = "not-a-class";
    const result = writeCorpusManifest(out, bad, {
      subjectId: "subj.corpus.badwrite",
      deviceId: "dev-corpus",
    });
    assert.equal(result.ok, false);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sovereignty: telemetry is subject-scoped; no raw content", () => {
  const events = [];
  parseCorpusManifest(loadValid(), {
    subjectId: "subj.corpus.iso-a",
    deviceId: "dev-a",
    onTelemetry: (e) => events.push(e),
  });
  parseCorpusManifest(loadValid(), {
    subjectId: "subj.corpus.iso-b",
    deviceId: "dev-b",
    onTelemetry: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.subjectId === "subj.corpus.iso-a"));
  assert.ok(events.some((e) => e.subjectId === "subj.corpus.iso-b"));
  assert.ok(events.every((e) => e.event === "training.corpus_manifest"));
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes(SECRET));
});

test("scalability: source / lane / filter limits are finite constants", async () => {
  const mod = await import("../dist/build.js");
  assert.ok(mod.CORPUS_SOURCES_LIMIT > 0 && mod.CORPUS_SOURCES_LIMIT <= 8192);
  assert.ok(mod.CORPUS_LANES_LIMIT > 0 && mod.CORPUS_LANES_LIMIT <= 256);
  assert.ok(mod.CORPUS_FILTERS_LIMIT > 0 && mod.CORPUS_FILTERS_LIMIT <= 256);
});
