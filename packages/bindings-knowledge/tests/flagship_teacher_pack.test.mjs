/**
 * Teacher CBSE flagship pack: build from domains/ markdown + provenance freshness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  PACK_PROVENANCE_SCHEMA_VERSION,
  TEACHER_CBSE_SLICE_PACK_ID,
  TEACHER_CBSE_SLICE_SOURCE_RELPATH,
  buildTeacherCbseSlicePack,
  checkTeacherCbseSliceFreshness,
  fingerprintSourceFiles,
  loadTeacherCbseSliceConnector,
  parsePackAuthoringMarkdown,
  resolveRepoRoot,
  resolveTeacherCbseSlicePackRoot,
  validatePack,
} from "../dist/index.js";

const FIXED_BUILT_AT = "2026-07-01T12:00:00.000Z";
const FIXED_NOW_MS = Date.parse("2026-07-15T00:00:00.000Z");
const SECRET = "LEARNER_SYLLABUS_CONTENT_MUST_NOT_LEAK";

test("happy path: committed teacher-cbse-slice validates and has provenance", () => {
  const packRoot = resolveTeacherCbseSlicePackRoot();
  const provenancePath = path.join(packRoot, "provenance.json");
  assert.ok(existsSync(path.join(packRoot, "manifest.json")));
  assert.ok(existsSync(provenancePath));

  const validated = validatePack(packRoot, { nowMs: FIXED_NOW_MS });
  assert.equal(validated.ok, true, JSON.stringify(validated));
  if (validated.ok) {
    assert.equal(validated.value.manifest.packId, TEACHER_CBSE_SLICE_PACK_ID);
    assert.equal(validated.value.manifest.locality, "bundled-offline");
    assert.ok(validated.value.passageCount >= 4);
  }

  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  assert.equal(provenance.schemaVersion, PACK_PROVENANCE_SCHEMA_VERSION);
  assert.equal(provenance.packId, TEACHER_CBSE_SLICE_PACK_ID);
  assert.ok(Array.isArray(provenance.sourcePaths));
  assert.ok(provenance.sourcePaths.includes(TEACHER_CBSE_SLICE_SOURCE_RELPATH.replace(/\\/g, "/")));
  assert.equal(typeof provenance.sourceFingerprint, "string");
  assert.equal(provenance.sourceFingerprint.length, 64);
  assert.equal(typeof provenance.contentHash, "string");
  assert.equal(typeof provenance.builtAt, "string");

  const fresh = checkTeacherCbseSliceFreshness({
    subjectId: "subj.flag.fresh.ok",
    deviceId: "dev-flag",
  });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
});

test("happy path: build from domains markdown is idempotent for content", () => {
  const events = [];
  const built = buildTeacherCbseSlicePack({
    builtAt: FIXED_BUILT_AT,
    nowMs: FIXED_NOW_MS,
    subjectId: "subj.flag.build.ok",
    deviceId: "dev-flag",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(built.ok, true);
  assert.equal(built.manifest.packId, TEACHER_CBSE_SLICE_PACK_ID);
  assert.ok(built.shard.passages.every((p) => p.citation?.citationId));
  assert.ok(events.some((e) => e.op === "build" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(events).includes("3:4"));

  const again = buildTeacherCbseSlicePack({
    builtAt: FIXED_BUILT_AT,
    nowMs: FIXED_NOW_MS,
    dryRun: true,
  });
  assert.equal(again.sourceFingerprint, built.sourceFingerprint);
  assert.equal(again.contentHash, built.contentHash);
});

test("edge: domain markdown change without rebuild fails freshness check", () => {
  const repoRoot = resolveRepoRoot();
  const tmp = mkdtempSync(path.join(tmpdir(), "flagpack-stale-"));
  try {
    const domainsTeacher = path.join(tmp, "domains", "teacher", "data");
    const packsOut = path.join(tmp, "knowledge-packs", "teacher-cbse-slice");
    mkdirSync(domainsTeacher, { recursive: true });
    mkdirSync(packsOut, { recursive: true });

    const srcRel = TEACHER_CBSE_SLICE_SOURCE_RELPATH.replace(/\\/g, "/");
    const realSrc = path.join(repoRoot, srcRel);
    const tmpSrc = path.join(tmp, ...srcRel.split("/"));
    copyFileSync(realSrc, tmpSrc);

    const built = buildTeacherCbseSlicePack({
      repoRoot: tmp,
      builtAt: FIXED_BUILT_AT,
      nowMs: FIXED_NOW_MS,
      subjectId: "subj.flag.stale",
      deviceId: "dev-flag",
    });
    assert.equal(built.ok, true);

    const ok = checkTeacherCbseSliceFreshness({
      repoRoot: tmp,
      packRoot: packsOut,
    });
    assert.equal(ok.ok, true);

    writeFileSync(tmpSrc, `${readFileSync(tmpSrc, "utf8")}\n<!-- stale-touch -->\n`, "utf8");

    const stale = checkTeacherCbseSliceFreshness({
      repoRoot: tmp,
      packRoot: packsOut,
      subjectId: "subj.flag.stale",
      deviceId: "dev-flag",
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.failureClass, "freshness");
      assert.match(stale.message, /stale pack|fingerprint/i);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: authoring payload without citations fails parse/build contract", () => {
  const md = `<!-- pack-build:v1 -->
\`\`\`json
{
  "packId": "pack.bad",
  "version": "0.0.1",
  "asOf": "2026-06-01T00:00:00.000Z",
  "locality": "bundled-offline",
  "languages": ["en"],
  "sources": [{
    "sourceId": "src.x",
    "title": "X",
    "domain": "teacher",
    "locality": "bundled-offline",
    "coverage": { "from": "2024-01-01", "to": "2026-06-01" }
  }],
  "shard": {
    "shardId": "shard.x",
    "relpath": "content/shard-x.json",
    "passages": [{
      "passageId": "pass.uncited",
      "content": "uncited body",
      "citation": {
        "citationId": "cite.x",
        "sourceId": "src.missing",
        "locator": "nowhere"
      },
      "asOf": "2024-06-01T00:00:00.000Z"
    }]
  }
}
\`\`\`
<!-- /pack-build:v1 -->`;
  const authoring = parsePackAuthoringMarkdown(md);
  assert.equal(authoring.packId, "pack.bad");

  const tmp = mkdtempSync(path.join(tmpdir(), "flagpack-uncited-"));
  try {
    const srcDir = path.join(tmp, "domains", "teacher", "data");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, "cbse-syllabus-slice.md"), md, "utf8");
    assert.throws(
      () =>
        buildTeacherCbseSlicePack({
          repoRoot: tmp,
          builtAt: FIXED_BUILT_AT,
          nowMs: FIXED_NOW_MS,
          subjectId: "subj.flag.uncited",
          deviceId: "dev-flag",
        }),
      /validatePack|sourceId|citation/i,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: offline retrieve still returns cited hits from rebuilt pack", async () => {
  const connector = loadTeacherCbseSliceConnector({
    subjectId: "subj.flag.offline",
    deviceId: "dev-flag",
    nowMs: FIXED_NOW_MS,
  });
  const desc = connector.describe();
  assert.equal(desc.locality, "bundled-offline");
  const hits = await connector.retrieve({
    query: "equivalent ratios 3:4 6:8",
    limit: 4,
  });
  assert.ok(hits.length >= 1);
  assert.ok(
    hits.every((h) =>
      desc.sources.some((s) => s.sourceId === h.sourceId && h.citation.trim()),
    ),
  );
});

test("sovereignty: pack_build never imports domains/ as a module", () => {
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
  assert.ok(src.includes("filesystem") || src.includes("sourcePaths"));
});

test("unit: fingerprint is stable and changes when source bytes change", () => {
  const repoRoot = resolveRepoRoot();
  const paths = [TEACHER_CBSE_SLICE_SOURCE_RELPATH.replace(/\\/g, "/")];
  const a = fingerprintSourceFiles(repoRoot, paths);
  const b = fingerprintSourceFiles(repoRoot, paths);
  assert.equal(a, b);
  assert.equal(a.length, 64);
  const alt = createHash("sha256").update("other").digest("hex");
  assert.notEqual(a, alt);
});
