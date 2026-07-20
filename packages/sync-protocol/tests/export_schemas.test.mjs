/**
 * Deterministic JSON Schema exporter tests.
 * Run after build: node --test tests/export_schemas.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SchemaExportError,
  ALL_SCHEMA_EXPORT_MAP,
  EVENT_SCHEMA_EXPORT_MAP,
  WIRE_SCHEMA_EXPORT_MAP,
  exportWireSchemas,
  normalizeRefs,
  readExportedSchemaBodies,
  schemaToCanonicalDocument,
  sortKeysDeep,
} from "../scripts/export-schemas.mjs";
import {
  PROTOCOL_VERSION,
  cognitiveStateSchema,
  agentTurnRequestSchema,
  harnessFrameSchema,
} from "../dist/index.js";
import {
  EVENT_CATALOG_VERSION,
  eventSyncAdvisorySchema,
  FORBIDDEN_CATALOG_PAYLOAD_KEYS,
} from "@moolam/observability";

test("sortKeysDeep produces stable key order", () => {
  const unsorted = {
    z: 1,
    a: { d: 2, b: 3 },
    m: [{ y: 1, x: 2 }, { a: 0 }],
    required: ["z", "a"],
  };
  const once = JSON.stringify(sortKeysDeep(unsorted));
  const twice = JSON.stringify(sortKeysDeep(unsorted));
  assert.equal(once, twice);
  assert.equal(
    once,
    JSON.stringify({
      a: { b: 3, d: 2 },
      m: [{ a: 0 }, { x: 2, y: 1 }],
      required: ["a", "z"],
      z: 1,
    }),
  );
});

test("normalizeRefs rewrites unstable $defs names to content digests", () => {
  const input = {
    type: "object",
    properties: {
      a: { $ref: "#/$defs/__schema0" },
      b: { $ref: "#/$defs/__schema0" },
    },
    $defs: {
      __schema0: { type: "string", minLength: 1 },
    },
  };
  const normalized = /** @type {Record<string, unknown>} */ (normalizeRefs(structuredClone(input)));
  const defs = /** @type {Record<string, unknown>} */ (normalized.$defs);
  const names = Object.keys(defs);
  assert.equal(names.length, 1);
  assert.match(names[0], /^def_[0-9a-f]{12}$/);
  const props = /** @type {Record<string, { $ref: string }>} */ (normalized.properties);
  assert.equal(props.a.$ref, `#/$defs/${names[0]}`);
  assert.equal(props.b.$ref, `#/$defs/${names[0]}`);

  // Same input → same digest name (deterministic).
  const again = /** @type {Record<string, unknown>} */ (normalizeRefs(structuredClone(input)));
  assert.deepEqual(Object.keys(/** @type {object} */ (again.$defs)), names);
});

