/**
 * Deterministic JSON Schema exporter for TurnTrajectoryRecord.
 *
 * Zod 4: uses native `z.toJSONSchema`. Writes `schemas/trajectory/v1.json`
 * (repo root). Two consecutive runs are byte-identical.
 *
 * Usage:
 *   pnpm --filter @moolam/learning schemas:export
 *   pnpm --filter @moolam/learning schemas:check
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
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
export const TRAJECTORY_SCHEMA_OUT_RELPATH = "schemas/trajectory/v1.json";
/** Alias matching `@moolam/learning` barrel constant. */
export const TRAJECTORY_COMMITTED_SCHEMA_RELPATH = TRAJECTORY_SCHEMA_OUT_RELPATH;
export const DEFAULT_OUT_PATH = path.join(
  REPO_ROOT,
  TRAJECTORY_SCHEMA_OUT_RELPATH,
);

export class TrajectorySchemaExportError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "TrajectorySchemaExportError";
    this.code = code;
  }
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    const mapped = value.map(sortKeysDeep);
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
      sorted[key] = sortKeysDeep(
        /** @type {Record<string, unknown>} */ (value)[key],
      );
    }
    return sorted;
  }
  return value;
}

/**
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
 * Convert TurnTrajectoryRecord Zod schema into a canonical JSON Schema document.
 * @param {z.ZodType} zodSchema
 * @param {string} schemaVersion
 */
export function trajectorySchemaToCanonicalDocument(zodSchema, schemaVersion) {
  let raw;
  try {
    raw = z.toJSONSchema(zodSchema, {
      target: "draft-07",
      io: "input",
      reused: "inline",
      cycles: "ref",
    });
  } catch (cause) {
    throw new TrajectorySchemaExportError(
      "SCHEMA_CONVERT_FAILED",
      "failed to convert TurnTrajectoryRecord to JSON Schema",
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
      // Keep additionalProperties: false — trajectory forbids raw content keys.
      out[k] = stripZodNoise(v);
    }
    return out;
  };

  const withMeta = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://moolam.ai/schemas/trajectory/v1.json",
    ...stripZodNoise(raw),
    title: "TurnTrajectoryRecord",
    description:
      "B9 metadata-grade turn trajectory + optional C0 training fields " +
      "(policyCheckpointHash, rolloutSeed, precisionFormat, executionState, routerReplayMap). " +
      "Additive evolution; dense SLMs may omit routerReplayMap. " +
      "Structured metadata only — never raw learner content bodies.",
    "x-trajectory-schema-version": schemaVersion,
    "x-forward-compat": {
      routerReplayMap: {
        required: false,
        denseSlmMayOmit: true,
        note:
          "Dense on-device SLMs omit routerReplayMap; parsers accept absence. " +
          "Additive evolution only.",
      },
    },
    "x-invariants": {
      floatingCheckpointForbidden: true,
      keystrokesForbidden: true,
      consentRequired: true,
      additiveEvolutionOnly: true,
    },
  };

  // Ensure training / sovereign fields stay documented even if Zod omits notes.
  if (withMeta.properties && typeof withMeta.properties === "object") {
    const props = /** @type {Record<string, Record<string, unknown>>} */ (
      withMeta.properties
    );
    if (props.policyCheckpointHash) {
      props.policyCheckpointHash.description =
        "Exact adapter/base checkpoint hash — never the floating token 'latest'";
    }
    if (props.rolloutSeed) {
      props.rolloutSeed.description =
        "Gym / fleet rollout seed (uint32) for IMPALA lineage — opaque metadata, not utterance text";
    }
    if (props.executionState) {
      props.executionState.description =
        "Last attempted command + terminal status (stream abort must not omit)";
    }
    if (props.routerReplayMap) {
      props.routerReplayMap.description =
        "Forward-compat: dense on-device SLMs may omit; parsers must accept absence";
    }
    if (props.consent) {
      props.consent.description =
        "Consent record; export requires optedIn === true (sovereign boundary)";
    }
  }

  return sortKeysDeep(normalizeRefs(withMeta));
}

/**
 * @param {string} targetPath
 * @param {string} body
 */
