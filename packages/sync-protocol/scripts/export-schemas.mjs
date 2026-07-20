/**
 * Deterministic JSON Schema exporter for wire-boundary Zod schemas.
 *
 * Zod 4: uses native `z.toJSONSchema` (zod-to-json-schema only parses Zod v3
 * shapes and emits empty definitions for v4 schemas — see its README).
 *
 * Usage: pnpm --filter @moolam/sync-protocol schemas:export
 *
 * Writes one sorted-key JSON Schema file per wire type under `schemas/`
 * (override with SCHEMA_OUT_DIR). Two consecutive runs are byte-identical.
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT_DIR = path.join(PACKAGE_ROOT, "schemas");

/** @typedef {{ code: string; message: string; cause?: unknown }} ExportFailure */

export class SchemaExportError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "SchemaExportError";
    this.code = code;
  }
}

/**
 * Wire envelope types → barrel schema export names.
 * File names are PascalCase type names (e.g. SyncRequest.json).
 */
export const WIRE_SCHEMA_EXPORT_MAP = Object.freeze({
  FrictionSample: "frictionSampleSchema",
  FrictionAggregationRollup: "frictionAggregationRollupSchema",
  ConceptMastery: "conceptMasterySchema",
  CognitiveState: "cognitiveStateSchema",
  SyncRequest: "syncRequestSchema",
  SyncResponse: "syncResponseSchema",
  SyncAdvisory: "syncAdvisorySchema",
  AgentTurnRequest: "agentTurnRequestSchema",
  AgentTurnResponse: "agentTurnResponseSchema",
  HarnessFrame: "harnessFrameSchema",
  ToolCallEnvelope: "toolCallEnvelopeSchema",
  ToolEnvelopeError: "toolEnvelopeErrorSchema",
  MeterEvent: "meterEventSchema",
  DegradationRegistry: "degradationRegistrySchema",
  FreshnessMarker: "freshnessMarkerSchema",
  DegradationStubVectorCatalog: "degradationStubVectorCatalogSchema",
  TurnTrajectoryV1: "turnTrajectoryV1Schema",
});

/**
 * Event catalog envelopes → `@moolam/observability` export names.
 * Same `schemas/` directory; titles are Event* so Python/TS audit tools share shape.
 */
export const EVENT_SCHEMA_EXPORT_MAP = Object.freeze({
  EventTurnStageStart: "eventTurnStageStartSchema",
  EventTurnStageEnd: "eventTurnStageEndSchema",
  EventTurnFrictionSummary: "eventTurnFrictionSummarySchema",
  EventTurnCompleted: "eventTurnCompletedSchema",
  EventSyncOutcome: "eventSyncOutcomeSchema",
  EventSyncAdvisory: "eventSyncAdvisorySchema",
  EventToolInvoked: "eventToolInvokedSchema",
  EventToolResult: "eventToolResultSchema",
  EventHarnessMeter: "eventHarnessMeterSchema",
  EventRuntimeSubscriberError: "eventRuntimeSubscriberErrorSchema",
});

/** Union of all committed schema titles written by this exporter. */
export const ALL_SCHEMA_EXPORT_MAP = Object.freeze({
  ...WIRE_SCHEMA_EXPORT_MAP,
  ...EVENT_SCHEMA_EXPORT_MAP,
});

/**
 * Deep-sort object keys (and stabilize arrays of objects) for byte-identical JSON.
 * @param {unknown} value
 * @returns {unknown}
 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    const mapped = value.map(sortKeysDeep);
    // Stabilize unordered JSON Schema collections (required, enum, anyOf, …).
    if (mapped.length > 1 && mapped.every((item) => typeof item === "string")) {
      return [...mapped].sort((a, b) => a.localeCompare(b));
    }
    if (
      mapped.length > 1 &&
      mapped.every((item) => item !== null && typeof item === "object")
    ) {
      return [...mapped].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
    }
    return mapped;
  }
  if (value !== null && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Rewrite library-generated `$ref` / `$defs` / `definitions` names to stable
 * content-addressed ids so exporter naming quirks cannot flap CI diffs.
 * @param {unknown} schema
 * @returns {unknown}
 */
