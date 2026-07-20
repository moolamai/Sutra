/**
 * SLM-scale pack SFT size gate and quality filter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assemblePackSftManifestLane,
  applyPackSftQualityFilter,
  assertPackSftSlmSizeGate,
  buildPackSftLaneSizeReport,
  gatePackSftLaneForFirstTrainingJob,
  reportPackSftLaneSizes,
  PACK_SFT_SLM_MAX_LANE_SOURCES,
  PACK_SFT_SLM_MIN_FIRST_JOB_SOURCES,
  PACK_SFT_SLM_THOUSANDS_REJECT_AT,
  PACK_SFT_QUALITY_CRITIC_FLOOR,
} from "../dist/domain_packs/assemble_pack_sft.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");

function stubCandidate(i, overrides = {}) {
  return {
    sourceId: `src.stub.${String(i).padStart(4, "0")}`,
    kind: "domain_spec",
    knowledgeMode: "UND",
    licenseId: "lic.cc-by-4.0",
    curriculumStage: "protocol",
    inlineBytes: Buffer.from(`{"n":${i}}\n`, "utf8"),
    relpath: `derived/stub-${i}.json`,
    ...overrides,
  };
}

test("unit: SLM size constants are hundreds-not-thousands", () => {
  assert.equal(PACK_SFT_SLM_MAX_LANE_SOURCES, 999);
  assert.equal(PACK_SFT_SLM_MIN_FIRST_JOB_SOURCES, 100);
  assert.equal(PACK_SFT_SLM_THOUSANDS_REJECT_AT, 1000);
  assert.equal(PACK_SFT_QUALITY_CRITIC_FLOOR, 0.6);
  assert.ok(PACK_SFT_SLM_MAX_LANE_SOURCES < PACK_SFT_SLM_THOUSANDS_REJECT_AT);
});

test("happy path: size gate accepts hundreds-scale; first_job requires floor", () => {
  assert.equal(assertPackSftSlmSizeGate(250, { mode: "max_only" }).ok, true);
  assert.equal(assertPackSftSlmSizeGate(250, { mode: "first_job" }).ok, true);
  assert.equal(assertPackSftSlmSizeGate(50, { mode: "max_only" }).ok, true);

  const underFloor = assertPackSftSlmSizeGate(50, { mode: "first_job" });
  assert.equal(underFloor.ok, false);
  if (underFloor.ok) return;
  assert.equal(underFloor.failureClass, "size_gate");
  assert.match(underFloor.detail, /hundreds-class floor/);
});

test("edge: thousands-class and above-max fail size gate", () => {
  const thousands = assertPackSftSlmSizeGate(1000);
  assert.equal(thousands.ok, false);
  if (thousands.ok) return;
  assert.equal(thousands.failureClass, "size_gate");
  assert.match(thousands.detail, /thousands-class/);

  const overMax = assertPackSftSlmSizeGate(1000 - 1 + 1 > 999 ? 1000 : 999 + 1);
  // 999 is ok for max_only; 1000 hits thousands first.
  assert.equal(assertPackSftSlmSizeGate(999).ok, true);

  // Force max without hitting thousandsRejectAt by custom thresholds.
  const custom = assertPackSftSlmSizeGate(500, {
    maxSources: 400,
    thousandsRejectAt: 5000,
  });
  assert.equal(custom.ok, false);
  if (custom.ok) return;
  assert.match(custom.detail, /exceeds SLM max/);
});

test("happy path: quality filter drops below-floor distilled traces", () => {
  const filtered = applyPackSftQualityFilter([
    { sourceId: "hi", kind: "distilled_trace", criticScore: 0.9 },
    { sourceId: "lo", kind: "distilled_trace", criticScore: 0.2 },
    { sourceId: "spec", kind: "domain_spec" },
  ]);
  assert.deepEqual(
    filtered.accepted.map((c) => c.sourceId),
    ["hi", "spec"],
  );
  assert.equal(filtered.excluded.length, 1);
  assert.equal(filtered.excluded[0].sourceId, "lo");
  assert.equal(filtered.criticFloor, 0.6);
});

test("happy path: assemble writes lane-size-report; multi-pack report", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "pack-sft-size-"));
  const events = [];
  try {
    const teacher = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.size",
      version: "1.0.0",
      outDir: path.join(tmp, "teacher"),
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
      subjectId: "subj.pack-sft.size",
      deviceId: "dev-pack-sft",
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(teacher.ok, true, JSON.stringify(teacher));
    if (!teacher.ok) return;

    assert.ok(teacher.laneSizeReport);
    assert.equal(
      teacher.laneSizeReport.schemaVersion,
      "training.pack-sft-lane-size-report.v1",
    );
    assert.equal(teacher.laneSizeReport.sizeGate.outcome, "ok");
    assert.equal(teacher.laneSizeReport.qualityFilter.outcome, "ok");
    assert.ok(teacher.laneSizeReport.counts.sourceCount >= 1);

    const onDisk = JSON.parse(readFileSync(teacher.laneSizeReportPath, "utf8"));
    assert.equal(onDisk.packId, "pack.teacher.cbse-slice");
    assert.equal(onDisk.counts.sourceCount, teacher.laneSizeReport.counts.sourceCount);

    const doctor = assemblePackSftManifestLane({
      packId: "pack.doctor.formulary-sketch",
      manifestId: "corpus.pack.doctor.size",
      version: "1.0.0",
      outDir: path.join(tmp, "doctor"),
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
    });
    assert.equal(doctor.ok, true, JSON.stringify(doctor));
    if (!doctor.ok) return;

    const multi = reportPackSftLaneSizes([
      doctor.laneSizeReport,
      teacher.laneSizeReport,
    ]);
    assert.equal(multi.lanes.length, 2);
    assert.equal(multi.lanes[0].packId, "pack.doctor.formulary-sketch");
    assert.equal(multi.lanes[1].packId, "pack.teacher.cbse-slice");
    assert.equal(
      multi.totalSources,
      teacher.laneSizeReport.counts.sourceCount +
        doctor.laneSizeReport.counts.sourceCount,
    );

    assert.ok(events.some((e) => e.op === "size_gate" && e.outcome === "ok"));
    assert.ok(!JSON.stringify(events).includes("LEARNER_UTTERANCE"));
    assert.ok(!JSON.stringify(teacher.laneSizeReport).includes("utterance"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: assemble rejects oversized lane (size_gate)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "pack-sft-oversize-"));
  try {
    const candidates = [];
    for (let i = 0; i < 1000; i++) {
      candidates.push(stubCandidate(i));
    }
    const result = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.oversize",
      version: "1.0.0",
      outDir: tmp,
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
      discover: false,
      candidates,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureClass, "size_gate");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: first_job mode rejects under hundreds floor", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "pack-sft-firstjob-"));
  try {
    const result = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.firstjob",
      version: "1.0.0",
      outDir: tmp,
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
      sizeGateMode: "first_job",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureClass, "size_gate");
    assert.match(result.detail, /first training job/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: first-job readiness gate on report", () => {
  const small = buildPackSftLaneSizeReport({
    packId: "pack.teacher.cbse-slice",
    laneCode: "pack.teacher.cbse-slice",
    mode: "max_only",
    sources: Array.from({ length: 40 }, (_, i) => ({
      sourceId: `s${i}`,
      kind: "domain_spec",
      curriculumStage: "protocol",
    })),
  });
  assert.equal(small.sizeGate.outcome, "ok");
  const gated = gatePackSftLaneForFirstTrainingJob(small);
  assert.equal(gated.ok, false);
  if (gated.ok) return;
  assert.equal(gated.failureClass, "size_gate");

  const ready = buildPackSftLaneSizeReport({
    packId: "pack.teacher.cbse-slice",
    laneCode: "pack.teacher.cbse-slice",
    mode: "first_job",
    sources: Array.from({ length: 120 }, (_, i) => ({
      sourceId: `s${i}`,
      kind: "domain_spec",
      curriculumStage: "protocol",
    })),
  });
  assert.equal(gatePackSftLaneForFirstTrainingJob(ready).ok, true);
});

test("sovereignty: quality failure blocks first-job gate", () => {
  const dirty = buildPackSftLaneSizeReport({
    packId: "pack.teacher.cbse-slice",
    laneCode: "pack.teacher.cbse-slice",
    mode: "first_job",
    belowCriticFloorCount: 3,
    sources: Array.from({ length: 120 }, (_, i) => ({
      sourceId: `s${i}`,
      kind: "distilled_trace",
      curriculumStage: "tool_use",
    })),
  });
  assert.equal(dirty.qualityFilter.outcome, "error");
  const gated = gatePackSftLaneForFirstTrainingJob(dirty);
  assert.equal(gated.ok, false);
  if (gated.ok) return;
  assert.equal(gated.failureClass, "quality_filter");
});