async function writeAtomic(targetPath, body) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const staging = `${targetPath}.${process.pid}.tmp`;
  try {
    await writeFile(staging, body, "utf8");
    await rename(staging, targetPath);
  } catch (cause) {
    await rm(staging, { force: true }).catch(() => {});
    throw new TrajectorySchemaExportError(
      "SCHEMA_WRITE_FAILED",
      `failed to write ${targetPath}`,
      { cause },
    );
  }
}

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "learning.trajectory.schema.export", ...event })}\n`,
  );
}

/**
 * @param {{ outPath?: string; barrel?: Record<string, unknown> }} [options]
 */
export async function exportTrajectorySchema(options = {}) {
  const outPath = path.resolve(options.outPath ?? DEFAULT_OUT_PATH);

  let barrel = options.barrel;
  if (!barrel) {
    const entry = pathToFileURL(path.join(PACKAGE_ROOT, "dist", "index.js")).href;
    try {
      barrel = await import(entry);
    } catch (cause) {
      throw new TrajectorySchemaExportError(
        "SCHEMA_BARREL_LOAD_FAILED",
        "could not import @moolam/learning dist barrel — run build first",
        { cause },
      );
    }
  }

  const schemaVersion = barrel.TRAJECTORY_SCHEMA_VERSION;
  const zodSchema = barrel.turnTrajectoryRecordSchema;
  if (typeof schemaVersion !== "string" || !zodSchema) {
    throw new TrajectorySchemaExportError(
      "SCHEMA_BARREL_INCOMPLETE",
      "TRAJECTORY_SCHEMA_VERSION / turnTrajectoryRecordSchema missing from barrel",
    );
  }

  const doc = trajectorySchemaToCanonicalDocument(zodSchema, schemaVersion);
  const body = `${JSON.stringify(doc, null, 2)}\n`;
  await writeAtomic(outPath, body);

  const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
  emit({
    outcome: "ok",
    phase: "export",
    outPath: path.relative(REPO_ROOT, outPath).replace(/\\/g, "/"),
    schemaVersion,
    digest,
    subjectId: null,
    deviceId: "ci-export",
  });

  return { outPath, body, schemaVersion, digest };
}

/**
 * Fail if committed schemas/trajectory/v1.json drifted from Zod export.
 * @param {{ committedPath?: string }} [options]
 */
export async function checkTrajectorySchemaCommitted(options = {}) {
  const committedPath = path.resolve(
    options.committedPath ?? DEFAULT_OUT_PATH,
  );
  const dir = await mkdtemp(path.join(tmpdir(), "sutra-traj-schema-"));
  const regeneratedPath = path.join(dir, "v1.json");
  try {
    const { body: regenerated, schemaVersion, digest } =
      await exportTrajectorySchema({ outPath: regeneratedPath });
    let committed;
    try {
      committed = await readFile(committedPath, "utf8");
    } catch (cause) {
      throw new TrajectorySchemaExportError(
        "SCHEMA_COMMITTED_MISSING",
        `committed schema missing at ${committedPath} — run schemas:export`,
        { cause },
      );
    }
    if (committed !== regenerated) {
      emit({
        outcome: "error",
        failureClass: "schema_drift",
        schemaVersion,
        committedPath: path
          .relative(REPO_ROOT, committedPath)
          .replace(/\\/g, "/"),
        subjectId: null,
        deviceId: "ci-gate",
      });
      const committedLines = committed.split("\n");
      const regenLines = regenerated.split("\n");
      const max = Math.max(committedLines.length, regenLines.length);
      const diff = [
        `--- ${TRAJECTORY_SCHEMA_OUT_RELPATH} (committed)`,
        `+++ ${TRAJECTORY_SCHEMA_OUT_RELPATH} (exported)`,
        "@@ trajectory schema drift @@",
      ];
      for (let i = 0; i < max && diff.length < 80; i += 1) {
        const c = committedLines[i];
        const r = regenLines[i];
        if (c === r) continue;
        if (c !== undefined) diff.push(`-${c}`);
        if (r !== undefined) diff.push(`+${r}`);
      }
      process.stdout.write(`\n${diff.join("\n")}\n`);
      throw new TrajectorySchemaExportError(
        "SCHEMA_DRIFT",
        `schemas/trajectory/v1.json drifted — run pnpm --filter @moolam/learning schemas:export`,
      );
    }

    // Invariant spot-checks on the committed document (sovereignty metadata).
    const doc = JSON.parse(committed);
    if (doc.title !== "TurnTrajectoryRecord") {
      throw new TrajectorySchemaExportError(
        "SCHEMA_TITLE_MISMATCH",
        "committed schema title must be TurnTrajectoryRecord",
      );
    }
    if (doc["x-trajectory-schema-version"] !== schemaVersion) {
      throw new TrajectorySchemaExportError(
        "SCHEMA_VERSION_MISMATCH",
        "x-trajectory-schema-version must match TRAJECTORY_SCHEMA_VERSION",
      );
    }
    if (doc["x-forward-compat"]?.routerReplayMap?.denseSlmMayOmit !== true) {
      throw new TrajectorySchemaExportError(
        "SCHEMA_FORWARD_COMPAT_MISSING",
        "x-forward-compat.routerReplayMap.denseSlmMayOmit must be true",
      );
    }
    const required = new Set(doc.required ?? []);
    if (required.has("routerReplayMap")) {
      throw new TrajectorySchemaExportError(
        "SCHEMA_ROUTER_REQUIRED",
        "routerReplayMap must remain optional for dense SLMs",
      );
    }
    for (const field of [
      "policyCheckpointHash",
      "rolloutSeed",
      "precisionFormat",
      "executionState",
      "routerReplayMap",
      "consent",
      "subjectId",
    ]) {
      if (!doc.properties?.[field]) {
        throw new TrajectorySchemaExportError(
          "SCHEMA_FIELD_MISSING",
          `committed schema missing properties.${field}`,
        );
      }
    }
    if (doc.properties?.keystrokes) {
      throw new TrajectorySchemaExportError(
        "SCHEMA_KEYSTROKE_LEAK",
        "committed schema must not define keystrokes",
      );
    }

    emit({
      outcome: "ok",
      phase: "check",
      schemaVersion,
      digest,
      subjectId: null,
      deviceId: "ci-gate",
    });
    return { ok: true, schemaVersion, digest };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const checkOnly = process.argv.includes("--check");
  const run = checkOnly
    ? checkTrajectorySchemaCommitted()
    : exportTrajectorySchema();
  run
    .then(() => process.exit(0))
    .catch((err) => {
      emit({
        outcome: "error",
        code: err?.code ?? "SCHEMA_EXPORT_FAILED",
        message:
          err instanceof Error ? err.message.slice(0, 500) : String(err),
        subjectId: null,
        deviceId: "ci-export",
      });
      process.exit(1);
    });
}
