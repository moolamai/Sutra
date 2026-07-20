/**
 * Sync curated docs/ paths into docs-site/reference/.
 *
 * Ownership: docs/ is canonical; reference/ is generated — never hand-edit.
 *
 * Usage (docs-site or repo root via pnpm docs-site:sync):
 *   node scripts/sync-content.mjs
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DOCS_SITE_ROOT = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(DOCS_SITE_ROOT, "..");
export const DOCS_ROOT = path.join(REPO_ROOT, "docs");
export const REFERENCE_ROOT = path.join(DOCS_SITE_ROOT, "reference");

/** Curated sync map — keep in lockstep with OWNERSHIP.md. */
export const SYNC_MAP = Object.freeze([
  {
    id: "overview",
    source: "OVERVIEW.md",
    dest: "overview.md",
    kind: "file",
  },
  {
    id: "architecture",
    source: "architecture",
    dest: "architecture",
    kind: "dir",
  },
  {
    id: "protocol",
    source: "protocol",
    dest: "protocol",
    kind: "dir",
  },
  {
    id: "sdk",
    source: "sdk",
    dest: "sdk",
    kind: "dir",
  },
]);

export const OBLIGATIONS = Object.freeze({
  SOURCE_MISSING: "docs_site.sync.source_missing",
  DEST_WRITE_FAILED: "docs_site.sync.dest_write_failed",
  BOUNDED_SCAN: "docs_site.sync.bounded_scan",
});

/** Bound directory walk (NFR — no unbounded scans). */
export const SYNC_SCAN_LIMIT = 512;

/** Never mirror dependency trees or VCS metadata into the public site. */
export const SYNC_SKIP_DIR_NAMES = Object.freeze([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  ".turbo",
  "dist",
]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "docs_site.sync", ...event })}\n`,
  );
}

function shouldSkipDir(name) {
  return SYNC_SKIP_DIR_NAMES.includes(name);
}

function countFiles(dir, limit, acc = { count: 0 }) {
  if (acc.count >= limit) return acc;
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (acc.count >= limit) return acc;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (shouldSkipDir(name)) continue;
      countFiles(full, limit, acc);
    } else {
      acc.count += 1;
    }
  }
  return acc;
}

function syncFilter(src) {
  const base = path.basename(src);
  if (shouldSkipDir(base)) return false;
  return true;
}

/**
 * Rewrite repo-relative markdown links that break after the OVERVIEW copy
 * lands under reference/ (best-effort; ownership stays on docs/).
 */
export function rewriteOverviewLinks(markdown) {
  return markdown
    .replace(/\]\(\.\.\/domains\//g, "](https://github.com/moolamai/sutra/tree/main/domains/")
    .replace(/\]\(domains\//g, "](https://github.com/moolamai/sutra/tree/main/docs/domains/");
}

export function syncDocsContent(opts = {}) {
  const subjectId = opts.subjectId ?? "docs-site-sync";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const docsRoot = opts.docsRoot ?? DOCS_ROOT;
  const referenceRoot = opts.referenceRoot ?? REFERENCE_ROOT;
  const map = opts.syncMap ?? SYNC_MAP;

  const copied = [];
  const violations = [];

  if (existsSync(referenceRoot)) {
    rmSync(referenceRoot, { recursive: true, force: true });
  }
  mkdirSync(referenceRoot, { recursive: true });

  for (const entry of map) {
    const src = path.join(docsRoot, entry.source);
    const dest = path.join(referenceRoot, entry.dest);

    if (!existsSync(src)) {
      violations.push({
        obligation: OBLIGATIONS.SOURCE_MISSING,
        detail: `missing source: docs/${entry.source}`,
      });
      continue;
    }

    try {
      if (entry.kind === "file") {
        mkdirSync(path.dirname(dest), { recursive: true });
        let text = readFileSync(src, "utf8");
        if (entry.id === "overview") {
          text = rewriteOverviewLinks(text);
        }
        writeFileSync(dest, text);
        copied.push(entry.id);
      } else {
        const scanned = countFiles(src, SYNC_SCAN_LIMIT);
        if (scanned.count >= SYNC_SCAN_LIMIT) {
          violations.push({
            obligation: OBLIGATIONS.BOUNDED_SCAN,
            detail: `source docs/${entry.source} exceeds scan limit ${SYNC_SCAN_LIMIT}`,
          });
          continue;
        }
        cpSync(src, dest, { recursive: true, filter: syncFilter });
        // Public SVG diagrams live under docs/assets (TikZ sources stay gitignored).
        const archDiagramsSrc = path.join(
          docsRoot,
          "assets",
          "diagrams",
          "svg",
        );
        const archDiagramsDest = path.join(dest, "diagrams", "svg");
        if (existsSync(archDiagramsSrc)) {
          mkdirSync(path.dirname(archDiagramsDest), { recursive: true });
          cpSync(archDiagramsSrc, archDiagramsDest, { recursive: true });
        }
        // VitePress expects directory indexes as index.md
        const readme = path.join(dest, "README.md");
        const index = path.join(dest, "index.md");
        if (existsSync(readme) && !existsSync(index)) {
          cpSync(readme, index);
        }
        copied.push(entry.id);
      }
    } catch (err) {
      violations.push({
        obligation: OBLIGATIONS.DEST_WRITE_FAILED,
        detail: `${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Marker so ownership is visible inside the generated tree.
  writeFileSync(
    path.join(referenceRoot, ".generated"),
    [
      "# GENERATED — do not hand-edit",
      `# source: ${path.relative(REPO_ROOT, docsRoot).replace(/\\/g, "/")}`,
      `# map: ${map.map((m) => m.id).join(",")}`,
      "",
    ].join("\n"),
  );

  if (violations.length > 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "sync",
        violationCount: violations.length,
      });
    }
    return {
      status: 1,
      violations,
      copied,
      combined: violations.map((v) => `[${v.obligation}] ${v.detail}`).join("\n"),
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "sync",
      copiedCount: copied.length,
      copied,
    });
  }

  return {
    status: 0,
    violations: [],
    copied,
    combined: `OK: synced ${copied.length} doc group(s) into docs-site/reference/`,
  };
}

function main() {
  const result = syncDocsContent();
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
