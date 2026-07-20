/**
 * Version lockstep policy document gate.
 *
 * Validates docs/protocol/VERSION-LOCKSTEP.md structure, required paths,
 * and that documented examples match live version truth sources.
 *
 * Usage (repo root):
 *   node scripts/check-version-lockstep-doc.mjs
 *   pnpm version:lockstep:doc
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const DOC_PATH = path.join(REPO_ROOT, "docs", "protocol", "VERSION-LOCKSTEP.md");

export const OBLIGATIONS = Object.freeze({
  DOC_MISSING: "version.lockstep.doc.missing",
  SECTION_MISSING: "version.lockstep.doc.section_missing",
  PATH_MISSING: "version.lockstep.doc.path_missing",
  EXAMPLE_DRIFT: "version.lockstep.doc.example_drift",
  README_LINK_MISSING: "version.lockstep.doc.readme_link_missing",
});

export const PROTOCOL_TRUTH_SOURCES = Object.freeze([
  {
    id: "protocol_ts",
    docPath: "packages/sync-protocol/src/contract.ts",
    absPath: path.join(REPO_ROOT, "packages/sync-protocol/src/contract.ts"),
    read(text) {
      const match = text.match(/export const PROTOCOL_VERSION = "([^"]+)"/);
      return match?.[1] ?? "";
    },
  },
  {
    id: "orchestrator_init_protocol",
    docPath: "packages/cloud-orchestrator/src/sutra_orchestrator/__init__.py",
    absPath: path.join(
      REPO_ROOT,
      "packages/cloud-orchestrator/src/sutra_orchestrator/__init__.py",
    ),
    read(text) {
      const match = text.match(/^PROTOCOL_VERSION\s*=\s*"([^"]+)"/m);
      return match?.[1] ?? "";
    },
  },
]);

/** Published package semver (npm lockstep group + PyPI sutra-sdk). */
export const DISTRIBUTION_TRUTH_SOURCES = Object.freeze([
  {
    id: "sdk_npm",
    docPath: "packages/sdk/package.json",
    absPath: path.join(REPO_ROOT, "packages/sdk/package.json"),
    read(text) {
      return JSON.parse(text).version ?? "";
    },
  },
  {
    id: "sync_protocol_npm",
    docPath: "packages/sync-protocol/package.json",
    absPath: path.join(REPO_ROOT, "packages/sync-protocol/package.json"),
    read(text) {
      return JSON.parse(text).version ?? "";
    },
  },
  {
    id: "orchestrator_pyproject",
    docPath: "packages/cloud-orchestrator/pyproject.toml",
    absPath: path.join(REPO_ROOT, "packages/cloud-orchestrator/pyproject.toml"),
    read(text) {
      const match = text.match(/^version\s*=\s*"([^"]+)"/m);
      return match?.[1] ?? "";
    },
  },
  {
    id: "orchestrator_init_version",
    docPath: "packages/cloud-orchestrator/src/sutra_orchestrator/__init__.py",
    absPath: path.join(
      REPO_ROOT,
      "packages/cloud-orchestrator/src/sutra_orchestrator/__init__.py",
    ),
    read(text) {
      const match = text.match(/^__version__\s*=\s*"([^"]+)"/m);
      return match?.[1] ?? "";
    },
  },
]);

export const VERSION_TRUTH_SOURCES = Object.freeze([
  ...PROTOCOL_TRUTH_SOURCES,
  ...DISTRIBUTION_TRUTH_SOURCES,
]);

export const REQUIRED_SECTIONS = Object.freeze([
  "## Lockstep invariant",
  "## Version truth sources",
  "## Bump mechanics at release",
  "## Worked example",
]);

