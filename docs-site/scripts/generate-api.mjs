/**
 * Generate API reference markdown from package dist declarations via TypeDoc.
 *
 * Ownership: never hand-edit docs-site/api/ — regenerate from declarations.
 *
 * Usage:
 *   node scripts/generate-api.mjs
 *   pnpm docs:api
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DOCS_SITE_ROOT = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(DOCS_SITE_ROOT, "..");
export const API_ROOT = path.join(DOCS_SITE_ROOT, "api");
export const TYPEDOC_CONFIG = path.join(DOCS_SITE_ROOT, "typedoc.json");

/** SDK barrel + packages it re-exports (public surface). */
export const API_PACKAGES = Object.freeze([
  "sdk",
  "contracts",
  "cognitive-core",
  "runtime",
  "telemetry",
  "sync-protocol",
  "edge-agent",
]);

/** Bound src walk when checking declaration freshness (NFR). */
export const DECL_SCAN_LIMIT = 4096;

export const OBLIGATIONS = Object.freeze({
  DIST_MISSING: "docs_site.api.dist_missing",
  STALE_DECLARATIONS: "docs_site.api.stale_declarations",
  TYPEDOC_FAILED: "docs_site.api.typedoc_failed",
  OUTPUT_EMPTY: "docs_site.api.output_empty",
  FINGERPRINT_MISMATCH: "docs_site.api.fingerprint_mismatch",
  BOUNDED_SCAN: "docs_site.api.bounded_scan",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "docs_site.api", ...event })}\n`,
  );
}

function packageRoot(name) {
  return path.join(REPO_ROOT, "packages", name);
}

function distEntry(name) {
  return path.join(packageRoot(name), "dist", "index.d.ts");
}

function countTsSources(dir, limit, acc = { count: 0, newest: 0 }) {
  if (acc.count >= limit) return acc;
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (acc.count >= limit) return acc;
    if (name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      countTsSources(full, limit, acc);
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) {
      acc.count += 1;
      if (st.mtimeMs > acc.newest) acc.newest = st.mtimeMs;
    }
  }
  return acc;
}

/**
 * Validate that required dist declarations exist and are not older than sources.
 */
export function validateDeclarations(opts = {}) {
  const packages = opts.packages ?? API_PACKAGES;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const skipStale = opts.skipStale === true;
  const violations = [];
  const entries = [];

  for (const name of packages) {
    const root = path.join(repoRoot, "packages", name);
    const dts = path.join(root, "dist", "index.d.ts");
    if (!existsSync(dts)) {
      violations.push({
        obligation: OBLIGATIONS.DIST_MISSING,
        detail: `missing packages/${name}/dist/index.d.ts — run pnpm --filter @moolam/${name}... build`,
      });
      continue;
    }
    entries.push({ name, dts });

    if (!skipStale) {
      const srcRoot = path.join(root, "src");
      const scanned = countTsSources(srcRoot, DECL_SCAN_LIMIT);
      if (scanned.count >= DECL_SCAN_LIMIT) {
        violations.push({
          obligation: OBLIGATIONS.BOUNDED_SCAN,
          detail: `packages/${name}/src exceeds scan limit ${DECL_SCAN_LIMIT}`,
        });
        continue;
      }
      const distMtime = statSync(dts).mtimeMs;
      if (scanned.newest > distMtime + 1000) {
        violations.push({
          obligation: OBLIGATIONS.STALE_DECLARATIONS,
          detail: `packages/${name}/dist/index.d.ts is older than sources under src/ — rebuild before docs:build`,
        });
      }
    }
  }

  return {
    status: violations.length === 0 ? 0 : 1,
    violations,
    entries,
  };
}

export function fingerprintDeclarations(entries) {
  const hash = createHash("sha256");
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    hash.update(entry.name);
    hash.update("\0");
    hash.update(readFileSync(entry.dts));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function ensureApiIndex(apiRoot) {
  const readme = path.join(apiRoot, "README.md");
  const index = path.join(apiRoot, "index.md");
  if (existsSync(readme) && !existsSync(index)) {
    cpSync(readme, index);
  }
  if (!existsSync(index) && !existsSync(readme)) {
    // TypeDoc sometimes writes modules.md as the landing page.
    const modules = path.join(apiRoot, "modules.md");
    if (existsSync(modules)) {
      cpSync(modules, index);
    }
  }
}

/**
 * Run TypeDoc → docs-site/api/ from current dist declarations.
 */
export function generateApiReference(opts = {}) {
  const subjectId = opts.subjectId ?? "docs-site-api";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const apiRoot = opts.apiRoot ?? API_ROOT;
  const skipStale = opts.skipStale === true;

  const validated = validateDeclarations({
    packages: opts.packages,
    repoRoot: opts.repoRoot,
    skipStale,
  });
  if (validated.status !== 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "validate",
        violationCount: validated.violations.length,
      });
    }
    return {
      status: 1,
      phase: "validate",
      violations: validated.violations,
      combined: validated.violations
        .map((v) => `[${v.obligation}] ${v.detail}`)
        .join("\n"),
    };
  }

  const fingerprint = fingerprintDeclarations(validated.entries);

  if (existsSync(apiRoot)) {
    rmSync(apiRoot, { recursive: true, force: true });
  }
  mkdirSync(apiRoot, { recursive: true });

  const run = spawnSync("pnpm", ["exec", "typedoc", "--options", TYPEDOC_CONFIG, "--out", apiRoot], {
    cwd: DOCS_SITE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "production" },
  });

  if (run.status !== 0) {
    const detail = (run.stderr || run.stdout || "typedoc failed").trim();
    // Partial failure: wipe incomplete tree so we never ship half-written API.
    if (existsSync(apiRoot)) {
      rmSync(apiRoot, { recursive: true, force: true });
    }
    if (emitEvents) {
      emit({ outcome: "fail", subjectId, deviceId, phase: "typedoc" });
    }
    return {
      status: 1,
      phase: "typedoc",
      violations: [
        { obligation: OBLIGATIONS.TYPEDOC_FAILED, detail: detail.slice(0, 4000) },
      ],
      combined: `DOCS_SITE_API_FAILED (typedoc):\n${detail.slice(0, 4000)}`,
    };
  }

  ensureApiIndex(apiRoot);

  const hasMarkdown =
    existsSync(path.join(apiRoot, "index.md")) ||
    existsSync(path.join(apiRoot, "README.md")) ||
    existsSync(path.join(apiRoot, "modules.md"));
  if (!hasMarkdown) {
    if (emitEvents) {
      emit({ outcome: "fail", subjectId, deviceId, phase: "output" });
    }
    return {
      status: 1,
      phase: "output",
      violations: [
        {
          obligation: OBLIGATIONS.OUTPUT_EMPTY,
          detail: "TypeDoc produced no markdown landing page under docs-site/api/",
        },
      ],
      combined: "DOCS_SITE_API_FAILED (output): empty api tree",
    };
  }

  writeFileSync(
    path.join(apiRoot, ".generated"),
    [
      "# GENERATED — do not hand-edit",
      `# source: packages/{${API_PACKAGES.join(",")}}/dist/*.d.ts`,
      `# fingerprint: ${fingerprint}`,
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(apiRoot, ".fingerprint"), `${fingerprint}\n`);

  // Idempotency / freshness: regenerating from the same dist must match.
  const expected = fingerprintDeclarations(validated.entries);
  if (expected !== fingerprint) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "fingerprint",
      });
    }
    return {
      status: 1,
      phase: "fingerprint",
      violations: [
        {
          obligation: OBLIGATIONS.FINGERPRINT_MISMATCH,
          detail: "declaration fingerprint changed during generation",
        },
      ],
      combined: "DOCS_SITE_API_FAILED (fingerprint mismatch)",
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "typedoc",
      packageCount: validated.entries.length,
      fingerprint,
    });
  }

  return {
    status: 0,
    phase: "typedoc",
    fingerprint,
    packages: validated.entries.map((e) => e.name),
    combined: `OK: generated API reference for ${validated.entries.length} package(s)`,
  };
}

