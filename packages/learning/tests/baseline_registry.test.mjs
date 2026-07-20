/**
 * Baseline registry schema + hash-validating loader.
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_HASH_EXPORT_SCHEMA_VERSION,
  BASELINE_KINDS,
  BASELINE_REGISTRY_RELPATH,
  BASELINE_REGISTRY_SCHEMA_VERSION,
  REQUIRED_PROMOTE_BASELINE_SET_IDS,
  assertAppendOnlyEntry,
  assertCorpusBuildDecontamProof,
  assertCorpusContentHashesDecontaminated,
  assertCorpusDocumentsExactHashDecontaminated,
  assertCorpusDocumentsNearDupDecontaminated,
  assertEvalBaselinesExcludedFromTrainingCorpus,
  assertPromotionBaselinesPresent,
  assertRegistryCompleteAgainstKnownEvalDirectories,
  assertRequiredBaselinesPresent,
  computeBaselineContentHash,
  evaluateChampionChallengerGate,
  exportRegisteredBaselineHashes,
  ingestCanonicalBaselines,
  loadBaselineRegistry,
  loadBaselineRegistryApi,
  lookupLatestBaseline,
  parseBaselineRegistryDocument,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "learning.baseline_registry.test", ...event })}\n`,
  );
}

function smokeEntry(overrides = {}) {
  return {
    setId: "smoke.eval.v1",
    version: 1,
    kind: "nfr",
    contentHash:
      "sha256:29619d77bbc2e6eb4f0b9b3464726f6bfb490d255fe56a3a4863406a8925c5cc",
    sourcePath: "training/eval/fixtures/smoke-baseline.json",
    sliceTags: {
      domainPack: "smoke",
      language: "en",
      binding: "edge",
    },
    pinnedSeed: 42,
    locality: "on-device",
    ...overrides,
  };
}

test("happy path: committed registry loads; hashes validate on read", async () => {
  const telemetry = [];
  const result = await loadBaselineRegistry({
    repoRoot: REPO_ROOT,
    deviceId: "ci-loader",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(result.ok, true);
  assert.equal(result.document.schemaVersion, BASELINE_REGISTRY_SCHEMA_VERSION);
  assert.equal(result.registryPath, BASELINE_REGISTRY_RELPATH);
  assert.ok(result.document.entries.length >= 1);
  const smoke = lookupLatestBaseline(result.document, "smoke.eval.v1");
  assert.ok(smoke);
  assert.equal(smoke.pinnedSeed, 42);
  assert.equal(smoke.sliceTags.domainPack, "smoke");

  const bytes = await readFile(
    path.join(REPO_ROOT, smoke.sourcePath),
  );
  assert.equal(computeBaselineContentHash(bytes), smoke.contentHash);

  assert.ok(telemetry.some((t) => t.outcome === "ok" && t.action === "load"));
  assert.ok(telemetry.every((t) => t.subjectId === null));
  assert.ok(!JSON.stringify(telemetry).includes("utterance"));
  log({
    outcome: "ok",
    case: "load",
    subjectId: null,
    deviceId: "ci-loader",
    entryCount: result.document.entries.length,
  });
});

test("happy path: required baseline present → gate lookup ok (known-good)", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const gate = assertRequiredBaselinesPresent(loaded.document, [
    "smoke.eval.v1",
  ]);
  assert.equal(gate.ok, true);
});

test("edge: hash mismatch rejects with failing slice named (known-regressed)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sutra-baseline-"));
  try {
    const fixtureRel = "training/eval/fixtures/tmp-drift.json";
    const fixtureAbs = path.join(dir, ...fixtureRel.split("/"));
    await mkdir(path.dirname(fixtureAbs), { recursive: true });
    const body = `${JSON.stringify({ id: "drift", items: [] }, null, 2)}\n`;
    await writeFile(fixtureAbs, body, "utf8");
    const actualHash = computeBaselineContentHash(body);

    const registry = {
      schemaVersion: BASELINE_REGISTRY_SCHEMA_VERSION,
      entries: [
        smokeEntry({
          setId: "drift.eval.v1",
          sourcePath: fixtureRel,
          contentHash:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          sliceTags: {
            domainPack: "drift-lane",
            language: "en",
            binding: "edge",
          },
        }),
      ],
    };
    assert.notEqual(actualHash, registry.entries[0].contentHash);
    await writeFile(
      path.join(dir, "training/eval/baseline_registry.json"),
      `${JSON.stringify(registry, null, 2)}\n`,
      "utf8",
    );

    const telemetry = [];
    const result = await loadBaselineRegistry({
      repoRoot: dir,
      onTelemetry: (e) => telemetry.push(e),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, "hash_mismatch");
    assert.equal(result.setId, "drift.eval.v1");
    assert.equal(result.failingSlice, "drift-lane");
    assert.ok(
      telemetry.some(
        (t) =>
          t.failureClass === "hash_mismatch" && t.failingSlice === "drift-lane",
      ),
    );
    log({
      outcome: "rejected",
      case: "hash_mismatch",
      subjectId: null,
      failingSlice: "drift-lane",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edge: append-only — silent hash overwrite rejected", () => {
  const doc = {
    schemaVersion: BASELINE_REGISTRY_SCHEMA_VERSION,
    entries: [smokeEntry()],
  };
  const overwrite = assertAppendOnlyEntry(
    doc,
    smokeEntry({
      contentHash:
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    }),
  );
  assert.equal(overwrite.ok, false);
  assert.equal(overwrite.failureClass, "append_only_violation");
  assert.equal(overwrite.setId, "smoke.eval.v1");

  const bumped = assertAppendOnlyEntry(
    doc,
    smokeEntry({
      version: 2,
      contentHash:
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    }),
  );
  assert.equal(bumped.ok, true);

  const dupDoc = parseBaselineRegistryDocument({
    schemaVersion: BASELINE_REGISTRY_SCHEMA_VERSION,
    entries: [
      smokeEntry(),
      smokeEntry({
        contentHash:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ],
  });
  assert.equal(dupDoc.ok, false);
  assert.equal(dupDoc.failureClass, "append_only_violation");
});

test("edge: missing required baseline names failing setId; path escape rejected", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const missing = assertRequiredBaselinesPresent(loaded.document, [
    "does.not.exist.v1",
  ]);
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_baseline");
  assert.equal(missing.setId, "does.not.exist.v1");
  assert.equal(missing.failingSlice, "does.not.exist.v1");

  const escaped = parseBaselineRegistryDocument({
    schemaVersion: BASELINE_REGISTRY_SCHEMA_VERSION,
    entries: [smokeEntry({ sourcePath: "../secrets/eval.json" })],
  });
  assert.equal(escaped.ok, false);
  assert.ok(
    escaped.failureClass === "path_escape" ||
      escaped.failureClass === "schema_violation",
  );
});

test("sovereignty: registry telemetry never carries learner content bodies", async () => {
  const telemetry = [];
  await loadBaselineRegistry({
    repoRoot: REPO_ROOT,
    deviceId: "edge-aaaa",
    onTelemetry: (e) => telemetry.push(e),
  });
  const blob = JSON.stringify(telemetry);
  assert.ok(!blob.includes("learner"));
  assert.ok(!blob.includes("typed-secret"));
  assert.ok(telemetry.every((t) => t.subjectId === null));
});

test("happy path: A P6 + B8 ingest covers all kinds; promote gate known-good", async () => {
  const telemetry = [];
  const loaded = await loadBaselineRegistry({
    repoRoot: REPO_ROOT,
    deviceId: "ci-ingest",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(loaded.ok, true);
  const kinds = new Set(loaded.document.entries.map((e) => e.kind));
  for (const kind of BASELINE_KINDS) {
    assert.ok(kinds.has(kind), `missing kind ${kind}`);
  }
  assert.ok(lookupLatestBaseline(loaded.document, "a-p6.golden-turns.manifest"));
  assert.ok(lookupLatestBaseline(loaded.document, "b8.guidance.manifest"));
  assert.ok(lookupLatestBaseline(loaded.document, "conformance.wire.bundle"));
  assert.ok(lookupLatestBaseline(loaded.document, "nfr.core-loop.bench.v1"));

  const promote = assertPromotionBaselinesPresent(loaded.document, {
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(promote.ok, true);
  for (const setId of REQUIRED_PROMOTE_BASELINE_SET_IDS) {
    assert.ok(lookupLatestBaseline(loaded.document, setId), setId);
  }

  const again = await ingestCanonicalBaselines({
    repoRoot: REPO_ROOT,
    existing: loaded.document,
    deviceId: "ci-ingest",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(again.ok, true);
  assert.equal(again.appended, 0);
  assert.ok(again.skippedIdentical >= REQUIRED_PROMOTE_BASELINE_SET_IDS.length);
  assert.ok(telemetry.some((t) => t.action === "ingest" && t.outcome === "ok"));
  assert.ok(telemetry.every((t) => t.subjectId === null));
  log({
    outcome: "ok",
    case: "ingest-promote",
    subjectId: null,
    entryCount: loaded.document.entries.length,
  });
});

test("edge: train-on-eval void when corpus path hits registered baseline", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const clean = assertEvalBaselinesExcludedFromTrainingCorpus(loaded.document, [
    "training/corpus/synthetic/teacher-v1.jsonl",
  ]);
  assert.equal(clean.ok, true);

  const telemetry = [];
  const voided = assertEvalBaselinesExcludedFromTrainingCorpus(
    loaded.document,
    [
      "training/corpus/ok.jsonl",
      "packages/sync-protocol/fixtures/golden-turns/thought-answer-basic.json",
    ],
    { onTelemetry: (e) => telemetry.push(e) },
  );
  assert.equal(voided.ok, false);
  assert.equal(voided.failureClass, "train_on_eval_void");
  assert.equal(voided.setId, "a-p6.golden-turns.thought-answer-basic");
  assert.equal(voided.failingSlice, "protocol");
  assert.ok(
    telemetry.some(
      (t) =>
        t.failureClass === "train_on_eval_void" &&
        t.failingSlice === "protocol",
    ),
  );
  log({
    outcome: "rejected",
    case: "train_on_eval_void",
    subjectId: null,
    failingSlice: "protocol",
  });
});

test("edge: ingest rejects silent overwrite of existing hashed row", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const smoke = lookupLatestBaseline(loaded.document, "smoke.eval.v1");
  assert.ok(smoke);
  const tampered = {
    schemaVersion: BASELINE_REGISTRY_SCHEMA_VERSION,
    entries: [
      {
        ...smoke,
        contentHash:
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      },
      ...loaded.document.entries.filter((e) => e.setId !== "smoke.eval.v1"),
    ],
  };
  const result = await ingestCanonicalBaselines({
    repoRoot: REPO_ROOT,
    existing: tampered,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "append_only_violation");
  assert.equal(result.setId, "smoke.eval.v1");
});

function promoteScores(overrides = {}) {
  const base = {};
  for (const setId of REQUIRED_PROMOTE_BASELINE_SET_IDS) {
    base[setId] = 0.9;
  }
  return { ...base, ...overrides };
}

test("happy path: hash export + registry API completeness for C1/C3", async () => {
  const telemetry = [];
  const api = await loadBaselineRegistryApi({
    repoRoot: REPO_ROOT,
    deviceId: "ci-api",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(api.ok, true);
  assert.equal(
    api.export.schemaVersion,
    BASELINE_HASH_EXPORT_SCHEMA_VERSION,
  );
  assert.equal(
    api.export.purpose,
    "corpus_decontamination_and_critic_calibration",
  );
  assert.ok(api.export.contentHashes.length >= REQUIRED_PROMOTE_BASELINE_SET_IDS.length);
  assert.ok(api.export.sourcePaths.includes(
    "packages/sync-protocol/fixtures/golden-turns/manifest.json",
  ));
  assert.ok(api.completeness.artifactCount >= api.export.entries.length);

  const again = exportRegisteredBaselineHashes(api.document);
  assert.equal(again.ok, true);
  assert.equal(
    JSON.stringify(again.export),
    JSON.stringify(api.export),
  );

  const complete = await assertRegistryCompleteAgainstKnownEvalDirectories({
    repoRoot: REPO_ROOT,
    document: api.document,
  });
  assert.equal(complete.ok, true);

  assert.ok(telemetry.some((t) => t.action === "export" && t.outcome === "ok"));
  assert.ok(
    telemetry.some(
      (t) => t.action === "completeness_check" && t.outcome === "ok",
    ),
  );
  assert.ok(telemetry.every((t) => t.subjectId === null));
  const blob = JSON.stringify(telemetry);
  assert.ok(!blob.includes("utterance"));
  log({
    outcome: "ok",
    case: "export-completeness",
    subjectId: null,
    entryCount: api.export.entries.length,
  });
});

test("happy path: known-good challenger promotes; hash decontam clean", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const telemetry = [];
  const gate = evaluateChampionChallengerGate({
    document: loaded.document,
    championScores: promoteScores(),
    challengerScores: promoteScores({
      "smoke.eval.v1": 0.95,
    }),
    surgeryClasses: ["adapter_lora"],
    deviceId: "ci-gate",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.verdict, "promote");

  const decontam = assertCorpusContentHashesDecontaminated(
    loaded.document,
    [
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
    { onTelemetry: (e) => telemetry.push(e) },
  );
  assert.equal(decontam.ok, true);
  assert.ok(
    telemetry.some((t) => t.action === "promote_gate" && t.outcome === "ok"),
  );
});

test("edge: known-regressed challenger rejected with failing slice named", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const telemetry = [];
  const gate = evaluateChampionChallengerGate({
    document: loaded.document,
    championScores: promoteScores(),
    challengerScores: promoteScores({
      "b8.guidance.manifest": 0.4,
    }),
    surgeryClasses: ["router_weights"],
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.verdict, "reject");
  assert.equal(gate.failureClass, "slice_regression");
  assert.equal(gate.setId, "b8.guidance.manifest");
  assert.equal(gate.failingSlice, "guidance");
  assert.ok(
    telemetry.some(
      (t) =>
        t.failureClass === "slice_regression" && t.failingSlice === "guidance",
    ),
  );
  log({
    outcome: "rejected",
    case: "slice_regression",
    subjectId: null,
    failingSlice: "guidance",
  });
});

test("edge: multi-surgery attribution void; hash train-on-eval void", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const multi = evaluateChampionChallengerGate({
    document: loaded.document,
    championScores: promoteScores(),
    challengerScores: promoteScores(),
    surgeryClasses: ["adapter_lora", "router_weights"],
  });
  assert.equal(multi.ok, false);
  assert.equal(multi.failureClass, "attribution_void");

  const smoke = lookupLatestBaseline(loaded.document, "smoke.eval.v1");
  assert.ok(smoke);
  const contaminated = assertCorpusContentHashesDecontaminated(
    loaded.document,
    [smoke.contentHash],
  );
  assert.equal(contaminated.ok, false);
  assert.equal(contaminated.failureClass, "train_on_eval_void");
  assert.equal(contaminated.setId, "smoke.eval.v1");
  assert.equal(contaminated.failingSlice, "smoke");
});

test("edge: document-level exact-hash decontam emits offendingDocIds", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const smoke = lookupLatestBaseline(loaded.document, "smoke.eval.v1");
  assert.ok(smoke);
  const clean = assertCorpusDocumentsExactHashDecontaminated(
    loaded.document,
    [
      {
        docId: "doc.ok",
        contentHash:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    ],
  );
  assert.equal(clean.ok, true);

  const hit = assertCorpusDocumentsExactHashDecontaminated(loaded.document, [
    { docId: "doc.leaked", contentHash: smoke.contentHash },
    {
      docId: "doc.ok2",
      contentHash:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    },
  ]);
  assert.equal(hit.ok, false);
  assert.equal(hit.failureClass, "train_on_eval_void");
  assert.deepEqual(hit.offendingDocIds, ["doc.leaked"]);
  assert.match(hit.detail, /offendingDocIds=\[doc\.leaked\]/);
});

test("edge: simhash near-dup against baseline voids train-on-eval", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const smoke = lookupLatestBaseline(loaded.document, "smoke.eval.v1");
  assert.ok(smoke);
  const smokeText = await readFile(
    path.join(REPO_ROOT, smoke.sourcePath),
    "utf8",
  );
  const clean = assertCorpusDocumentsNearDupDecontaminated(
    loaded.document,
    [
      {
        docId: "doc.ok",
        text: "totally unrelated corpus utterance about fractions",
        laneCode: "teacher",
      },
    ],
    { repoRoot: REPO_ROOT, threshold: 0.92 },
  );
  assert.equal(clean.ok, true);

  const hit = assertCorpusDocumentsNearDupDecontaminated(
    loaded.document,
    [{ docId: "doc.near", text: smokeText, laneCode: "smoke" }],
    { repoRoot: REPO_ROOT, threshold: 0.92 },
  );
  assert.equal(hit.ok, false);
  assert.equal(hit.failureClass, "train_on_eval_void");
  assert.deepEqual(hit.offendingDocIds, ["doc.near"]);
});

test("happy path: build-report decontam proof covers exported registry hashes", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const exported = exportRegisteredBaselineHashes(loaded.document);
  assert.equal(exported.ok, true);
  const ok = assertCorpusBuildDecontamProof(loaded.document, {
    status: "passed",
    method: "exact_hash+simhash_near_dup",
    checkedHashCount: 4,
    registryHashCount: exported.export.contentHashes.length,
    nearDupCheckedDocCount: 2,
  }, { requireNearDup: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.registryHashCount, exported.export.contentHashes.length);

  const bad = assertCorpusBuildDecontamProof(loaded.document, {
    status: "passed",
    checkedHashCount: 1,
    registryHashCount: 0,
  });
  assert.equal(bad.ok, false);
});

test("edge: completeness rejects when known eval file missing from registry", async () => {
  const loaded = await loadBaselineRegistry({ repoRoot: REPO_ROOT });
  assert.equal(loaded.ok, true);
  const stripped = {
    schemaVersion: BASELINE_REGISTRY_SCHEMA_VERSION,
    entries: loaded.document.entries.filter(
      (e) => e.setId !== "a-p6.golden-turns.thought-answer-basic",
    ),
  };
  const telemetry = [];
  const result = await assertRegistryCompleteAgainstKnownEvalDirectories({
    repoRoot: REPO_ROOT,
    document: stripped,
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "missing_baseline");
  assert.equal(result.failingSlice, "golden_turns");
  assert.ok(
    String(result.setId).includes("thought-answer-basic.json"),
  );
  assert.ok(
    telemetry.some(
      (t) =>
        t.action === "completeness_check" &&
        t.failureClass === "missing_baseline",
    ),
  );
});