export function normalizeRefs(schema) {
  if (schema === null || typeof schema !== "object") return schema;

  /** @type {Map<string, string>} */
  const rename = new Map();
  const defsKey =
    schema !== null &&
    typeof schema === "object" &&
    "$defs" in /** @type {object} */ (schema)
      ? "$defs"
      : schema !== null &&
          typeof schema === "object" &&
          "definitions" in /** @type {object} */ (schema)
        ? "definitions"
        : null;

  if (defsKey) {
    const defs = /** @type {Record<string, unknown>} */ (
      /** @type {Record<string, unknown>} */ (schema)[defsKey]
    );
    const entries = Object.entries(defs).map(([name, def]) => {
      const canonical = sortKeysDeep(def);
      const digest = createHash("sha256")
        .update(JSON.stringify(canonical))
        .digest("hex")
        .slice(0, 12);
      const stable = `def_${digest}`;
      rename.set(name, stable);
      return [stable, canonical];
    });
    entries.sort(([a], [b]) => a.localeCompare(b));
    /** @type {Record<string, unknown>} */
    const nextDefs = {};
    for (const [k, v] of entries) nextDefs[k] = v;
    /** @type {Record<string, unknown>} */ (schema)[defsKey] = nextDefs;
  }

  const rewriteRef = (ref) => {
    if (typeof ref !== "string") return ref;
    return ref.replace(/#\/(?:\$defs|definitions)\/([^/#]+)/g, (full, name) => {
      const mapped = rename.get(name);
      if (!mapped) return full;
      const root = full.includes("$defs") ? "$defs" : "definitions";
      return `#/${root}/${mapped}`;
    });
  };

  const walk = (node) => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i]);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = /** @type {Record<string, unknown>} */ (node);
    if (typeof obj.$ref === "string") obj.$ref = rewriteRef(obj.$ref);
    for (const child of Object.values(obj)) walk(child);
  };
  walk(schema);
  return schema;
}

/**
 * Convert one Zod schema into a canonical JSON Schema document.
 * @param {z.ZodType} zodSchema
 * @param {string} typeName
 * @param {string} protocolVersion
 * @param {Record<string, unknown>} [extraMeta]
 */
export function schemaToCanonicalDocument(
  zodSchema,
  typeName,
  protocolVersion,
  extraMeta = {},
) {
  let raw;
  try {
    raw = z.toJSONSchema(zodSchema, {
      target: "draft-07",
      // Wire bytes are the *input* shape (HLC strings before branding transforms).
      io: "input",
      // Inline reused nodes to avoid unstable auto-named `$defs` when possible.
      reused: "inline",
      cycles: "ref",
    });
  } catch (cause) {
    throw new SchemaExportError(
      "SCHEMA_CONVERT_FAILED",
      `failed to convert ${typeName} to JSON Schema`,
      { cause },
    );
  }

  const MAX_SAFE = 9007199254740991;
  const stripZodNoise = (node) => {
    if (Array.isArray(node)) return node.map(stripZodNoise);
    if (!node || typeof node !== "object") return node;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "maximum" && v === MAX_SAFE) continue;
      if (k === "propertyNames") continue;
      if (k === "additionalProperties" && v === false) continue;
      out[k] = stripZodNoise(v);
    }
    return out;
  };

  const withMeta = {
    ...stripZodNoise(raw),
    title: typeName,
    "x-protocol-version": protocolVersion,
    ...extraMeta,
  };

  return sortKeysDeep(normalizeRefs(withMeta));
}

/**
 * @param {string} outDir
 * @param {string} fileName
 * @param {string} body
 */
async function writeAtomic(outDir, fileName, body) {
  const target = path.join(outDir, fileName);
  const staging = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(staging, body, "utf8");
    await rename(staging, target);
  } catch (cause) {
    await rm(staging, { force: true }).catch(() => {});
    throw new SchemaExportError(
      "SCHEMA_WRITE_FAILED",
      `failed to write ${fileName}`,
      { cause },
    );
  }
}

/**
 * Emit structured, content-free progress events (never subject utterances).
 * @param {Record<string, unknown>} event
 */
function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * @param {{
 *   outDir?: string;
 *   barrel?: Record<string, unknown>;
 *   eventBarrel?: Record<string, unknown>;
 *   skipEventSchemas?: boolean;
 * }} [options]
 */
