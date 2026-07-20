/**
 * PROTOCOL_VERSION bump mechanics CI gate (deprecation-mechanics / A-G6).
 *
 * Any wire-visible change to committed sync-protocol schemas (vs the locked
 * wire-shape baseline) must bump PROTOCOL_VERSION and name the changed types
 * in packages/sync-protocol/CHANGELOG.md [Unreleased]. Failures always print
 * a unified diff of the offending type(s) — never a bare boolean.
 *
 * Usage (repo root):
 *   node scripts/check-protocol-version-bump.mjs
 *   node scripts/check-protocol-version-bump.mjs --record
 *   pnpm protocol:version-bump
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WIRE_TYPES, toDriftCanon } from "./check-schema-drift.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const CONTRACT_TS = path.join(
  REPO_ROOT,
  "packages/sync-protocol/src/contract.ts",
);
export const SCHEMAS_DIR = path.join(
  REPO_ROOT,
  "packages/sync-protocol/schemas",
);
export const BASELINE_PATH = path.join(SCHEMAS_DIR, "wire-shape-baseline.json");
export const CHANGELOG_PATH = path.join(
  REPO_ROOT,
  "packages/sync-protocol/CHANGELOG.md",
);

export const OBLIGATIONS = Object.freeze({
  BASELINE_MISSING: "protocol.version_bump.baseline_missing",
  CONTRACT_MISSING: "protocol.version_bump.contract_missing",
  SCHEMA_MISSING: "protocol.version_bump.schema_missing",
  VERSION_BUMP_REQUIRED: "protocol.version_bump.version_required",
  CHANGELOG_REQUIRED: "protocol.version_bump.changelog_required",
  BASELINE_STALE: "protocol.version_bump.baseline_stale",
  VERSION_WITHOUT_SHAPE: "protocol.version_bump.version_without_shape",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "protocol.version_bump.gate", ...event })}\n`,
  );
}

export function readProtocolVersion(contractPath = CONTRACT_TS) {
  if (!existsSync(contractPath)) {
    throw new Error(`CONTRACT_MISSING:${contractPath}`);
  }
  const text = readFileSync(contractPath, "utf8");
  const match = text.match(/export const PROTOCOL_VERSION = "([^"]+)"/);
  if (!match?.[1]) {
    throw new Error(`CONTRACT_MISSING:PROTOCOL_VERSION in ${contractPath}`);
  }
  return match[1];
}

export function hashCanon(doc) {
  const body = JSON.stringify(doc);
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Live wire-shape snapshot: PROTOCOL_VERSION + per-type drift-canon hashes.
 */
export function collectWireShapeSnapshot(opts = {}) {
  const schemasDir = opts.schemasDir ?? SCHEMAS_DIR;
  const contractPath = opts.contractPath ?? CONTRACT_TS;
  const wireTypes = opts.wireTypes ?? WIRE_TYPES;
  const protocolVersion =
    opts.protocolVersion ?? readProtocolVersion(contractPath);

  /** @type {Record<string, string>} */
  const types = {};
  /** @type {Record<string, object>} */
  const canons = {};

  for (const typeName of wireTypes) {
    const file = path.join(schemasDir, `${typeName}.json`);
    if (!existsSync(file)) {
      throw new Error(`SCHEMA_MISSING:${file}`);
    }
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const canon = toDriftCanon(raw);
    canons[typeName] = canon;
    types[typeName] = hashCanon(canon);
  }

  return { protocolVersion, types, canons };
}

export function loadBaseline(baselinePath = BASELINE_PATH) {
  if (!existsSync(baselinePath)) {
    return null;
  }
  return JSON.parse(readFileSync(baselinePath, "utf8"));
}

export function formatBaselineDocument(snapshot) {
  const types = {};
  for (const key of Object.keys(snapshot.types).sort()) {
    types[key] = snapshot.types[key];
  }
  return {
    protocolVersion: snapshot.protocolVersion,
    types,
  };
}

