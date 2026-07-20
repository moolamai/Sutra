/**
 * Adapter delta manifest schema (C5 packaging boundary).
 * Run: node --experimental-strip-types --test training/delivery/adapter_format.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION,
  ADAPTER_FORMAT_JSON_SCHEMA_PATH,
  ADAPTER_PRECISION_FORMATS,
  AdapterManifestContractError,
  assertCommittedAdapterFormatSchemaPresent,
  fixtureAdapterDeltaManifest,
  parseAdapterDeltaManifest,
  parseAdapterDeltaManifestOrThrow,
  packAdapterFromGrpoTrainerOutput,
  proveAdapterDeltaManifestSchemaMicroRun,
  proveAdapterPackFromGrpoMicroRun,
  resetAdapterPackCache,
  synthesizeGrpoPackDeltaBytes,
  contentAddressAdapterPackBlob,
} from "./pack_adapter.ts";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

test("unit: committed adapter_format.json declares schema version and fields", () => {
  assertCommittedAdapterFormatSchemaPresent();
  assert.ok(existsSync(ADAPTER_FORMAT_JSON_SCHEMA_PATH));
  const schema = JSON.parse(
    readFileSync(ADAPTER_FORMAT_JSON_SCHEMA_PATH, "utf8"),
  );
  assert.equal(
    schema.properties.schemaVersion.const,
    ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION,
  );
  for (const field of [
    "contentHash",
    "baseModelHash",
    "precisionFormat",
    "loraRank",
    "loraAlpha",
    "lineageRef",
    "adapterBlobRef",
  ]) {
    assert.ok(schema.properties[field], `missing ${field}`);
    assert.ok(schema.required.includes(field), `required missing ${field}`);
  }
  assert.deepEqual(schema.properties.precisionFormat.enum, [
    ...ADAPTER_PRECISION_FORMATS,
  ]);
  assert.equal(
    schema.properties.lineageRef.properties.schemaVersion.const,
    "checkpoint.lineage.v1",
  );
  assert.equal(schema.properties.lineageRef.properties.criticVersions.minItems, 1);
});

test("happy path: valid manifest parses and emits metadata-only telemetry", () => {
  const events = [];
  const subjectId = "subj.adapter.manifest.ok";
  const deviceId = "dev.adapter.manifest.ok";
  const fixture = fixtureAdapterDeltaManifest({ subjectId, deviceId });
  const result = parseAdapterDeltaManifest(fixture, {
    subjectId,
    deviceId,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.value.schemaVersion, ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION);
    assert.equal(result.value.loraRank, 16);
    assert.equal(result.value.loraAlpha, 32);
    assert.equal(result.value.precisionFormat, "int4");
    assert.ok(result.value.lineageRef.criticVersions.length >= 1);
  }
  assert.ok(
    events.some(
      (e) =>
        e.event === "training.adapter.manifest_validate" && e.outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: floating latest / incomplete lineage / cross-subject refused", () => {
  const subjectId = "subj.adapter.manifest.edge";
  const deviceId = "dev.adapter.manifest.edge";
  const base = fixtureAdapterDeltaManifest({ subjectId, deviceId });

  const floating = parseAdapterDeltaManifest(
    { ...base, baseModelHash: "latest" },
    { subjectId, deviceId },
  );
  assert.equal(floating.ok, false);
  if (!floating.ok) {
    assert.equal(
      floating.error.obligation,
      "adapter.manifest.floating_checkpoint",
    );
  }

  const incomplete = parseAdapterDeltaManifest(
    {
      ...base,
      lineageRef: { ...base.lineageRef, criticVersions: [] },
    },
    { subjectId, deviceId },
  );
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) {
    assert.equal(
      incomplete.error.obligation,
      "adapter.manifest.lineage_incomplete",
    );
  }

  const cross = parseAdapterDeltaManifest(
    { ...base, subjectId: "subj.other" },
    { subjectId, deviceId },
  );
  assert.equal(cross.ok, false);
  if (!cross.ok) {
    assert.equal(cross.error.obligation, "adapter.manifest.subject_scope");
  }

  assert.throws(
    () =>
      parseAdapterDeltaManifestOrThrow(
        { ...base, locality: "cloud-saas" },
        { subjectId, deviceId },
      ),
    (err) =>
      err instanceof AdapterManifestContractError &&
      err.obligation === "adapter.manifest.locality_forbidden",
  );
});

test("prove: schema micro-run green", () => {
  const events = [];
  const proved = proveAdapterDeltaManifestSchemaMicroRun({
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proved.ok, true);
  assert.ok(proved.schemaPath.endsWith("adapter_format.json"));
  assert.equal(
    proved.manifest.schemaVersion,
    ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION,
  );
  assert.ok(events.some((e) => e.outcome === "ok"));
});

test("happy path: pack GRPO delta into content-addressed manifest + blob", () => {
  resetAdapterPackCache();
  const events = [];
  const subjectId = "subj.adapter.pack.ok";
  const deviceId = "dev.adapter.pack.ok";
  const baseModelHash = "ckpt:sha256:packokbase000001";
  const deltaBytes = synthesizeGrpoPackDeltaBytes({
    baseModelHash,
    rank: 16,
    alpha: 32,
    loss: -0.2,
    step: 0,
  });
  const contentHash = contentAddressAdapterPackBlob(deltaBytes);
  const packed = packAdapterFromGrpoTrainerOutput(
    {
      subjectId,
      deviceId,
      locality: "on-device",
      baseModelHash,
      precisionFormat: "int4",
      loraRank: 16,
      loraAlpha: 32,
      deltaBytes,
      trainerDeltaHash: contentHash,
      packId: "pack.ok.01",
      lineageRef: {
        schemaVersion: "checkpoint.lineage.v1",
        runId: "run.grpo.pack.ok",
        checkpointHash: "ckpt:sha256:packoklineage001",
        corpusManifestHash:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        criticVersions: [
          {
            rubricId: "core.format",
            rubricVersion: "1.0.0",
            contentHash:
              "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          },
        ],
      },
    },
    { onTelemetry: (e) => events.push(e) },
  );

  assert.equal(packed.ok, true);
  assert.equal(packed.idempotentReplay, false);
  assert.equal(packed.contentHash, contentHash);
  assert.equal(packed.manifest.contentHash, contentHash);
  assert.equal(packed.manifest.baseModelHash, baseModelHash);
  assert.equal(packed.manifest.adapterBlobRef, `cas://${contentHash}`);
  assert.equal(packed.blob.byteLength, packed.byteLength);
  assert.ok(
    events.some(
      (e) => e.event === "training.adapter.pack_emit" && e.outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: empty delta / trainer hash mismatch / idempotent conflict / subject isolation", () => {
  const events = [];
  const proved = proveAdapterPackFromGrpoMicroRun({
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.packed.ok, true);
  assert.equal(proved.replay.idempotentReplay, true);
  assert.equal(proved.replay.contentHash, proved.packed.contentHash);
  assert.deepEqual(proved.packed.blob, proved.replay.blob);
  assert.ok(proved.refused.includes("adapter.pack.empty_delta"));
  assert.ok(proved.refused.includes("adapter.manifest.lineage_incomplete"));
  assert.ok(proved.refused.includes("adapter.pack.trainer_hash_mismatch"));
  assert.ok(proved.refused.includes("adapter.pack.idempotent_conflict"));
  assert.ok(proved.refused.includes("adapter.manifest.subject_scope"));
  assert.ok(
    events.some(
      (e) =>
        e.event === "training.adapter.pack_emit" &&
        e.idempotentReplay === true,
    ),
  );
});
