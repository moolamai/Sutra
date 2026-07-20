/**
 * Per-domain-pack SFT manifest lane assembly.
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
  CORPUS_CURRICULUM_STAGES,
  CORPUS_MANIFEST_JSON_SCHEMA_PATH,
  canonicalManifestBytes,
} from "../dist/build.js";
import {
  PACK_SFT_DEFAULT_MIN_CRITIC_SCORE,
  assemblePackSftManifestLane,
  discoverPackSftCandidates,
  listKnownDomainPackIds,
  lookupKnownDomainPack,
  packSftDecontamProofRelpath,
} from "../dist/domain_packs/assemble_pack_sft.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const FIXTURES = path.join(PKG_ROOT, "domain_packs", "fixtures");
const TRAJ_OK = path.join(
  REPO_ROOT,
  "packages",
  "learning",
  "fixtures",
  "trajectory",
  "extended-dense-slm.json",
);
const TRAJ_OPT_OUT = path.join(
  REPO_ROOT,
  "packages",
  "learning",
  "fixtures",
  "consent",
  "negative-opt-out-trajectory.json",
);

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

function distillCandidate(name, criticScore) {
  const abs = path.join(FIXTURES, name);
  return {
    sourceId: `src.teacher.distill.${name.replace(/\.json$/, "")}`,
    kind: "distilled_trace",
    knowledgeMode: "UND",
    licenseId: "lic.cc-by-4.0",
    curriculumStage: "tool_use",
    absPath: abs,
    relpath: `domain_packs/fixtures/${name}`,
    criticScore,
  };
}

test("unit: known packs and curriculum stages are declared", () => {
  const ids = listKnownDomainPackIds();
  assert.ok(ids.includes("pack.teacher.cbse-slice"));
  assert.ok(ids.includes("pack.doctor.formulary-sketch"));
  assert.equal(
    lookupKnownDomainPack("pack.teacher.cbse-slice")?.domainCode,
    "teacher",
  );
  assert.deepEqual([...CORPUS_CURRICULUM_STAGES], [
    "protocol",
    "tool_use",
    "domain_depth",
    "repair",
  ]);
  const schema = JSON.parse(
    readFileSync(CORPUS_MANIFEST_JSON_SCHEMA_PATH, "utf8"),
  );
  assert.deepEqual(
    schema.properties.sources.items.properties.curriculumStage.enum,
    [...CORPUS_CURRICULUM_STAGES],
  );
  assert.equal(PACK_SFT_DEFAULT_MIN_CRITIC_SCORE, 0.6);
});

test("happy path: teacher pack lane discovers specs + B8 stubs, tags curriculum, byte-identical writes", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "pack-sft-teacher-"));
  const events = [];
  try {
    const discovered = discoverPackSftCandidates("pack.teacher.cbse-slice", {
      repoRoot: REPO_ROOT,
    });
    assert.ok(
      discovered.some((c) => c.kind === "domain_spec"),
      "domain specs discovered",
    );
    assert.ok(
      discovered.some((c) => c.kind === "b8_guidance_derived"),
      "B8-derived stubs discovered",
    );

    const a = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.cbse-slice.sft",
      version: "1.0.0",
      title: "Teacher CBSE pack SFT lane",
      outDir: path.join(tmp, "a"),
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
      subjectId: "subj.pack-sft.teacher",
      deviceId: "dev-pack-sft",
      extraCandidates: [distillCandidate("distill-teacher-high.json", 0.85)],
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(a.ok, true, JSON.stringify(a));
    if (!a.ok) return;

    assert.equal(a.laneCode, "pack.teacher.cbse-slice");
    assert.deepEqual(a.manifest.laneCodes, ["pack.teacher.cbse-slice"]);
    assert.equal(a.manifest.consentClass, "synthetic");
    assert.ok(a.manifest.sources.every((s) => s.laneCode === a.laneCode));
    assert.ok(
      a.manifest.sources.every((s) => s.curriculumStage),
      "curriculum stage tags on sources",
    );
    assert.ok(
      Object.keys(a.curriculumTags).length >= a.manifest.sources.length,
    );
    assert.equal(
      a.manifest.decontaminationProof.reportRelpath,
      packSftDecontamProofRelpath("pack.teacher.cbse-slice"),
    );
    assert.ok(existsSync(a.decontamProofPath));
    assert.equal(a.decontamProof.status, "passed");
    assert.ok(a.manifest.sources.some((s) => s.sourceId.includes("distill")));

    const b = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.cbse-slice.sft",
      version: "1.0.0",
      title: "Teacher CBSE pack SFT lane",
      outDir: path.join(tmp, "b"),
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
      subjectId: "subj.pack-sft.teacher",
      deviceId: "dev-pack-sft",
      extraCandidates: [distillCandidate("distill-teacher-high.json", 0.85)],
    });
    assert.equal(b.ok, true, JSON.stringify(b));
    if (!b.ok) return;
    assert.deepEqual(
      canonicalManifestBytes(a.manifest),
      canonicalManifestBytes(b.manifest),
    );
    assert.equal(a.contentSha256, b.contentSha256);

    assert.ok(events.some((e) => e.op === "assemble" && e.outcome === "ok"));
    assert.ok(events.some((e) => e.op === "decontam" && e.outcome === "ok"));
    assert.ok(!JSON.stringify(events).includes(SECRET));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("happy path: doctor pack has a separate decontam proof path from teacher", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "pack-sft-doctor-"));
  try {
    const teacher = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.cbse-slice.sft",
      version: "1.0.0",
      outDir: path.join(tmp, "teacher"),
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
    });
    const doctor = assemblePackSftManifestLane({
      packId: "pack.doctor.formulary-sketch",
      manifestId: "corpus.pack.doctor.formulary-sketch.sft",
      version: "1.0.0",
      outDir: path.join(tmp, "doctor"),
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
    });
    assert.equal(teacher.ok, true, JSON.stringify(teacher));
    assert.equal(doctor.ok, true, JSON.stringify(doctor));
    if (!teacher.ok || !doctor.ok) return;
    assert.notEqual(
      teacher.manifest.decontaminationProof.reportRelpath,
      doctor.manifest.decontaminationProof.reportRelpath,
    );
    assert.equal(doctor.laneCode, "pack.doctor.formulary-sketch");
    assert.ok(
      doctor.manifest.sources.every(
        (s) => s.laneCode === "pack.doctor.formulary-sketch",
      ),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: distilled trace below critic threshold is excluded", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "pack-sft-critic-"));
  const events = [];
  try {
    const result = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.critic-gate",
      version: "1.0.0",
      outDir: tmp,
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
      extraCandidates: [distillCandidate("distill-teacher-low.json", 0.2)],
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(
      !result.manifest.sources.some((s) => s.sourceId.includes("low")),
    );
    assert.ok(
      result.excluded.some((e) => e.reason === "quality_filter"),
    );
    assert.ok(
      events.some(
        (e) => e.op === "quality_filter" && e.failureClass === "quality_filter",
      ),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: unknown license excludes the document", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "pack-sft-lic-"));
  try {
    const result = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.lic",
      version: "1.0.0",
      outDir: tmp,
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
      discover: false,
      candidates: [
        {
          sourceId: "src.teacher.orphan-license",
          kind: "domain_spec",
          knowledgeMode: "UND",
          licenseId: "lic.totally-unknown",
          curriculumStage: "protocol",
          inlineBytes: Buffer.from('{"ok":true}\n', "utf8"),
          relpath: "derived/orphan.json",
        },
        {
          sourceId: "src.teacher.known-license",
          kind: "domain_spec",
          knowledgeMode: "UND",
          licenseId: "lic.cc-by-4.0",
          curriculumStage: "protocol",
          inlineBytes: Buffer.from('{"keep":true}\n', "utf8"),
          relpath: "derived/keep.json",
        },
      ],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.manifest.sources.length, 1);
    assert.equal(result.manifest.sources[0].sourceId, "src.teacher.known-license");
    assert.ok(result.excluded.some((e) => e.reason === "license"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: eval contamination is a hard assemble failure", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "pack-sft-contam-"));
  try {
    const result = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.contam",
      version: "1.0.0",
      outDir: tmp,
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
      discover: false,
      candidates: [
        {
          sourceId: "src.teacher.eval-leak",
          kind: "domain_spec",
          knowledgeMode: "UND",
          licenseId: "lic.cc-by-4.0",
          curriculumStage: "protocol",
          inlineBytes: Buffer.from('{"leak":true}\n', "utf8"),
          relpath: "derived/leak.json",
          // Registered smoke.eval.v1 hash — must fail decontam.
          contentHash:
            "sha256:29619d77bbc2e6eb4f0b9b3464726f6bfb490d255fe56a3a4863406a8925c5cc",
        },
      ],
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureClass, "contamination");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sovereignty: consented + synthetic mix is rejected", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "pack-sft-mix-"));
  try {
    const traj = JSON.parse(readFileSync(TRAJ_OK, "utf8"));
    const result = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.mix",
      version: "1.0.0",
      outDir: tmp,
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
      discover: true,
      extraCandidates: [
        {
          sourceId: "src.teacher.traj.mix",
          kind: "consented_trajectory",
          knowledgeMode: "UND",
          licenseId: "lic.internal-research",
          curriculumStage: "repair",
          trajectory: traj,
          relpath: "shards/traj-mix.json",
        },
      ],
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureClass, "consent_mix");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sovereignty: opt-out trajectory is consent-gated out; consented-only lane works", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "pack-sft-consent-"));
  const events = [];
  try {
    const denied = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.opt-out",
      version: "1.0.0",
      outDir: path.join(tmp, "opt-out"),
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
      discover: false,
      candidates: [
        {
          sourceId: "src.teacher.traj.opt-out",
          kind: "consented_trajectory",
          knowledgeMode: "UND",
          licenseId: "lic.internal-research",
          curriculumStage: "repair",
          trajectory: JSON.parse(readFileSync(TRAJ_OPT_OUT, "utf8")),
          relpath: "shards/opt-out.json",
        },
      ],
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(denied.ok, false);
    if (denied.ok) return;
    assert.equal(denied.failureClass, "empty_lane");

    const traj = JSON.parse(readFileSync(TRAJ_OK, "utf8"));
    const ok = assemblePackSftManifestLane({
      packId: "pack.teacher.cbse-slice",
      manifestId: "corpus.pack.teacher.consented",
      version: "1.0.0",
      outDir: path.join(tmp, "consented"),
      repoRoot: REPO_ROOT,
      packageRoot: PKG_ROOT,
      discover: false,
      consentClass: "consented",
      candidates: [
        {
          sourceId: "src.teacher.traj.ok",
          kind: "consented_trajectory",
          knowledgeMode: "UND",
          licenseId: "lic.internal-research",
          curriculumStage: "repair",
          trajectory: traj,
          relpath: "shards/traj-ok.json",
        },
      ],
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    if (!ok.ok) return;
    assert.equal(ok.manifest.consentClass, "consented");
    assert.equal(ok.manifest.sources.length, 1);
    assert.equal(ok.manifest.sources[0].curriculumStage, "repair");
    assert.ok(
      events.some((e) => e.op === "consent_gate" && e.outcome === "ok"),
    );
    assert.ok(!JSON.stringify(events).includes(SECRET));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
