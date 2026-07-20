/**
 * Doctor formulary sketch flagship pack: disclaimers in citations, offline retrieve.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DOCTOR_FORMULARY_SKETCH_PACK_ID,
  DOCTOR_FORMULARY_SKETCH_SOURCE_RELPATH,
  PACK_PROVENANCE_SCHEMA_VERSION,
  buildDoctorFormularySketchPack,
  checkDoctorFormularySketchFreshness,
  loadDoctorFormularySketchConnector,
  proveOfflinePackRetrieve,
  resolveDoctorFormularySketchPackRoot,
  resolveRepoRoot,
  validatePack,
} from "../dist/index.js";

const FIXED_BUILT_AT = "2026-07-01T12:00:00.000Z";
const FIXED_NOW_MS = Date.parse("2026-07-15T00:00:00.000Z");
const SECRET = "PATIENT_CASE_CONTENT_MUST_NOT_LEAK";

const ADVICE_IN_TITLE = /prescrib|take\s+\d|dosage\s+instruction|clinical\s+advice\s+to\s+patient/i;

test("happy path: doctor-formulary-sketch validates with provenance", () => {
  const packRoot = resolveDoctorFormularySketchPackRoot();
  const provenancePath = path.join(packRoot, "provenance.json");
  assert.ok(existsSync(path.join(packRoot, "manifest.json")));
  assert.ok(existsSync(provenancePath));

  const validated = validatePack(packRoot, { nowMs: FIXED_NOW_MS });
  assert.equal(validated.ok, true, JSON.stringify(validated));
  if (validated.ok) {
    assert.equal(validated.value.manifest.packId, DOCTOR_FORMULARY_SKETCH_PACK_ID);
    assert.equal(validated.value.manifest.locality, "bundled-offline");
    assert.ok(validated.value.passageCount >= 3);
    const title = validated.value.manifest.title ?? "";
    assert.match(title, /not clinical advice/i);
    assert.ok(!ADVICE_IN_TITLE.test(title));
  }

  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  assert.equal(provenance.schemaVersion, PACK_PROVENANCE_SCHEMA_VERSION);
  assert.equal(provenance.packId, DOCTOR_FORMULARY_SKETCH_PACK_ID);
  assert.equal(provenance.domain, "doctor");
  assert.ok(
    provenance.sourcePaths.includes(
      DOCTOR_FORMULARY_SKETCH_SOURCE_RELPATH.replace(/\\/g, "/"),
    ),
  );

  const fresh = checkDoctorFormularySketchFreshness({
    subjectId: "subj.flag.doctor.fresh",
    deviceId: "dev-flag-doctor",
  });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
});

test("happy path: citations name source tier; disclaimers live in citation metadata", () => {
  const packRoot = resolveDoctorFormularySketchPackRoot();
  const shard = JSON.parse(
    readFileSync(path.join(packRoot, "content", "shard-formulary.json"), "utf8"),
  );
  assert.ok(Array.isArray(shard.passages));
  assert.ok(shard.passages.length >= 1);
  for (const p of shard.passages) {
    assert.ok(p.citation?.locator, "citation.locator required");
    assert.match(
      p.citation.locator,
      /Source tier:/i,
      `locator must name source tier: ${p.citation.locator}`,
    );
    assert.match(
      p.citation.locator,
      /disclaimer|not clinical advice|not a prescription|clinician decides/i,
      `disclaimer must be citation metadata: ${p.citation.locator}`,
    );
  }
  const manifest = JSON.parse(
    readFileSync(path.join(packRoot, "manifest.json"), "utf8"),
  );
  assert.ok(!ADVICE_IN_TITLE.test(manifest.title ?? ""));
});

test("happy path: build doctor pack emits telemetry without raw content", () => {
  const events = [];
  const built = buildDoctorFormularySketchPack({
    builtAt: FIXED_BUILT_AT,
    nowMs: FIXED_NOW_MS,
    subjectId: "subj.flag.doctor.build",
    deviceId: "dev-flag-doctor",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(built.ok, true);
  assert.equal(built.manifest.packId, DOCTOR_FORMULARY_SKETCH_PACK_ID);
  assert.ok(events.some((e) => e.op === "build" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(events).includes("Paracetamol"));
  assert.ok(!JSON.stringify(events).includes("warfarin"));
});

test("edge: domain markdown change without rebuild fails freshness check", () => {
  const repoRoot = resolveRepoRoot();
  const tmp = mkdtempSync(path.join(tmpdir(), "flagpack-doctor-stale-"));
  try {
    const srcRel = DOCTOR_FORMULARY_SKETCH_SOURCE_RELPATH.replace(/\\/g, "/");
    const domainsDir = path.join(tmp, "domains", "doctor", "data");
    const packsOut = path.join(tmp, "knowledge-packs", "doctor-formulary-sketch");
    mkdirSync(domainsDir, { recursive: true });
    mkdirSync(packsOut, { recursive: true });
    copyFileSync(path.join(repoRoot, srcRel), path.join(tmp, ...srcRel.split("/")));

    const built = buildDoctorFormularySketchPack({
      repoRoot: tmp,
      builtAt: FIXED_BUILT_AT,
      nowMs: FIXED_NOW_MS,
    });
    assert.equal(built.ok, true);

    assert.equal(
      checkDoctorFormularySketchFreshness({ repoRoot: tmp, packRoot: packsOut }).ok,
      true,
    );

    const tmpSrc = path.join(tmp, ...srcRel.split("/"));
    writeFileSync(tmpSrc, `${readFileSync(tmpSrc, "utf8")}\n<!-- stale -->\n`, "utf8");

    const stale = checkDoctorFormularySketchFreshness({
      repoRoot: tmp,
      packRoot: packsOut,
      subjectId: "subj.flag.doctor.stale",
      deviceId: "dev-flag-doctor",
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.failureClass, "freshness");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: offline retrieve returns cited formulary hits with network-denied prove", async () => {
  const events = [];
  const connector = loadDoctorFormularySketchConnector({
    subjectId: "subj.flag.doctor.retrieve",
    deviceId: "dev-flag-doctor",
    nowMs: FIXED_NOW_MS,
  });
  const desc = connector.describe();
  assert.equal(desc.locality, "bundled-offline");
  const hits = await connector.retrieve({
    query: "warfarin NSAID bleeding interaction",
    limit: 4,
  });
  assert.ok(hits.length >= 1);
  assert.ok(
    hits.every((h) =>
      desc.sources.some((s) => s.sourceId === h.sourceId && h.citation.trim()),
    ),
  );

  const proof = await proveOfflinePackRetrieve({
    subjectId: "subj.flag.doctor.offline",
    deviceId: "dev-flag-doctor",
    packRoot: resolveDoctorFormularySketchPackRoot(),
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proof.ok, true, JSON.stringify(proof.failures));
  assert.equal(proof.egressAttemptCount, 0);
  assert.equal(proof.locality, "bundled-offline");
  assert.ok(proof.citationsResolvable);
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("sovereignty: doctor pack path is under knowledge-packs/; no domains/ import in build", () => {
  const packRoot = resolveDoctorFormularySketchPackRoot();
  assert.ok(packRoot.replace(/\\/g, "/").includes("/knowledge-packs/"));
  assert.ok(!packRoot.replace(/\\/g, "/").includes("/domains/"));

  const buildSrc = path.resolve(
    resolveRepoRoot(),
    "packages",
    "bindings-knowledge",
    "src",
    "pack_build.ts",
  );
  const src = readFileSync(buildSrc, "utf8");
  assert.ok(!/from\s+["'].*domains\//.test(src));
  assert.ok(!/import\s+["'].*domains\//.test(src));
});
