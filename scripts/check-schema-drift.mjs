/**
 * Schema-drift gate (SYNC-01 / A-G2).
 *
 * 1. Regenerate Zod + Pydantic exports into a temp dir.
 * 2. Diff each against its committed `schemas/` (stale check).
 * 3. Diff the two regenerations against each other after shared drift-canon
 *    normalization (cross-language parity).
 *
 * On any mismatch, print unified diffs and exit 1 — never a bare boolean.
 *
 * Usage (repo root):
 *   node scripts/check-schema-drift.mjs
 */

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffLines } from "./_diff_lines.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const WIRE_TYPES = Object.freeze([
  "FrictionSample",
  "ConceptMastery",
  "CognitiveState",
  "SyncRequest",
  "SyncResponse",
  "SyncAdvisory",
  "AgentTurnRequest",
  "AgentTurnResponse",
]);

const TS_COMMITTED = path.join(REPO_ROOT, "packages/sync-protocol/schemas");
const PY_COMMITTED = path.join(REPO_ROOT, "packages/cloud-orchestrator/schemas");
const MAX_SAFE_INT = 9007199254740991;

/** Structured event — never learner content. */
function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    const mapped = value.map(sortKeysDeep);
    if (mapped.length > 1 && mapped.every((i) => typeof i === "string")) {
      return [...mapped].sort((a, b) => a.localeCompare(b));
    }
    if (mapped.length > 1 && mapped.every((i) => i && typeof i === "object")) {
      return [...mapped].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
    }
    return mapped;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Inline `$defs` / `definitions` so Zod (inline) and Pydantic ($ref) share shape.
 */
export function inlineDefs(schema) {
  const root = structuredClone(schema);
  const defs = { ...(root.$defs ?? {}), ...(root.definitions ?? {}) };
  delete root.$defs;
  delete root.definitions;

  const resolve = (node, stack = new Set()) => {
    if (Array.isArray(node)) return node.map((n) => resolve(n, stack));
    if (!node || typeof node !== "object") return node;
    if (typeof node.$ref === "string") {
      const m = node.$ref.match(/#\/(?:\$defs|definitions)\/(.+)$/);
      if (m) {
        const name = m[1];
        if (stack.has(name)) {
          return { $ref: node.$ref }; // cycle — leave as-is
        }
        const target = defs[name];
        if (target) {
          stack.add(name);
          const inlined = resolve(structuredClone(target), stack);
          stack.delete(name);
          const { $ref: _drop, ...rest } = node;
          return resolve({ ...inlined, ...rest }, stack);
        }
      }
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = resolve(v, stack);
    return out;
  };

  return resolve(root);
}

/**
 * Shared drift-canon: strip exporter cosmetics so equivalent wire shapes match.
 * Does NOT drop real constraint differences (minLength, enum, pattern, …).
 */
export function toDriftCanon(schema) {
  let doc = inlineDefs(schema);

  const walk = (node, isRoot = false) => {
    if (Array.isArray(node)) return node.map((n) => walk(n, false));
    if (!node || typeof node !== "object") return node;

    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "description") continue;
      if (key === "title" && !isRoot) continue;
      if (key === "maximum" && value === MAX_SAFE_INT) continue;
      if (key === "additionalProperties" && value === false) continue;
      if (key === "propertyNames") continue; // Zod record noise; keys are always strings on the wire
      if (key === "$schema") continue; // draft URI noise after inlining nests
      if (key === "x-protocol-version" && !isRoot) continue;
      // Pydantic optional defaults vs Zod `.optional()` (omit) — never wire-meaningful.
      if (key === "default" && value === null) continue;
      out[key] = walk(value, false);
    }

    // Normalize UUID constraints (Zod format+pattern vs Pydantic pattern-only).
    if (
      out.type === "string" &&
      (out.format === "uuid" ||
        (typeof out.pattern === "string" &&
          /\[0-9a-fA-F\]\{8\}/.test(out.pattern) &&
          out.pattern.includes("-")))
    ) {
      return { type: "string", format: "uuid" };
    }

    return out;
  };

  doc = walk(doc, true);
  // Keep root identity metadata for review, but sort.
  if (doc && typeof doc === "object") {
    doc.title = schema.title ?? doc.title;
    doc["x-protocol-version"] = schema["x-protocol-version"] ?? doc["x-protocol-version"];
  }
  return sortKeysDeep(doc);
}

export function loadWireSchemas(dir) {
  /** @type {Map<string, object>} */
  const map = new Map();
  for (const typeName of WIRE_TYPES) {
    const file = path.join(dir, `${typeName}.json`);
    if (!existsSync(file)) {
      throw new Error(`SCHEMA_DRIFT_MISSING_FILE: ${file}`);
    }
    map.set(typeName, JSON.parse(readFileSync(file, "utf8")));
  }
  return map;
}

export function unifyDiff(expectedLabel, expectedText, actualLabel, actualText) {
  if (expectedText === actualText) return "";
  const lines = diffLines(expectedText, actualText);
  const header = [
    `--- ${expectedLabel}`,
    `+++ ${actualLabel}`,
  ];
  return [...header, ...lines].join("\n");
}