export async function exportWireSchemas(options = {}) {
  const outDir = path.resolve(options.outDir ?? DEFAULT_OUT_DIR);

  let barrel = options.barrel;
  if (!barrel) {
    const entry = pathToFileURL(path.join(PACKAGE_ROOT, "dist", "index.js")).href;
    try {
      barrel = await import(entry);
    } catch (cause) {
      throw new SchemaExportError(
        "SCHEMA_BARREL_LOAD_FAILED",
        "could not import @moolam/sync-protocol dist barrel — run build first",
        { cause },
      );
    }
  }

  const protocolVersion = /** @type {string | undefined} */ (barrel.PROTOCOL_VERSION);
  if (typeof protocolVersion !== "string" || protocolVersion.length === 0) {
    throw new SchemaExportError(
      "SCHEMA_PROTOCOL_VERSION_MISSING",
      "PROTOCOL_VERSION missing from package barrel",
    );
  }

  let eventBarrel = options.eventBarrel;
  if (!options.skipEventSchemas && !eventBarrel) {
    try {
      eventBarrel = await import("@moolam/observability");
    } catch (cause) {
      throw new SchemaExportError(
        "SCHEMA_EVENT_BARREL_LOAD_FAILED",
        "could not import @moolam/observability — build observability first",
        { cause },
      );
    }
  }

  // All-or-nothing: stage every file, then promote. Avoids partial durable sets.
  let stagingRoot;
  /** @type {Array<{ fileName: string; body: string; typeName: string }>} */
  const staged = [];

  try {
    await mkdir(outDir, { recursive: true });
    stagingRoot = await mkdtemp(path.join(tmpdir(), "sutra-schema-export-"));

    for (const [typeName, exportName] of Object.entries(WIRE_SCHEMA_EXPORT_MAP)) {
      const zodSchema = barrel[exportName];
      if (!zodSchema || typeof zodSchema.safeParse !== "function") {
        throw new SchemaExportError(
          "SCHEMA_NOT_EXPORTED",
          `wire schema ${exportName} is not reachable from the package barrel`,
        );
      }

      /** @type {Record<string, unknown>} */
      const extraMeta =
        typeName === "TurnTrajectoryV1" &&
        typeof barrel.TRAJECTORY_FORMAT_VERSION === "string"
          ? {
              "x-trajectory-format-version": barrel.TRAJECTORY_FORMAT_VERSION,
            }
          : {};

      const document = schemaToCanonicalDocument(
        /** @type {z.ZodType} */ (zodSchema),
        typeName,
        protocolVersion,
        extraMeta,
      );
      const body = `${JSON.stringify(document, null, 2)}\n`;
      const fileName = `${typeName}.json`;
      await writeFile(path.join(stagingRoot, fileName), body, "utf8");
      staged.push({ fileName, body, typeName });
      emit({
        event: "schema.export",
        schema: typeName,
        outcome: "staged",
        protocolVersion,
        bytes: Buffer.byteLength(body, "utf8"),
      });
    }

    if (!options.skipEventSchemas) {
      const catalogVersion = /** @type {string | undefined} */ (
        eventBarrel?.EVENT_CATALOG_VERSION
      );
      if (typeof catalogVersion !== "string" || catalogVersion.length === 0) {
        throw new SchemaExportError(
          "SCHEMA_EVENT_CATALOG_VERSION_MISSING",
          "EVENT_CATALOG_VERSION missing from @moolam/observability barrel",
        );
      }
      const dotTypes =
        /** @type {Record<string, string> | undefined} */ (
          eventBarrel?.EVENT_SCHEMA_DOT_TYPE
        ) ?? {};

      for (const [typeName, exportName] of Object.entries(EVENT_SCHEMA_EXPORT_MAP)) {
        const zodSchema = eventBarrel?.[exportName];
        if (!zodSchema || typeof zodSchema.safeParse !== "function") {
          throw new SchemaExportError(
            "SCHEMA_NOT_EXPORTED",
            `event schema ${exportName} is not reachable from @moolam/observability`,
          );
        }
        const document = schemaToCanonicalDocument(
          /** @type {z.ZodType} */ (zodSchema),
          typeName,
          protocolVersion,
          {
            "x-event-catalog-version": catalogVersion,
            "x-event-type": dotTypes[typeName] ?? typeName,
          },
        );
        const body = `${JSON.stringify(document, null, 2)}\n`;
        const fileName = `${typeName}.json`;
        await writeFile(path.join(stagingRoot, fileName), body, "utf8");
        staged.push({ fileName, body, typeName });
        emit({
          event: "schema.export",
          schema: typeName,
          kind: "event-catalog",
          outcome: "staged",
          protocolVersion,
          eventCatalogVersion: catalogVersion,
          bytes: Buffer.byteLength(body, "utf8"),
        });
      }
    }

    for (const { fileName, body, typeName } of staged) {
      await writeAtomic(outDir, fileName, body);
      emit({
        event: "schema.export",
        schema: typeName,
        outcome: "ok",
        protocolVersion,
        bytes: Buffer.byteLength(body, "utf8"),
        path: path.join(outDir, fileName),
      });
    }

    emit({
      event: "schema.export.complete",
      outcome: "ok",
      protocolVersion,
      count: staged.length,
      outDir,
    });

    return { outDir, protocolVersion, files: staged.map((s) => s.fileName) };
  } catch (err) {
    const failure =
      err instanceof SchemaExportError
        ? err
        : new SchemaExportError("SCHEMA_EXPORT_FAILED", "schema export failed", {
            cause: err,
          });
    emit({
      event: "schema.export.complete",
      outcome: "error",
      code: failure.code,
      message: failure.message,
    });
    throw failure;
  } finally {
    if (stagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * @param {string} outDir
 * @param {{ includeEvents?: boolean }} [opts]
 * @returns {Promise<Map<string, string>>}
 */
export async function readExportedSchemaBodies(outDir, opts = {}) {
  const includeEvents = opts.includeEvents !== false;
  /** @type {Map<string, string>} */
  const bodies = new Map();
  const map = includeEvents ? ALL_SCHEMA_EXPORT_MAP : WIRE_SCHEMA_EXPORT_MAP;
  for (const typeName of Object.keys(map)) {
    const fileName = `${typeName}.json`;
    const body = await readFile(path.join(outDir, fileName), "utf8");
    bodies.set(fileName, body);
  }
  return bodies;
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  exportWireSchemas({
    outDir: process.env.SCHEMA_OUT_DIR
      ? path.resolve(process.env.SCHEMA_OUT_DIR)
      : DEFAULT_OUT_DIR,
  }).catch((err) => {
    const code = err instanceof SchemaExportError ? err.code : "SCHEMA_EXPORT_FAILED";
    console.error(`[${code}] ${err.message}`);
    process.exitCode = 1;
  });
}
