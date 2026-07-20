/**
 * Version distillation set as corpus-compatible manifest.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORPUS_MANIFEST_SCHEMA_VERSION,
  DISTILLATION_BASELINE_REGISTRY_RELPATH,
  DISTILLATION_PACKAGE_ROOT,
  versionDistillationSetAsCorpusManifest,
} from "../dist/generate_traces.js";
import { parseCorpusManifest } from "@moolam/training-corpus";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
const FIXTURES = path.join(PKG, "fixtures", "teacher");
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";
const REPO_ROOT = path.resolve(PKG, "..", "..");

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}

function baseFromFixture(fx, overrides = {}) {
  return {
    subjectId: fx.subjectId,
    sessionId: fx.sessionId,
    turnId: fx.turnId,
    deviceId: fx.deviceId,
    correlationId: fx.correlationId,
    locality: fx.locality,
    consent: fx.consent,
    teacherChunks: fx.teacherChunks,
    pinnedAt: fx.pinnedAt,
    ...overrides,
  };
}

function firstBaselineHash() {
  const registry = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, DISTILLATION_BASELINE_REGISTRY_RELPATH),
      "utf8",
    ),
  );
  assert.ok(registry.entries?.length >= 1);
  return registry.entries[0].contentHash;
}

test("unit: corpus manifest schema version + baseline pin", () => {
  assert.equal(DISTILLATION_PACKAGE_ROOT, PKG);
  assert.equal(CORPUS_MANIFEST_SCHEMA_VERSION, "training.corpus-manifest.v1");
  assert.ok(
    existsSync(path.join(REPO_ROOT, DISTILLATION_BASELINE_REGISTRY_RELPATH)),
  );
});

test("happy path: export filtered traces as corpus-compatible manifest", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const tmp = mkdtempSync(path.join(tmpdir(), "distill-manifest-"));
  const events = [];
  try {
    const result = await versionDistillationSetAsCorpusManifest({
      jobs: [baseFromFixture(fx)],
      manifestId: "corpus.distill.teacher.v1",
      version: "1.0.0",
      title: "Teacher distillation smoke set",
      consentClass: "synthetic",
      outDir: tmp,
      subjectId: fx.subjectId,
      deviceId: fx.deviceId,
      packageRoot: PKG,
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.manifestId, "corpus.distill.teacher.v1");
    assert.equal(result.consentClass, "synthetic");
    assert.equal(result.shardCount, 1);
    assert.equal(result.decontam.status, "passed");
    assert.ok(existsSync(result.manifestPath));
    assert.ok(existsSync(path.join(tmp, "grammar-filter-report.json")));
    assert.ok(existsSync(path.join(tmp, "shards", `${fx.turnId}.json`)));

    const raw = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    assert.equal(raw.schemaVersion, "training.corpus-manifest.v1");
    assert.equal(raw.decontaminationProof.status, "recorded");
    const parsed = parseCorpusManifest(raw, {
      subjectId: fx.subjectId,
      deviceId: fx.deviceId,
    });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));

    assert.ok(events.some((e) => e.op === "export" && e.outcome === "ok"));
    assert.ok(events.every((e) => e.subjectId === fx.subjectId));
    assert.ok(!JSON.stringify(events).includes(SECRET));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: eval-overlap contentHash fails decontam (contamination)", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const tmp = mkdtempSync(path.join(tmpdir(), "distill-contam-"));
  try {
    const result = await versionDistillationSetAsCorpusManifest({
      jobs: [baseFromFixture(fx)],
      manifestId: "corpus.distill.contam",
      version: "1.0.0",
      consentClass: "synthetic",
      outDir: tmp,
      packageRoot: PKG,
      contentHashOverrides: {
        [fx.turnId]: firstBaselineHash(),
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureClass, "contamination");
    assert.match(result.detail, /decontam|overlap/i);
    assert.equal(existsSync(path.join(tmp, "manifest.json")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: frontier teacher with government consent class excluded", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const tmp = mkdtempSync(path.join(tmpdir(), "distill-gov-"));
  try {
    const result = await versionDistillationSetAsCorpusManifest({
      jobs: [
        baseFromFixture(fx, {
          teacherMode: "frontier",
          consent: {
            optedIn: true,
            consentClass: "research",
            recordedAt: "2026-07-16T00:00:00.000Z",
          },
        }),
      ],
      manifestId: "corpus.distill.frontier-gov",
      version: "1.0.0",
      consentClass: "government",
      requiresThirdPartyProcessing: true,
      outDir: tmp,
      packageRoot: PKG,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureClass, "third_party_excluded");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("idempotent: two exports of the same set yield byte-identical manifests", async () => {
  const fx = loadFixture("valid-thought-answer.json");
  const aDir = mkdtempSync(path.join(tmpdir(), "distill-a-"));
  const bDir = mkdtempSync(path.join(tmpdir(), "distill-b-"));
  try {
    const jobs = [baseFromFixture(fx)];
    const opts = {
      jobs,
      manifestId: "corpus.distill.idem",
      version: "1.0.0",
      consentClass: "synthetic",
      packageRoot: PKG,
    };
    const a = await versionDistillationSetAsCorpusManifest({
      ...opts,
      outDir: aDir,
    });
    const b = await versionDistillationSetAsCorpusManifest({
      ...opts,
      outDir: bDir,
    });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.deepEqual(
      readFileSync(a.manifestPath),
      readFileSync(b.manifestPath),
    );
    assert.deepEqual(a.contentHashes, b.contentHashes);
  } finally {
    rmSync(aDir, { recursive: true, force: true });
    rmSync(bDir, { recursive: true, force: true });
  }
});

test("sovereignty: grammar-only drops never write a training manifest", async () => {
  const bad = loadFixture("negative-bad-envelope.json");
  const tmp = mkdtempSync(path.join(tmpdir(), "distill-empty-"));
  try {
    const result = await versionDistillationSetAsCorpusManifest({
      jobs: [baseFromFixture(bad)],
      manifestId: "corpus.distill.empty",
      version: "1.0.0",
      consentClass: "synthetic",
      outDir: tmp,
      packageRoot: PKG,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureClass, "config");
    assert.match(result.detail, /no accepted traces/i);
    assert.equal(existsSync(path.join(tmp, "manifest.json")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
