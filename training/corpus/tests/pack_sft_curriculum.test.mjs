/**
 * Pack SFT curriculum ordering (protocol → tool_use → domain_depth → repair).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORPUS_CURRICULUM_STAGES,
  PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT,
  parseCorpusManifest,
} from "../dist/build.js";
import {
  assemblePackSftManifestLane,
  assertCurriculumOrdering,
  buildPackSftCurriculumMetadata,
  computeRepairHeavyStageWeights,
  orderSourcesByCurriculum,
} from "../dist/domain_packs/assemble_pack_sft.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");

test("unit: stage order is protocol → tool_use → domain_depth → repair", () => {
  assert.deepEqual([...CORPUS_CURRICULUM_STAGES], [
    "protocol",
    "tool_use",
    "domain_depth",
    "repair",
  ]);
  assert.equal(PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT, 0.5);

  const ordered = orderSourcesByCurriculum([
    { sourceId: "src.z-repair", curriculumStage: "repair" },
    { sourceId: "src.b-depth", curriculumStage: "domain_depth" },
    { sourceId: "src.a-proto", curriculumStage: "protocol" },
    { sourceId: "src.m-tool", curriculumStage: "tool_use" },
    { sourceId: "src.a-repair", curriculumStage: "repair" },
  ]);
  assert.deepEqual(
    ordered.map((s) => s.sourceId),
    [
      "src.a-proto",
      "src.m-tool",
      "src.b-depth",
      "src.a-repair",
      "src.z-repair",
    ],
  );
});

test("happy path: repair-heavy weights target ~50% when repair sources exist", () => {
  const weights = computeRepairHeavyStageWeights({
    protocol: 2,
    tool_use: 2,
    domain_depth: 2,
    repair: 1,
  });
  assert.equal(weights.repair, 0.5);
  assert.ok(Math.abs(weights.protocol + weights.tool_use + weights.domain_depth - 0.5) < 1e-9);
  assert.equal(weights.protocol, weights.tool_use);
  assert.equal(weights.tool_use, weights.domain_depth);

  const built = buildPackSftCurriculumMetadata([
    { sourceId: "s1", curriculumStage: "protocol" },
    { sourceId: "s2", curriculumStage: "tool_use" },
    { sourceId: "s3", curriculumStage: "domain_depth" },
    { sourceId: "s4", curriculumStage: "repair" },
    { sourceId: "s5", curriculumStage: "repair" },
  ]);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.curriculum.stageOrder, [...CORPUS_CURRICULUM_STAGES]);
  assert.equal(built.curriculum.repairHeavyTargetWeight, 0.5);
  assert.equal(built.curriculum.stageWeights.repair, 0.5);
  assert.deepEqual(built.curriculum.orderedSourceIds, [
    "s1",
    "s2",
    "s3",
    "s4",
    "s5",
  ]);
  assert.equal(assertCurriculumOrdering(built.curriculum, [
    { sourceId: "s1", curriculumStage: "protocol" },
    { sourceId: "s5", curriculumStage: "repair" },
    { sourceId: "s2", curriculumStage: "tool_use" },
    { sourceId: "s3", curriculumStage: "domain_depth" },
    { sourceId: "s4", curriculumStage: "repair" },
  ]).ok, true);
});

test("happy path: assemble documents curriculum metadata; byte-identical rebuild", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "pack-sft-curr-"));
  const events = [];
  try {
    const a = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.curriculum",
      version: "1.0.0",
      outDir: path.join(tmp, "a"),
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
      subjectId: "subj.pack-sft.curriculum",
      deviceId: "dev-pack-sft",
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(a.ok, true, JSON.stringify(a));
    if (!a.ok) return;

    assert.ok(a.manifest.curriculum);
    assert.deepEqual(a.manifest.curriculum.stageOrder, [
      ...CORPUS_CURRICULUM_STAGES,
    ]);
    assert.equal(a.manifest.curriculum.repairHeavyTargetWeight, 0.5);
    assert.equal(
      a.manifest.curriculum.orderedSourceIds.length,
      a.manifest.sources.length,
    );

    // Train order respects stages even though sources are sourceId-sorted in array.
    const byId = new Map(
      a.manifest.sources.map((s) => [s.sourceId, s.curriculumStage]),
    );
    let prevIdx = -1;
    for (const id of a.manifest.curriculum.orderedSourceIds) {
      const stage = byId.get(id);
      assert.ok(stage);
      const idx = CORPUS_CURRICULUM_STAGES.indexOf(stage);
      assert.ok(idx >= prevIdx);
      prevIdx = idx;
    }

    const tags = JSON.parse(
      readFileSync(path.join(tmp, "a", "curriculum-tags.json"), "utf8"),
    );
    assert.equal(
      tags.curriculum.schemaVersion,
      "training.pack-sft-curriculum.v1",
    );

    const b = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.curriculum",
      version: "1.0.0",
      outDir: path.join(tmp, "b"),
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
      subjectId: "subj.pack-sft.curriculum",
      deviceId: "dev-pack-sft",
    });
    assert.equal(b.ok, true, JSON.stringify(b));
    if (!b.ok) return;
    assert.equal(a.contentSha256, b.contentSha256);
    assert.deepEqual(a.bytes, b.bytes);

    assert.ok(
      events.some((e) => e.op === "curriculum_order" && e.outcome === "ok"),
    );
    assert.ok(!JSON.stringify(events).includes("LEARNER_UTTERANCE"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: missing curriculumStage fails curriculum build", () => {
  const built = buildPackSftCurriculumMetadata([
    { sourceId: "ok", curriculumStage: "protocol" },
    { sourceId: "missing" },
  ]);
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.equal(built.failureClass, "curriculum_order");
});

test("edge: wrong orderedSourceIds rejected by manifest validate", () => {
  const built = buildPackSftCurriculumMetadata([
    { sourceId: "s-proto", curriculumStage: "protocol" },
    { sourceId: "s-repair", curriculumStage: "repair" },
  ]);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const bad = {
    schemaVersion: "training.corpus-manifest.v1",
    manifestId: "corpus.bad.curriculum-order",
    version: "1.0.0",
    consentClass: "synthetic",
    laneCodes: ["pack.teacher.cbse-slice"],
    knowledgeModes: ["UND"],
    sources: [
      {
        sourceId: "s-proto",
        relpath: "a.json",
        licenseId: "lic.cc-by-4.0",
        knowledgeMode: "UND",
        laneCode: "pack.teacher.cbse-slice",
        contentHash:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        curriculumStage: "protocol",
      },
      {
        sourceId: "s-repair",
        relpath: "b.json",
        licenseId: "lic.cc-by-4.0",
        knowledgeMode: "UND",
        laneCode: "pack.teacher.cbse-slice",
        contentHash:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        curriculumStage: "repair",
      },
    ],
    filters: [
      { filterId: "flt.exclude-unknown-license", kind: "exclude_unknown_license" },
      { filterId: "flt.exclude-ret-weights", kind: "exclude_ret_from_weights" },
      { filterId: "flt.exclude-eval-overlap", kind: "exclude_eval_overlap" },
    ],
    dedupReport: { status: "pending", algorithm: "sha256" },
    licenseLedger: [
      {
        licenseId: "lic.cc-by-4.0",
        spdxOrLabel: "CC-BY-4.0",
        licenseClass: "open",
      },
    ],
    weightTrainingPolicy: {
      excludeKnowledgeModes: ["RET"],
      requireKnownLicense: true,
    },
    determinism: {
      canonicalSort: true,
      contentAddressedShards: true,
      forbidWallClockInShardBytes: true,
    },
    curriculum: {
      ...built.curriculum,
      // Intentionally reverse train order.
      orderedSourceIds: ["s-repair", "s-proto"],
    },
  };

  const parsed = parseCorpusManifest(bad, {
    subjectId: "subj.curr.bad",
    deviceId: "dev-curr",
  });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.failureClass, "schema");
  assert.match(parsed.message, /orderedSourceIds/);
});

test("sovereignty: curriculum metadata never carries raw content", () => {
  const built = buildPackSftCurriculumMetadata([
    { sourceId: "src.safe", curriculumStage: "protocol" },
  ]);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const blob = JSON.stringify(built.curriculum);
  assert.ok(!blob.includes("utterance"));
  assert.ok(!blob.includes("keystroke"));
  assert.equal(built.curriculum.orderedSourceIds[0], "src.safe");
});