/**
 * Verify an existing api/.fingerprint still matches current dist (stale gate).
 */
export function verifyApiFingerprint(opts = {}) {
  const apiRoot = opts.apiRoot ?? API_ROOT;
  const fpPath = path.join(apiRoot, ".fingerprint");
  if (!existsSync(fpPath)) {
    return {
      status: 1,
      violations: [
        {
          obligation: OBLIGATIONS.OUTPUT_EMPTY,
          detail: "api/.fingerprint missing — run docs:api",
        },
      ],
      combined: "api fingerprint missing",
    };
  }
  const validated = validateDeclarations({
    packages: opts.packages,
    repoRoot: opts.repoRoot,
    skipStale: opts.skipStale === true,
  });
  if (validated.status !== 0) {
    return {
      status: 1,
      violations: validated.violations,
      combined: validated.violations
        .map((v) => `[${v.obligation}] ${v.detail}`)
        .join("\n"),
    };
  }
  const current = fingerprintDeclarations(validated.entries);
  const recorded = readFileSync(fpPath, "utf8").trim();
  if (current !== recorded) {
    return {
      status: 1,
      violations: [
        {
          obligation: OBLIGATIONS.FINGERPRINT_MISMATCH,
          detail:
            "api/.fingerprint does not match current dist/*.d.ts — regenerate with pnpm docs:api",
        },
      ],
      combined: "API reference is stale versus dist declarations",
    };
  }
  return { status: 0, violations: [], fingerprint: current };
}

function main() {
  const result = generateApiReference();
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
