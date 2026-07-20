/**
 * Version lockstep CI gate.
 *
 * Validates wire PROTOCOL_VERSION across TypeScript and Python, then published
 * distribution semver across npm lockstep packages, PyPI pyproject, and __version__.
 *
 * Usage (repo root):
 *   node scripts/check-version-lockstep.mjs
 *   pnpm version:lockstep
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadChangesetConfig,
  packageDirForName,
} from "./check-changeset-config.mjs";
import {
  DISTRIBUTION_TRUTH_SOURCES,
  PROTOCOL_TRUTH_SOURCES,
  VERSION_TRUTH_SOURCES,
  readLiveVersionValues,
} from "./check-version-lockstep-doc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const OBLIGATIONS = Object.freeze({
  SOURCE_MISSING: "version.lockstep.source_missing",
  VERSION_MISMATCH: "version.lockstep.version_mismatch",
  NPM_LOCKSTEP_MISMATCH: "version.lockstep.npm_fixed_group_mismatch",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "version.lockstep.gate", ...event })}\n`,
  );
}

export function collectVersionLockstepSnapshot(sources = VERSION_TRUTH_SOURCES, opts = {}) {
  const entries = [];
  const values = opts.liveValues ?? readLiveVersionValues(sources);

  for (const source of sources) {
    const value = values[source.id] ?? "";
    entries.push({
      id: source.id,
      path: source.docPath,
      value,
    });
  }

  return { entries, values };
}

export function collectNpmFixedGroupVersions(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const config = opts.config ?? loadChangesetConfig(opts.configPath);
  const fixed = Array.isArray(config.fixed) ? config.fixed.flat() : [];
  const entries = [];

  for (const name of fixed) {
    const pkgPath = path.join(packageDirForName(name, repoRoot), "package.json");
    const relPath = path.relative(repoRoot, pkgPath).replaceAll("\\", "/");
    let version = "";
    try {
      version = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "";
    } catch {
      version = "";
    }
    entries.push({ name, path: relPath, version });
  }

  return entries;
}

export function validateVersionLockstep(snapshot, opts = {}) {
  const violations = [];
  const entries = snapshot.entries ?? [];
  const nonempty = entries.filter((entry) => entry.value);

  if (nonempty.length !== entries.length) {
    for (const entry of entries) {
      if (!entry.value) {
        violations.push({
          obligation: OBLIGATIONS.SOURCE_MISSING,
          path: entry.path,
          detail: `could not read semver from ${entry.path}`,
        });
      }
    }
    return { status: 1, violations, canonical: "" };
  }

  const canonical = nonempty[0].value;
  const mismatched = nonempty.filter((entry) => entry.value !== canonical);
  if (mismatched.length > 0) {
    for (const entry of mismatched) {
      violations.push({
        obligation: OBLIGATIONS.VERSION_MISMATCH,
        path: entry.path,
        detail: `${entry.path} has "${entry.value}" (expected "${canonical}")`,
      });
    }
    const groupLabel = opts.groupLabel ?? "lockstep";
    return {
      status: 1,
      violations,
      canonical,
      diff: formatUnifiedDiff(entries, canonical, groupLabel),
    };
  }

  return { status: 0, violations: [], canonical };
}

export function validateNpmFixedGroupLockstep(distributionCanonical, opts = {}) {
  const violations = [];
  const npmEntries = collectNpmFixedGroupVersions(opts);
  const mismatched = npmEntries.filter((entry) => entry.version !== distributionCanonical);

  for (const entry of npmEntries) {
    if (!entry.version) {
      violations.push({
        obligation: OBLIGATIONS.SOURCE_MISSING,
        path: entry.path,
        detail: `could not read semver from ${entry.path}`,
      });
    }
  }

  for (const entry of mismatched) {
    if (!entry.version) continue;
    violations.push({
      obligation: OBLIGATIONS.NPM_LOCKSTEP_MISMATCH,
      path: entry.path,
      detail: `${entry.name} is "${entry.version}" (expected npm/PyPI distribution "${distributionCanonical}")`,
    });
  }

  if (violations.length > 0) {
    return { status: 1, violations };
  }
  return { status: 0, violations: [] };
}

export function formatUnifiedDiff(entries, canonical, groupLabel = "canonical") {
  const lines = [
    `Version lockstep mismatch (${groupLabel}) — sources must share one semver:`,
    "",
    ...entries.map((entry) => {
      const marker = entry.value === canonical ? " " : "!";
      return `${marker} ${entry.path}: ${entry.value}`;
    }),
    "",
    `--- lockstep/${groupLabel}`,
    `+++ ${canonical}`,
    "@@ version truth sources @@",
  ];

  for (const entry of entries) {
    if (entry.value === canonical) {
      lines.push(` ${entry.path}: ${entry.value}`);
    } else {
      lines.push(`-${entry.path}: ${entry.value}`);
      lines.push(`+${entry.path}: ${canonical}`);
    }
  }

  return lines.join("\n");
}

export function runVersionLockstepGate(opts = {}) {
  const subjectId = opts.subjectId ?? "version-lockstep";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const liveValues = opts.liveValues ?? readLiveVersionValues();

  const protocolSnapshot = collectVersionLockstepSnapshot(PROTOCOL_TRUTH_SOURCES, {
    liveValues,
  });
  const distributionSnapshot = collectVersionLockstepSnapshot(DISTRIBUTION_TRUTH_SOURCES, {
    liveValues,
  });

  const protocolResult = validateVersionLockstep(protocolSnapshot, { groupLabel: "protocol" });
  const distributionResult = validateVersionLockstep(distributionSnapshot, {
    groupLabel: "distribution",
  });
  const npmResult =
    distributionResult.status === 0
      ? validateNpmFixedGroupLockstep(distributionResult.canonical, opts)
      : { status: 0, violations: [] };

  const violations = [
    ...protocolResult.violations,
    ...distributionResult.violations,
    ...npmResult.violations,
  ];
  const diffs = [protocolResult.diff, distributionResult.diff].filter(Boolean);
  const status = violations.length > 0 ? 1 : 0;
  const canonical = distributionResult.canonical || protocolResult.canonical;

  if (status !== 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "compare",
        violationCount: violations.length,
        canonical: canonical || undefined,
      });
    }
    return {
      status: 1,
      phase: "compare",
      violations,
      diff: diffs.join("\n\n"),
      combined: formatCombined({ violations, diff: diffs.join("\n\n") }),
      canonical,
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "compare",
      canonical,
      sourceCount: protocolSnapshot.entries.length + distributionSnapshot.entries.length,
    });
  }

  const sourceCount = protocolSnapshot.entries.length + distributionSnapshot.entries.length;
  return {
    status: 0,
    phase: "compare",
    canonical,
    combined: `OK: version lockstep satisfied (protocol ${liveValues.protocol_ts}, distribution ${canonical} across ${sourceCount} sources + npm fixed group)`,
  };
}

function formatCombined(result) {
  const header = `VERSION_LOCKSTEP_FAILED (${result.violations.length} violation(s)):\n${result.violations
    .map((v) => `[${v.obligation}] ${v.detail}`)
    .join("\n")}`;
  if (result.diff) {
    return `${header}\n\n${result.diff}`;
  }
  return header;
}

function main() {
  const result = runVersionLockstepGate();
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
