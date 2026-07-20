/**
 * Seed-violation proof for docs-site scaffold + TypeDoc API gate.
 *
 * Usage:
 *   node scripts/prove-docs-site-gate.mjs
 *   pnpm docs-site:prove
 */

import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  runDocsSiteCheck,
  validateDocsSiteScaffold,
} from "./check-docs-site.mjs";
import { syncDocsContent } from "../docs-site/scripts/sync-content.mjs";
import {
  OBLIGATIONS as API_OBLIGATIONS,
  validateDeclarations,
} from "../docs-site/scripts/generate-api.mjs";

export function runDocsSiteProve() {
  const lines = [];

  // Red: missing OWNERSHIP.md.
  const scratch = mkdtempSync(path.join(tmpdir(), "sutra-docs-site-prove-"));
  try {
    mkdirSync(path.join(scratch, ".vitepress"), { recursive: true });
    writeFileSync(path.join(scratch, "index.md"), "# x\n");
    writeFileSync(path.join(scratch, ".vitepress", "config.mts"), "export default {}\n");
    const redOwn = validateDocsSiteScaffold({ siteRoot: scratch });
    if (redOwn.status === 0) {
      return {
        status: 1,
        combined: "DOCS_SITE_PROVE_FAILED: missing OWNERSHIP expected red",
      };
    }
    if (
      !redOwn.violations.some((v) => v.obligation === OBLIGATIONS.OWNERSHIP_MISSING)
    ) {
      return {
        status: 1,
        combined: "DOCS_SITE_PROVE_FAILED: expected ownership_missing obligation",
      };
    }
    lines.push("red:ownership-missing");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Red: missing source docs path during sync.
  const docsScratch = mkdtempSync(path.join(tmpdir(), "sutra-docs-sync-prove-"));
  const refScratch = mkdtempSync(path.join(tmpdir(), "sutra-docs-ref-prove-"));
  try {
    mkdirSync(docsScratch, { recursive: true });
    const redSync = syncDocsContent({
      docsRoot: docsScratch,
      referenceRoot: refScratch,
      syncMap: [
        {
          id: "overview",
          source: "OVERVIEW.md",
          dest: "overview.md",
          kind: "file",
        },
      ],
      emitEvents: false,
    });
    if (redSync.status === 0) {
      return {
        status: 1,
        combined: "DOCS_SITE_PROVE_FAILED: missing OVERVIEW source expected red",
      };
    }
    if (!String(redSync.combined).includes("missing source")) {
      return {
        status: 1,
        combined: `DOCS_SITE_PROVE_FAILED: sync must print missing source:\n${redSync.combined}`,
      };
    }
    lines.push("red:source-missing");
  } finally {
    rmSync(docsScratch, { recursive: true, force: true });
    rmSync(refScratch, { recursive: true, force: true });
  }

  // Red: API packages missing dist declarations.
  const emptyRepo = mkdtempSync(path.join(tmpdir(), "sutra-docs-api-dist-"));
  try {
    mkdirSync(path.join(emptyRepo, "packages", "sdk"), { recursive: true });
    const redDist = validateDeclarations({
      repoRoot: emptyRepo,
      packages: ["sdk"],
      skipStale: true,
    });
    if (redDist.status === 0) {
      return {
        status: 1,
        combined: "DOCS_SITE_PROVE_FAILED: missing dist expected red",
      };
    }
    if (
      !redDist.violations.some((v) => v.obligation === API_OBLIGATIONS.DIST_MISSING)
    ) {
      return {
        status: 1,
        combined: "DOCS_SITE_PROVE_FAILED: expected dist_missing obligation",
      };
    }
    lines.push("red:dist-missing");
  } finally {
    rmSync(emptyRepo, { recursive: true, force: true });
  }

  // Red: stale declarations (src newer than dist).
  const staleRepo = mkdtempSync(path.join(tmpdir(), "sutra-docs-api-stale-"));
  try {
    const pkg = path.join(staleRepo, "packages", "sdk");
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    mkdirSync(path.join(pkg, "src"), { recursive: true });
    const distPath = path.join(pkg, "dist", "index.d.ts");
    writeFileSync(distPath, "export declare const x: number;\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(distPath, old, old);
    writeFileSync(path.join(pkg, "src", "index.ts"), "export const x = 1;\n");
    const redStale = validateDeclarations({
      repoRoot: staleRepo,
      packages: ["sdk"],
    });
    if (redStale.status === 0) {
      return {
        status: 1,
        combined: "DOCS_SITE_PROVE_FAILED: stale declarations expected red",
      };
    }
    if (
      !redStale.violations.some(
        (v) => v.obligation === API_OBLIGATIONS.STALE_DECLARATIONS,
      )
    ) {
      return {
        status: 1,
        combined: "DOCS_SITE_PROVE_FAILED: expected stale_declarations obligation",
      };
    }
    lines.push("red:stale-declarations");
  } finally {
    rmSync(staleRepo, { recursive: true, force: true });
  }

  // Green: full check (sync + api + build).
  const green = runDocsSiteCheck({ emitEvents: false });
  if (green.status !== 0) {
    return {
      status: 1,
      combined: `DOCS_SITE_PROVE_FAILED: baseline must pass:\n${green.combined}`,
    };
  }
  lines.push("green:baseline");

  return {
    status: 0,
    combined: `OK: docs-site prove red→green (${lines.join(", ")})`,
  };
}

function main() {
  const result = runDocsSiteProve();
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
