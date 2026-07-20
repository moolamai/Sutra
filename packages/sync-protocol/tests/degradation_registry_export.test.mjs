/**
 * DegradationRegistry schema export + wire fixtures + protocol doc gate.
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/degradation_registry_export.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WIRE_SCHEMA_EXPORT_MAP,
  exportWireSchemas,
  readExportedSchemaBodies,
  schemaToCanonicalDocument,
} from "../scripts/export-schemas.mjs";
import {
  PROTOCOL_VERSION,
  assertStaleReadPayload,
  createDegradationRegistry,
  degradationRegistryDocumentSchema,
  degradationRegistrySchema,
  freshnessMarkerSchema,
} from "../dist/index.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const FIXTURE_DIR = path.join(PKG_ROOT, "fixtures", "degradation-registry");
const DOC = path.join(REPO_ROOT, "docs", "protocol", "DEGRADATION-REGISTRY.md");
const PKG_README = path.join(PKG_ROOT, "README.md");
const PROTOCOL_README = path.join(REPO_ROOT, "docs", "protocol", "README.md");
const MANIFEST = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf8"),
);

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: DegradationRegistry and FreshnessMarker schemas committed", () => {
  assert.ok(existsSync(path.join(PKG_ROOT, "schemas", "DegradationRegistry.json")));
  assert.ok(existsSync(path.join(PKG_ROOT, "schemas", "FreshnessMarker.json")));
  assert.equal(
    WIRE_SCHEMA_EXPORT_MAP.DegradationRegistry,
    "degradationRegistrySchema",
  );
  assert.equal(WIRE_SCHEMA_EXPORT_MAP.FreshnessMarker, "freshnessMarkerSchema");

  const registryDoc = JSON.parse(
    readFileSync(path.join(PKG_ROOT, "schemas", "DegradationRegistry.json"), "utf8"),
  );
  assert.equal(registryDoc.title, "DegradationRegistry");
  assert.equal(registryDoc["x-protocol-version"], "1.0.0");
  assert.ok(registryDoc.required?.includes("modes"));
  assert.ok(registryDoc.required?.includes("bindings"));

  const markerDoc = schemaToCanonicalDocument(
    freshnessMarkerSchema,
    "FreshnessMarker",
    PROTOCOL_VERSION,
  );
  assert.equal(markerDoc.title, "FreshnessMarker");
});

test("happy path: fixture registry + each mode parse and lookup", () => {
  const registryJson = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, MANIFEST.registryFile), "utf8"),
  );
  const doc = degradationRegistryDocumentSchema.parse(registryJson);
  const handle = createDegradationRegistry(doc);

  for (const entry of MANIFEST.modes) {
    const modeFixture = JSON.parse(
      readFileSync(path.join(FIXTURE_DIR, entry.file), "utf8"),
    );
    assert.equal(modeFixture.mode, entry.mode);
    assert.equal(modeFixture.behavior.allowsFabrication, false);
    assert.equal(modeFixture.behavior.allowsSilentWriteRetry, false);

    const looked = handle.lookup(entry.surface, entry.operation, {
      subjectId: modeFixture.subjectId,
      deviceId: modeFixture.deviceId,
    });
    assert.equal(looked.outcome, "accepted", entry.mode);
    assert.equal(looked.behavior.mode, entry.mode);
    assert.equal(looked.behavior.signalCode, modeFixture.behavior.signalCode);

    emit({
      event: "degradation.registry",
      outcome: "ok",
      kind: "fixture",
      subjectId: modeFixture.subjectId,
      deviceId: modeFixture.deviceId,
      mode: entry.mode,
      signalCode: looked.behavior.signalCode,
    });
  }
});

test("happy path: protocol doc published, linked, and names every MUST mode", async () => {
  const doc = await readFile(DOC, "utf8");
  const pkgReadme = await readFile(PKG_README, "utf8");
  const protocolReadme = await readFile(PROTOCOL_README, "utf8");

  assert.match(doc, /STALE_READ/);
  assert.match(doc, /HARD_STOP_WRITE/);
  assert.match(doc, /QUEUE_AND_WARN/);
  assert.match(doc, /Never fabricate/i);
  assert.match(doc, /Silent write retry is forbidden/i);
  assert.match(doc, /DEGRADE_STALE_READ/);
  assert.match(doc, /anika-k/);
  assert.match(pkgReadme, /DEGRADATION-REGISTRY\.md/);
  assert.match(protocolReadme, /DEGRADATION-REGISTRY\.md/);
});

test("edge: exporter is deterministic across two consecutive runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sutra-degrade-export-"));
  const dirA = path.join(dir, "a");
  const dirB = path.join(dir, "b");
  try {
    const a = await exportWireSchemas({ outDir: dirA, includeEvents: false });
    const b = await exportWireSchemas({ outDir: dirB, includeEvents: false });
    assert.ok(a.files.includes("DegradationRegistry.json"));
    assert.ok(a.files.includes("FreshnessMarker.json"));
    assert.deepEqual(a.files, b.files);
    const bodiesA = await readExportedSchemaBodies(dirA, { includeEvents: false });
    const bodiesB = await readExportedSchemaBodies(dirB, { includeEvents: false });
    assert.equal(
      bodiesA.get("DegradationRegistry.json"),
      bodiesB.get("DegradationRegistry.json"),
    );
    assert.equal(
      bodiesA.get("FreshnessMarker.json"),
      bodiesB.get("FreshnessMarker.json"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edge: stale fixture accepts marker; fabricated payload rejected", () => {
  const stale = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, "modes/stale-read.json"), "utf8"),
  );
  const ok = assertStaleReadPayload(stale.stalePayload, {
    subjectId: stale.subjectId,
  });
  assert.equal(ok.ok, true);
  const bad = assertStaleReadPayload(stale.forbidden, {
    subjectId: stale.subjectId,
  });
  assert.equal(bad.failureClass, "fabrication_forbidden");
});

test("subject isolation + privacy: lookup rejects empty subject; signals stay metadata", () => {
  const handle = createDegradationRegistry(
    JSON.parse(
      readFileSync(path.join(FIXTURE_DIR, MANIFEST.registryFile), "utf8"),
    ),
  );
  const unscoped = handle.lookup("storage", "read", { subjectId: "" });
  assert.equal(unscoped.failureClass, "missing_subject");

  const accepted = handle.lookup("storage", "write", {
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
  assert.equal(accepted.behavior.mode, "HARD_STOP_WRITE");
  const serialized = JSON.stringify(accepted);
  assert.doesNotMatch(serialized, /utterance|prompt|arguments/i);

  const wireDoc = schemaToCanonicalDocument(
    degradationRegistrySchema,
    "DegradationRegistry",
    PROTOCOL_VERSION,
  );
  const asText = JSON.stringify(wireDoc);
  assert.doesNotMatch(asText, /utterance|prompt|arguments/i);
});