test("two consecutive exports are byte-identical (determinism)", async () => {
  const dirA = await mkdtemp(path.join(tmpdir(), "sutra-schema-a-"));
  const dirB = await mkdtemp(path.join(tmpdir(), "sutra-schema-b-"));
  try {
    await exportWireSchemas({ outDir: dirA });
    await exportWireSchemas({ outDir: dirB });
    const bodiesA = await readExportedSchemaBodies(dirA);
    const bodiesB = await readExportedSchemaBodies(dirB);
    assert.equal(bodiesA.size, Object.keys(ALL_SCHEMA_EXPORT_MAP).length);
    for (const [fileName, body] of bodiesA) {
      assert.equal(bodiesB.get(fileName), body, fileName);
      const doc = JSON.parse(body);
      assert.equal(doc["x-protocol-version"], PROTOCOL_VERSION, fileName);
      assert.equal(doc.title, fileName.replace(/\.json$/, ""));
      if (fileName.startsWith("Event")) {
        assert.equal(doc["x-event-catalog-version"], EVENT_CATALOG_VERSION, fileName);
        assert.equal(typeof doc["x-event-type"], "string", fileName);
      }
    }
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("re-export into the same directory is idempotent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sutra-schema-idemp-"));
  try {
    await exportWireSchemas({ outDir: dir });
    const first = await readExportedSchemaBodies(dir);
    await exportWireSchemas({ outDir: dir });
    const second = await readExportedSchemaBodies(dir);
    for (const [fileName, body] of first) {
      assert.equal(second.get(fileName), body, fileName);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("happy path embeds protocol version and all wire + event envelope files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sutra-schema-happy-"));
  try {
    const result = await exportWireSchemas({ outDir: dir });
    assert.equal(result.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(
      [...result.files].sort(),
      Object.keys(ALL_SCHEMA_EXPORT_MAP)
        .map((n) => `${n}.json`)
        .sort(),
    );
    const cognitive = JSON.parse(
      /** @type {string} */ ((await readExportedSchemaBodies(dir)).get("CognitiveState.json")),
    );
    assert.equal(cognitive["x-protocol-version"], PROTOCOL_VERSION);
    assert.ok(cognitive.properties?.subjectId);
    const syncAdv = JSON.parse(
      /** @type {string} */ (
        (await readExportedSchemaBodies(dir)).get("EventSyncAdvisory.json")
      ),
    );
    assert.equal(syncAdv["x-event-type"], "sync.advisory");
    assert.equal(syncAdv["x-event-catalog-version"], EVENT_CATALOG_VERSION);
    assert.ok(syncAdv.properties?.payload);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edge: event schemas never allow learner-content property names", () => {
  const doc = /** @type {{ properties?: { payload?: { properties?: object } } }} */ (
    schemaToCanonicalDocument(
      eventSyncAdvisorySchema,
      "EventSyncAdvisory",
      PROTOCOL_VERSION,
      {
        "x-event-catalog-version": EVENT_CATALOG_VERSION,
        "x-event-type": "sync.advisory",
      },
    )
  );
  const payloadProps = Object.keys(doc.properties?.payload?.properties ?? {});
  for (const key of FORBIDDEN_CATALOG_PAYLOAD_KEYS) {
    assert.ok(!payloadProps.includes(key), `event schema leaked ${key}`);
  }
  assert.ok(payloadProps.includes("advisoryCode"));
  assert.ok(!payloadProps.includes("detail"));
  assert.equal(Object.keys(EVENT_SCHEMA_EXPORT_MAP).length, 10);
});

test("subject-isolation: CognitiveState and AgentTurnRequest require subjectId", () => {
  const cognitive = /** @type {{ required?: string[] }} */ (
    schemaToCanonicalDocument(cognitiveStateSchema, "CognitiveState", PROTOCOL_VERSION)
  );
  const turn = /** @type {{ required?: string[] }} */ (
    schemaToCanonicalDocument(agentTurnRequestSchema, "AgentTurnRequest", PROTOCOL_VERSION)
  );
  assert.ok(cognitive.required?.includes("subjectId"));
  assert.ok(turn.required?.includes("subjectId"));
});

test("happy path: HarnessFrame is in the wire export map and embeds subjectId", () => {
  assert.equal(WIRE_SCHEMA_EXPORT_MAP.HarnessFrame, "harnessFrameSchema");
  const doc = /** @type {{
    title?: string;
    oneOf?: Array<{ required?: string[] }>;
    anyOf?: Array<{ required?: string[] }>;
  }} */ (
    schemaToCanonicalDocument(harnessFrameSchema, "HarnessFrame", PROTOCOL_VERSION)
  );
  assert.equal(doc.title, "HarnessFrame");
  const variants = doc.oneOf ?? doc.anyOf ?? [];
  assert.ok(variants.length >= 8);
  for (const variant of variants) {
    assert.ok(variant.required?.includes("subjectId"));
  }
});

test("happy path: ToolCallEnvelope and ToolEnvelopeError are in the wire export map", async () => {
  const { toolCallEnvelopeSchema, toolEnvelopeErrorSchema } = await import(
    "../dist/index.js"
  );
  assert.equal(WIRE_SCHEMA_EXPORT_MAP.ToolCallEnvelope, "toolCallEnvelopeSchema");
  assert.equal(WIRE_SCHEMA_EXPORT_MAP.ToolEnvelopeError, "toolEnvelopeErrorSchema");
  const envDoc = schemaToCanonicalDocument(
    toolCallEnvelopeSchema,
    "ToolCallEnvelope",
    PROTOCOL_VERSION,
  );
  const errDoc = schemaToCanonicalDocument(
    toolEnvelopeErrorSchema,
    "ToolEnvelopeError",
    PROTOCOL_VERSION,
  );
  assert.equal(envDoc.title, "ToolCallEnvelope");
  assert.equal(errDoc.title, "ToolEnvelopeError");
  assert.ok(errDoc.properties?.code);
});

test("happy path: MeterEvent and EventHarnessMeter are in export maps", async () => {
  const { meterEventSchema } = await import("../dist/index.js");
  const { eventHarnessMeterSchema } = await import("@moolam/observability");
  assert.equal(WIRE_SCHEMA_EXPORT_MAP.MeterEvent, "meterEventSchema");
  assert.equal(EVENT_SCHEMA_EXPORT_MAP.EventHarnessMeter, "eventHarnessMeterSchema");
  const meterDoc = schemaToCanonicalDocument(
    meterEventSchema,
    "MeterEvent",
    PROTOCOL_VERSION,
  );
  assert.equal(meterDoc.title, "MeterEvent");
  assert.ok(meterDoc.required?.includes("cachedInputTokens"));
  assert.ok(meterDoc.required?.includes("aborted"));
  assert.equal(typeof eventHarnessMeterSchema.safeParse, "function");
});

test("happy path: DegradationRegistry and FreshnessMarker are in the wire export map", async () => {
  const { degradationRegistrySchema, freshnessMarkerSchema } = await import(
    "../dist/index.js"
  );
  assert.equal(
    WIRE_SCHEMA_EXPORT_MAP.DegradationRegistry,
    "degradationRegistrySchema",
  );
  assert.equal(WIRE_SCHEMA_EXPORT_MAP.FreshnessMarker, "freshnessMarkerSchema");
  const regDoc = schemaToCanonicalDocument(
    degradationRegistrySchema,
    "DegradationRegistry",
    PROTOCOL_VERSION,
  );
  const markerDoc = schemaToCanonicalDocument(
    freshnessMarkerSchema,
    "FreshnessMarker",
    PROTOCOL_VERSION,
  );
  assert.equal(regDoc.title, "DegradationRegistry");
  assert.ok(regDoc.required?.includes("modes"));
  assert.ok(regDoc.required?.includes("bindings"));
  assert.equal(markerDoc.title, "FreshnessMarker");
});

test("happy path: DegradationStubVectorCatalog is in the wire export map", async () => {
  const { degradationStubVectorCatalogSchema } = await import("../dist/index.js");
  assert.equal(
    WIRE_SCHEMA_EXPORT_MAP.DegradationStubVectorCatalog,
    "degradationStubVectorCatalogSchema",
  );
  const doc = schemaToCanonicalDocument(
    degradationStubVectorCatalogSchema,
    "DegradationStubVectorCatalog",
    PROTOCOL_VERSION,
  );
  assert.equal(doc.title, "DegradationStubVectorCatalog");
  assert.ok(doc.required?.includes("vectors"));
});

test("missing barrel schema fails with typed SCHEMA_NOT_EXPORTED", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sutra-schema-miss-"));
  try {
    await assert.rejects(
      () =>
        exportWireSchemas({
          outDir: dir,
          barrel: { PROTOCOL_VERSION },
        }),
      (err) => {
        assert.ok(err instanceof SchemaExportError);
        assert.equal(err.code, "SCHEMA_NOT_EXPORTED");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("export into a file path fails with a typed SchemaExportError", async () => {
  const blocker = await mkdtemp(path.join(tmpdir(), "sutra-schema-block-"));
  const fileAsDir = path.join(blocker, "not-a-dir");
  await writeFile(fileAsDir, "nope", "utf8");
  try {
    await assert.rejects(
      () => exportWireSchemas({ outDir: fileAsDir }),
      (err) => {
        assert.ok(err instanceof SchemaExportError);
        assert.match(err.code, /^SCHEMA_/);
        return true;
      },
    );
  } finally {
    await rm(blocker, { recursive: true, force: true });
  }
});
