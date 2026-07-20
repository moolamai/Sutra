/**
 * Per-shard provenance + license ledger schema.
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
  LICENSE_CATALOG_LIMIT,
  LICENSE_LEDGER_PACKAGE_ROOT,
  LICENSE_LEDGER_SCHEMA_VERSION,
  PROVENANCE_JSON_SCHEMA_PATH,
  SHARD_PROVENANCE_LEDGER_LIMIT,
  SHARD_PROVENANCE_SCHEMA_VERSION,
  buildShardProvenance,
  canonicalLicenseLedgerBytes,
  catalogFromManifestLicenseLedger,
  assembleBuildLicenseLedger,
  flagsForConsentClass,
  loadLicenseLedgerDocument,
  parseLicenseLedgerDocument,
  parseShardProvenance,
  validateShardProvenanceAgainstCatalog,
  writeLicenseLedgerDocument,
} from "../dist/license_ledger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const VALID_LEDGER = path.join(
  PKG_ROOT,
  "fixtures",
  "provenance",
  "valid-ledger.json",
);
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

const CATALOG = [
  {
    licenseId: "lic.cc-by-4.0",
    licenseClass: "open",
    spdxOrLabel: "CC-BY-4.0",
  },
];

test("unit: committed provenance_schema.json declares schema defs", () => {
  assert.equal(PROVENANCE_JSON_SCHEMA_PATH, path.join(LICENSE_LEDGER_PACKAGE_ROOT, "provenance_schema.json"));
  assert.ok(existsSync(PROVENANCE_JSON_SCHEMA_PATH));
  const schema = JSON.parse(readFileSync(PROVENANCE_JSON_SCHEMA_PATH, "utf8"));
  assert.ok(schema.$defs.shardProvenance);
  assert.ok(schema.$defs.licenseLedgerDocument);
  assert.ok(schema.$defs.licenseCatalogEntry);
  assert.deepEqual(schema.$defs.licenseClass.enum, [
    "open",
    "restricted",
    "government",
    "proprietary",
  ]);
  assert.ok(!schema.$defs.licenseClass.enum.includes("unknown"));
});

test("happy path: valid ledger fixture parses and validates", () => {
  const events = [];
  const result = loadLicenseLedgerDocument(VALID_LEDGER, {
    subjectId: "subj.corpus.prov.ok",
    deviceId: "dev-prov",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.value.schemaVersion, LICENSE_LEDGER_SCHEMA_VERSION);
  assert.equal(result.value.entries.length, 2);
  assert.ok(result.value.entries.every((e) => e.syntheticFlag === true));
  assert.ok(events.some((e) => e.op === "validate" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("happy path: writeLicenseLedgerDocument is byte-identical across writes", () => {
  const loaded = loadLicenseLedgerDocument(VALID_LEDGER);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const tmp = mkdtempSync(path.join(tmpdir(), "corpus-prov-write-"));
  try {
    const a = path.join(tmp, "a.json");
    const b = path.join(tmp, "b.json");
    const r1 = writeLicenseLedgerDocument(a, loaded.value);
    const r2 = writeLicenseLedgerDocument(b, loaded.value);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.deepEqual(readFileSync(a), readFileSync(b));
    assert.deepEqual(readFileSync(a), canonicalLicenseLedgerBytes(loaded.value));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: unknown licenseId is rejected (exclude / never defaulted)", () => {
  const events = [];
  const record = buildShardProvenance({
    shardId: "shard.x",
    sourceId: "src.x",
    licenseId: "lic.unknown",
    licenseClass: "open",
    consentClass: "public",
  });
  const result = validateShardProvenanceAgainstCatalog(record, CATALOG, {
    subjectId: "subj.corpus.prov.license",
    deviceId: "dev-prov",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "license");
  assert.match(result.message, /unknown licenseId/i);
  assert.ok(
    events.some(
      (e) => e.op === "resolve" && e.outcome === "error" && e.failureClass === "license",
    ),
  );
});

test("edge: licenseClass unknown string is excluded at parse", () => {
  const result = parseShardProvenance({
    schemaVersion: SHARD_PROVENANCE_SCHEMA_VERSION,
    shardId: "shard.x",
    sourceId: "src.x",
    licenseId: "lic.cc-by-4.0",
    licenseClass: "unknown",
    consentClass: "public",
    syntheticFlag: false,
    governmentFlag: false,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "license");
  assert.match(result.message, /unknown licenseClass/i);
});

test("edge: flag mismatch with consentClass is rejected", () => {
  const result = parseShardProvenance({
    schemaVersion: SHARD_PROVENANCE_SCHEMA_VERSION,
    shardId: "shard.x",
    sourceId: "src.x",
    licenseId: "lic.cc-by-4.0",
    licenseClass: "open",
    consentClass: "synthetic",
    syntheticFlag: false,
    governmentFlag: false,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "flag_mismatch");
});

test("edge: write rejects invalid and does not create a partial file", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "corpus-prov-bad-"));
  try {
    const out = path.join(tmp, "ledger.json");
    const result = writeLicenseLedgerDocument(out, {
      schemaVersion: LICENSE_LEDGER_SCHEMA_VERSION,
      catalog: CATALOG,
      entries: [
        {
          schemaVersion: SHARD_PROVENANCE_SCHEMA_VERSION,
          shardId: "shard.x",
          sourceId: "src.x",
          licenseId: "lic.missing",
          licenseClass: "open",
          consentClass: "public",
          ...flagsForConsentClass("public"),
        },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sovereignty: consented and public never share flags incorrectly; telemetry scoped", () => {
  const events = [];
  const consented = buildShardProvenance({
    shardId: "shard.consented",
    sourceId: "src.c",
    licenseId: "lic.cc-by-4.0",
    licenseClass: "open",
    consentClass: "consented",
  });
  assert.equal(consented.syntheticFlag, false);
  assert.equal(consented.governmentFlag, false);

  const govCatalog = [
    {
      licenseId: "lic.gov-open",
      licenseClass: "government",
      spdxOrLabel: "GOV-OPEN",
    },
  ];
  const govRecord = buildShardProvenance({
    shardId: "shard.gov",
    sourceId: "src.g",
    licenseId: "lic.gov-open",
    licenseClass: "government",
    consentClass: "government",
  });
  assert.equal(govRecord.governmentFlag, true);
  assert.equal(govRecord.syntheticFlag, false);

  const ok = validateShardProvenanceAgainstCatalog(govRecord, govCatalog, {
    subjectId: "subj.corpus.prov.iso",
    deviceId: "dev-prov-iso",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(ok.ok, true);
  assert.ok(events.every((e) => e.subjectId === "subj.corpus.prov.iso"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("scalability: catalog and ledger entry limits are finite constants", () => {
  assert.ok(LICENSE_CATALOG_LIMIT > 0 && LICENSE_CATALOG_LIMIT <= 4096);
  assert.ok(
    SHARD_PROVENANCE_LEDGER_LIMIT > 0 && SHARD_PROVENANCE_LEDGER_LIMIT <= 65536,
  );
});

test("edge: duplicate shardId in ledger is rejected", () => {
  const entry = buildShardProvenance({
    shardId: "shard.dup",
    sourceId: "src.a",
    licenseId: "lic.cc-by-4.0",
    licenseClass: "open",
    consentClass: "public",
  });
  const result = parseLicenseLedgerDocument({
    schemaVersion: LICENSE_LEDGER_SCHEMA_VERSION,
    catalog: CATALOG,
    entries: [entry, { ...entry, sourceId: "src.b" }],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "duplicate");
});

test("happy path: assembleBuildLicenseLedger emits deterministic hash", () => {
  const catalog = catalogFromManifestLicenseLedger([
    {
      licenseId: "lic.cc-by-4.0",
      spdxOrLabel: "CC-BY-4.0",
      licenseClass: "open",
    },
  ]);
  assert.equal(catalog.ok, true);
  if (!catalog.ok) return;

  const a = assembleBuildLicenseLedger({
    manifestId: "corpus.test",
    catalog: catalog.value,
    shards: [
      {
        shardId: "shard.b",
        sourceId: "src.b",
        licenseId: "lic.cc-by-4.0",
        laneCode: "teacher",
      },
      {
        shardId: "shard.a",
        sourceId: "src.a",
        licenseId: "lic.cc-by-4.0",
        laneCode: "teacher",
      },
    ],
    consentClass: "synthetic",
  });
  const b = assembleBuildLicenseLedger({
    manifestId: "corpus.test",
    catalog: catalog.value,
    shards: [
      {
        shardId: "shard.a",
        sourceId: "src.a",
        licenseId: "lic.cc-by-4.0",
        laneCode: "teacher",
      },
      {
        shardId: "shard.b",
        sourceId: "src.b",
        licenseId: "lic.cc-by-4.0",
        laneCode: "teacher",
      },
    ],
    consentClass: "synthetic",
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.value.contentHash, b.value.contentHash);
  assert.deepEqual(a.value.bytes, b.value.bytes);
  assert.equal(a.value.relpath, "license-ledger.json");
});

test("edge: uninferable license label fails catalog resolution", () => {
  const result = catalogFromManifestLicenseLedger([
    { licenseId: "lic.mystery", spdxOrLabel: "???" },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "license");
  assert.match(result.message, /unresolvable licenseClass/i);
});