function run(cmd, args, env = {}) {
  const result = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    const err = new Error(
      `SCHEMA_DRIFT_EXPORT_FAILED: ${cmd} ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
    err.code = "SCHEMA_DRIFT_EXPORT_FAILED";
    throw err;
  }
  return result;
}

export function exportBothTo(tempRoot) {
  const zodOut = path.join(tempRoot, "zod");
  const pyOut = path.join(tempRoot, "py");
  mkdirSync(zodOut, { recursive: true });
  mkdirSync(pyOut, { recursive: true });

  run("pnpm", ["exec", "turbo", "run", "build", "--filter=@moolam/sync-protocol"]);
  run(
    "pnpm",
    ["--filter", "@moolam/sync-protocol", "exec", "node", "scripts/export-schemas.mjs"],
    { SCHEMA_OUT_DIR: zodOut },
  );

  run(
    "pnpm",
    [
      "--filter",
      "@moolam/cloud-orchestrator",
      "exec",
      "python",
      "scripts/export_schemas.py",
    ],
    {
      SCHEMA_OUT_DIR: pyOut,
      PYTHONPATH: path.join(REPO_ROOT, "packages/cloud-orchestrator/src"),
    },
  );

  return { zodOut, pyOut };
}

/**
 * Compare two schema maps. Modes:
 * - exact: byte-stable pretty JSON of source documents
 * - canon: drift-canon then pretty JSON
 */
export function diffSchemaMaps(left, right, mode, leftLabel, rightLabel) {
  /** @type {string[]} */
  const diffs = [];
  for (const typeName of WIRE_TYPES) {
    const a = left.get(typeName);
    const b = right.get(typeName);
    if (!a) {
      diffs.push(`MISSING in ${leftLabel}: ${typeName}.json`);
      continue;
    }
    if (!b) {
      diffs.push(`MISSING in ${rightLabel}: ${typeName}.json`);
      continue;
    }
    const leftDoc = mode === "canon" ? toDriftCanon(a) : sortKeysDeep(a);
    const rightDoc = mode === "canon" ? toDriftCanon(b) : sortKeysDeep(b);
    const leftText = `${JSON.stringify(leftDoc, null, 2)}\n`;
    const rightText = `${JSON.stringify(rightDoc, null, 2)}\n`;
    const d = unifyDiff(
      `${leftLabel}/${typeName}.json`,
      leftText,
      `${rightLabel}/${typeName}.json`,
      rightText,
    );
    if (d) diffs.push(d);
  }
  return diffs;
}

export function checkSchemaDrift({
  tsCommitted = TS_COMMITTED,
  pyCommitted = PY_COMMITTED,
  exportFn = exportBothTo,
} = {}) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "sutra-schema-drift-"));
  /** @type {string[]} */
  const failures = [];

  try {
    emit({ event: "schema.drift", outcome: "start", tempRoot });
    const { zodOut, pyOut } = exportFn(tempRoot);

    const zodFresh = loadWireSchemas(zodOut);
    const pyFresh = loadWireSchemas(pyOut);
    const zodCommitted = loadWireSchemas(tsCommitted);
    const pyCommittedSchemas = loadWireSchemas(pyCommitted);

    const staleTs = diffSchemaMaps(
      zodCommitted,
      zodFresh,
      "exact",
      "committed:sync-protocol/schemas",
      "regenerated:zod",
    );
    if (staleTs.length) {
      failures.push(
        "STALE Zod schemas — committed packages/sync-protocol/schemas differs from exporter output.\n" +
          "Run: pnpm --filter @moolam/sync-protocol schemas:export\n\n" +
          staleTs.join("\n\n"),
      );
    }

    const stalePy = diffSchemaMaps(
      pyCommittedSchemas,
      pyFresh,
      "exact",
      "committed:cloud-orchestrator/schemas",
      "regenerated:pydantic",
    );
    if (stalePy.length) {
      failures.push(
        "STALE Pydantic schemas — committed packages/cloud-orchestrator/schemas differs from exporter output.\n" +
          "Run: pnpm --filter @moolam/cloud-orchestrator schemas:export\n\n" +
          stalePy.join("\n\n"),
      );
    }

    const cross = diffSchemaMaps(
      zodFresh,
      pyFresh,
      "canon",
      "regenerated:zod",
      "regenerated:pydantic",
    );
    if (cross.length) {
      failures.push(
        "CROSS-LANGUAGE DRIFT — Zod and Pydantic exports disagree after shared drift-canon.\n\n" +
          cross.join("\n\n"),
      );
    }

    if (failures.length) {
      emit({
        event: "schema.drift",
        outcome: "error",
        code: "SCHEMA_DRIFT_MISMATCH",
        failureCount: failures.length,
      });
      return { ok: false, failures, tempRoot };
    }

    emit({
      event: "schema.drift",
      outcome: "ok",
      types: WIRE_TYPES.length,
    });
    return { ok: true, failures: [], tempRoot };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({
      event: "schema.drift",
      outcome: "error",
      code: err?.code ?? "SCHEMA_DRIFT_FAILED",
      message,
    });
    return { ok: false, failures: [message], tempRoot };
  } finally {
    // Keep temp on failure for local debug when SCHEMA_DRIFT_KEEP_TEMP=1
    if (process.env.SCHEMA_DRIFT_KEEP_TEMP !== "1") {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const result = checkSchemaDrift();
  if (!result.ok) {
    for (const block of result.failures) {
      console.error("\n======== SCHEMA DRIFT ========\n");
      console.error(block);
    }
    process.exitCode = 1;
  }
}