export const README_LINK_TARGETS = Object.freeze([
  path.join(REPO_ROOT, "docs/protocol/README.md"),
  path.join(REPO_ROOT, "packages/sync-protocol/README.md"),
  path.join(REPO_ROOT, "packages/cloud-orchestrator/README.md"),
]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "version.lockstep.doc.gate", ...event })}\n`,
  );
}

export function loadVersionLockstepDoc(docPath = DOC_PATH) {
  if (!existsSync(docPath)) {
    throw new Error(`DOC_MISSING:${docPath}`);
  }
  return readFileSync(docPath, "utf8");
}

export function readLiveVersionValues(sources = VERSION_TRUTH_SOURCES) {
  const values = {};
  for (const source of sources) {
    const text = readFileSync(source.absPath, "utf8");
    values[source.id] = source.read(text);
  }
  return values;
}

export function validateVersionLockstepDoc(docText, opts = {}) {
  const violations = [];
  const sources = opts.sources ?? VERSION_TRUTH_SOURCES;
  const liveValues = opts.liveValues ?? readLiveVersionValues(sources);

  if (!docText?.trim()) {
    violations.push({
      obligation: OBLIGATIONS.DOC_MISSING,
      detail: "VERSION-LOCKSTEP.md is empty",
    });
    return { status: 1, violations, liveValues };
  }

  for (const heading of REQUIRED_SECTIONS) {
    if (!docText.includes(heading)) {
      violations.push({
        obligation: OBLIGATIONS.SECTION_MISSING,
        detail: `missing section: ${heading}`,
      });
    }
  }

  for (const source of sources) {
    if (!docText.includes(source.docPath)) {
      violations.push({
        obligation: OBLIGATIONS.PATH_MISSING,
        detail: `document must reference ${source.docPath}`,
      });
    }
    if (!existsSync(source.absPath)) {
      violations.push({
        obligation: OBLIGATIONS.PATH_MISSING,
        detail: `version truth file missing: ${source.docPath}`,
      });
    }
  }

  for (const source of sources) {
    const live = liveValues[source.id];
    if (!live) {
      violations.push({
        obligation: OBLIGATIONS.EXAMPLE_DRIFT,
        detail: `could not read live version from ${source.docPath}`,
      });
      continue;
    }
    if (!docText.includes(live)) {
      violations.push({
        obligation: OBLIGATIONS.EXAMPLE_DRIFT,
        detail: `document must cite current value "${live}" for ${source.docPath}`,
      });
    }
  }

  if (opts.checkReadmeLinks !== false) {
    for (const readmePath of README_LINK_TARGETS) {
      const readmeText = readFileSync(readmePath, "utf8");
      if (!readmeText.includes("VERSION-LOCKSTEP.md")) {
        violations.push({
          obligation: OBLIGATIONS.README_LINK_MISSING,
          detail: `${path.relative(REPO_ROOT, readmePath)} must link to VERSION-LOCKSTEP.md`,
        });
      }
    }
  }

  return {
    status: violations.length === 0 ? 0 : 1,
    violations,
    liveValues,
  };
}

export function runVersionLockstepDocGate(opts = {}) {
  const subjectId = opts.subjectId ?? "version-lockstep-doc";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;

  let docText;
  try {
    docText = opts.docText ?? loadVersionLockstepDoc(opts.docPath);
  } catch (err) {
    const violation = {
      obligation: OBLIGATIONS.DOC_MISSING,
      detail: String(err),
    };
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "load",
      });
    }
    return {
      status: 1,
      phase: "load",
      violations: [violation],
      combined: `VERSION_LOCKSTEP_DOC_FAILED: [${violation.obligation}] ${violation.detail}`,
    };
  }

  const result = validateVersionLockstepDoc(docText, opts);
  if (result.status !== 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "validate",
        violationCount: result.violations.length,
      });
    }
    return {
      status: 1,
      phase: "validate",
      violations: result.violations,
      liveValues: result.liveValues,
      combined: formatViolations(result.violations),
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "validate",
      sourceCount: VERSION_TRUTH_SOURCES.length,
    });
  }

  return {
    status: 0,
    phase: "validate",
    liveValues: result.liveValues,
    combined: "OK: VERSION-LOCKSTEP.md matches live version truth sources",
  };
}

function formatViolations(violations) {
  return `VERSION_LOCKSTEP_DOC_FAILED (${violations.length} violation(s)):\n${violations
    .map((v) => `[${v.obligation}] ${v.detail}`)
    .join("\n")}`;
}

function main() {
  const result = runVersionLockstepDocGate();
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