export function recordWireShapeBaseline(
  baselinePath = BASELINE_PATH,
  opts = {},
) {
  const snapshot = opts.snapshot ?? collectWireShapeSnapshot(opts);
  const doc = formatBaselineDocument(snapshot);
  mkdirSync(path.dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return doc;
}

export function parseUnreleasedSection(changelogText) {
  const section = changelogText
    .split(/^## \[Unreleased\]/m)[1]
    ?.split(/^## \[/m)[0];
  return section ?? "";
}

/**
 * Every changed wire type must appear by name in [Unreleased].
 */
export function changelogMentionsTypes(changelogText, typeNames) {
  const unreleased = parseUnreleasedSection(changelogText);
  /** @type {string[]} */
  const missing = [];
  for (const typeName of typeNames) {
    const named = new RegExp(`\\b${typeName}\\b`);
    if (!named.test(unreleased)) {
      missing.push(typeName);
    }
  }
  return { ok: missing.length === 0, missing, unreleased };
}

export function diffChangedTypes(baseline, snapshot) {
  /** @type {string[]} */
  const changed = [];
  const baselineTypes = baseline?.types ?? {};
  const liveTypes = snapshot.types ?? {};
  const names = new Set([...Object.keys(baselineTypes), ...Object.keys(liveTypes)]);
  for (const name of [...names].sort()) {
    if (baselineTypes[name] !== liveTypes[name]) {
      changed.push(name);
    }
  }
  return changed;
}

export function formatTypeDiff(typeName, baselineHash, liveHash, liveCanon) {
  const lines = [
    `--- baseline/${typeName} ${baselineHash ?? "(missing)"}`,
    `+++ live/${typeName} ${liveHash}`,
    "@@ wire shape (drift-canon hash) @@",
    `-${typeName}: ${baselineHash ?? "(missing)"}`,
    `+${typeName}: ${liveHash}`,
  ];
  if (liveCanon) {
    lines.push("@@ live drift-canon (truncated) @@");
    const pretty = JSON.stringify(liveCanon, null, 2).split("\n").slice(0, 40);
    for (const line of pretty) {
      lines.push(`+${line}`);
    }
    if (JSON.stringify(liveCanon, null, 2).split("\n").length > 40) {
      lines.push("+…");
    }
  }
  return lines.join("\n");
}

/**
 * Validate live snapshot against committed baseline + changelog.
 * @returns {{ status: number, violations: object[], diff?: string, changedTypes: string[], combined: string }}
 */
export function validateProtocolVersionBump(opts = {}) {
  const snapshot = opts.snapshot ?? collectWireShapeSnapshot(opts);
  const baseline = opts.baseline ?? loadBaseline(opts.baselinePath ?? BASELINE_PATH);
  const changelogText =
    opts.changelogText ??
    (existsSync(opts.changelogPath ?? CHANGELOG_PATH)
      ? readFileSync(opts.changelogPath ?? CHANGELOG_PATH, "utf8")
      : "");

  /** @type {{ obligation: string, detail: string, path?: string }[]} */
  const violations = [];

  if (!baseline) {
    violations.push({
      obligation: OBLIGATIONS.BASELINE_MISSING,
      detail: `missing wire-shape baseline at ${path.relative(REPO_ROOT, opts.baselinePath ?? BASELINE_PATH)} — run: node scripts/check-protocol-version-bump.mjs --record`,
      path: path.relative(REPO_ROOT, opts.baselinePath ?? BASELINE_PATH),
    });
    return finish(1, violations, [], "");
  }

  const changedTypes = diffChangedTypes(baseline, snapshot);
  const versionDrift = snapshot.protocolVersion !== baseline.protocolVersion;
  const baselineDoc = formatBaselineDocument(snapshot);
  const baselineMatches =
    baseline.protocolVersion === baselineDoc.protocolVersion &&
    JSON.stringify(baseline.types) === JSON.stringify(baselineDoc.types);

  if (changedTypes.length === 0 && !versionDrift && baselineMatches) {
    return finish(0, [], [], "");
  }

  if (changedTypes.length === 0 && versionDrift) {
    violations.push({
      obligation: OBLIGATIONS.VERSION_WITHOUT_SHAPE,
      detail: `PROTOCOL_VERSION moved ${baseline.protocolVersion} → ${snapshot.protocolVersion} without a wire-schema hash change — bump only with additive/breaking schema edits (see DEPRECATION-POLICY §3)`,
      path: "packages/sync-protocol/src/contract.ts",
    });
  }

  if (changedTypes.length > 0 && !versionDrift) {
    violations.push({
      obligation: OBLIGATIONS.VERSION_BUMP_REQUIRED,
      detail: `wire-visible change in ${changedTypes.join(", ")} without PROTOCOL_VERSION bump (still "${snapshot.protocolVersion}")`,
      path: "packages/sync-protocol/src/contract.ts",
    });
  }

  if (changedTypes.length > 0) {
    const mentions = changelogMentionsTypes(changelogText, changedTypes);
    if (!mentions.ok) {
      violations.push({
        obligation: OBLIGATIONS.CHANGELOG_REQUIRED,
        detail: `wire-visible change missing [Unreleased] changelog coverage for: ${mentions.missing.join(", ")}`,
        path: "packages/sync-protocol/CHANGELOG.md",
      });
    }
  }

  if (!baselineMatches && violations.length === 0) {
    // Shape + version + changelog OK, but baseline file not refreshed.
    violations.push({
      obligation: OBLIGATIONS.BASELINE_STALE,
      detail: `wire-shape baseline is stale after a logged bump — run: node scripts/check-protocol-version-bump.mjs --record`,
      path: path.relative(REPO_ROOT, opts.baselinePath ?? BASELINE_PATH),
    });
  }

  /** @type {string[]} */
  const diffParts = [];
  for (const typeName of changedTypes) {
    diffParts.push(
      formatTypeDiff(
        typeName,
        baseline.types?.[typeName],
        snapshot.types[typeName],
        snapshot.canons?.[typeName],
      ),
    );
  }
  if (versionDrift && changedTypes.length === 0) {
    const fake = [
      "--- baseline/PROTOCOL_VERSION",
      "+++ live/PROTOCOL_VERSION",
      `-${baseline.protocolVersion}`,
      `+${snapshot.protocolVersion}`,
    ].join("\n");
    diffParts.push(fake);
  }

  const diff = diffParts.join("\n\n");
  return finish(violations.length ? 1 : 0, violations, changedTypes, diff);
}

function finish(status, violations, changedTypes, diff) {
  const header =
    status === 0
      ? "OK: PROTOCOL_VERSION bump gate satisfied"
      : `PROTOCOL_VERSION_BUMP_FAILED (${violations.length} violation(s)):\n${violations
          .map((v) => `[${v.obligation}] ${v.detail}`)
          .join("\n")}`;
  const combined = diff ? `${header}\n\n${diff}` : header;
  return { status, violations, changedTypes, diff, combined };
}

export function runProtocolVersionBumpGate(opts = {}) {
  const subjectId = opts.subjectId ?? "protocol-version-bump";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;

  let result;
  try {
    result = validateProtocolVersionBump(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const obligation = message.startsWith("SCHEMA_MISSING")
      ? OBLIGATIONS.SCHEMA_MISSING
      : message.startsWith("CONTRACT_MISSING")
        ? OBLIGATIONS.CONTRACT_MISSING
        : OBLIGATIONS.BASELINE_MISSING;
    result = {
      status: 1,
      violations: [{ obligation, detail: message }],
      changedTypes: [],
      diff: "",
      combined: `PROTOCOL_VERSION_BUMP_FAILED: ${message}`,
    };
  }

  if (emitEvents) {
    emit({
      outcome: result.status === 0 ? "ok" : "fail",
      subjectId,
      deviceId,
      violationCount: result.violations.length,
      changedTypeCount: result.changedTypes.length,
      protocolVersion: opts.snapshot?.protocolVersion,
    });
  }

  return result;
}

function main() {
  const record = process.argv.includes("--record");
  if (record) {
    const doc = recordWireShapeBaseline();
    process.stdout.write(
      `${JSON.stringify({
        event: "protocol.version_bump.record",
        outcome: "ok",
        protocolVersion: doc.protocolVersion,
        typeCount: Object.keys(doc.types).length,
        path: path.relative(REPO_ROOT, BASELINE_PATH).replace(/\\/g, "/"),
      })}\n`,
    );
    process.exit(0);
  }

  const result = runProtocolVersionBumpGate();
  if (result.status !== 0) {
    process.stderr.write(`${result.combined}\n`);
    process.exit(result.status);
  }
  process.stdout.write(`${result.combined}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
