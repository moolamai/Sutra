/**
 * Docs-site scaffold gate: ownership + sync + VitePress build.
 *
 * Usage (repo root):
 *   node scripts/check-docs-site.mjs
 *   pnpm docs-site:check
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCS_SITE_ROOT,
  REFERENCE_ROOT,
  SYNC_MAP,
  syncDocsContent,
} from "../docs-site/scripts/sync-content.mjs";
import { generateApiReference } from "../docs-site/scripts/generate-api.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const OBLIGATIONS = Object.freeze({
  OWNERSHIP_MISSING: "docs_site.check.ownership_missing",
  CONFIG_MISSING: "docs_site.check.config_missing",
  SYNC_FAILED: "docs_site.check.sync_failed",
  API_FAILED: "docs_site.check.api_failed",
  BUILD_FAILED: "docs_site.check.build_failed",
  REFERENCE_EMPTY: "docs_site.check.reference_empty",
  HAND_EDIT_MARKER: "docs_site.check.hand_edit_marker",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "docs_site.check", ...event })}\n`,
  );
}

export function validateDocsSiteScaffold(opts = {}) {
  const siteRoot = opts.siteRoot ?? DOCS_SITE_ROOT;
  const violations = [];

  const ownership = path.join(siteRoot, "OWNERSHIP.md");
  if (!existsSync(ownership)) {
    violations.push({
      obligation: OBLIGATIONS.OWNERSHIP_MISSING,
      detail: "docs-site/OWNERSHIP.md is required",
    });
  } else {
    const text = readFileSync(ownership, "utf8");
    if (!text.includes("Canonical") || !text.includes("docs/")) {
      violations.push({
        obligation: OBLIGATIONS.OWNERSHIP_MISSING,
        detail: "OWNERSHIP.md must declare docs/ as canonical",
      });
    }
  }

  const config = path.join(siteRoot, ".vitepress", "config.mts");
  if (!existsSync(config)) {
    violations.push({
      obligation: OBLIGATIONS.CONFIG_MISSING,
      detail: "docs-site/.vitepress/config.mts is required",
    });
  }

  const index = path.join(siteRoot, "index.md");
  if (!existsSync(index)) {
    violations.push({
      obligation: OBLIGATIONS.CONFIG_MISSING,
      detail: "docs-site/index.md landing page is required",
    });
  }

  const typedoc = path.join(siteRoot, "typedoc.json");
  if (!existsSync(typedoc)) {
    violations.push({
      obligation: OBLIGATIONS.CONFIG_MISSING,
      detail: "docs-site/typedoc.json is required for API reference generation",
    });
  } else if (existsSync(config)) {
    const configText = readFileSync(config, "utf8");
    if (!configText.includes("/api/")) {
      violations.push({
        obligation: OBLIGATIONS.CONFIG_MISSING,
        detail: "vitepress config must integrate /api/ into site nav",
      });
    }
  }

  return {
    status: violations.length === 0 ? 0 : 1,
    violations,
  };
}

export function runDocsSiteCheck(opts = {}) {
  const subjectId = opts.subjectId ?? "docs-site-check";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const skipBuild = opts.skipBuild === true;

  const scaffold = validateDocsSiteScaffold(opts);
  if (scaffold.status !== 0) {
    const combined = scaffold.violations
      .map((v) => `[${v.obligation}] ${v.detail}`)
      .join("\n");
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "scaffold",
        violationCount: scaffold.violations.length,
      });
    }
    return {
      status: 1,
      phase: "scaffold",
      violations: scaffold.violations,
      combined: `DOCS_SITE_CHECK_FAILED (scaffold):\n${combined}`,
    };
  }

  const synced = syncDocsContent({
    subjectId,
    deviceId,
    emitEvents: false,
    ...(opts.docsRoot ? { docsRoot: opts.docsRoot } : {}),
    ...(opts.referenceRoot ? { referenceRoot: opts.referenceRoot } : {}),
    ...(opts.syncMap ? { syncMap: opts.syncMap } : {}),
  });
  if (synced.status !== 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "sync",
        violationCount: synced.violations.length,
      });
    }
    return {
      status: 1,
      phase: "sync",
      violations: synced.violations,
      combined: `DOCS_SITE_CHECK_FAILED (sync):\n${synced.combined}`,
    };
  }

  const referenceRoot = opts.referenceRoot ?? REFERENCE_ROOT;
  const marker = path.join(referenceRoot, ".generated");
  if (!existsSync(marker)) {
    return {
      status: 1,
      phase: "sync",
      violations: [
        {
          obligation: OBLIGATIONS.HAND_EDIT_MARKER,
          detail: "reference/.generated marker missing after sync",
        },
      ],
      combined: "DOCS_SITE_CHECK_FAILED (sync): missing .generated marker",
    };
  }

  if (synced.copied.length === 0) {
    return {
      status: 1,
      phase: "sync",
      violations: [
        {
          obligation: OBLIGATIONS.REFERENCE_EMPTY,
          detail: "sync produced zero doc groups",
        },
      ],
      combined: "DOCS_SITE_CHECK_FAILED (sync): empty reference tree",
    };
  }

  // Ensure every SYNC_MAP group landed.
  for (const entry of SYNC_MAP) {
    if (!synced.copied.includes(entry.id)) {
      return {
        status: 1,
        phase: "sync",
        violations: [
          {
            obligation: OBLIGATIONS.REFERENCE_EMPTY,
            detail: `sync missing group: ${entry.id}`,
          },
        ],
        combined: `DOCS_SITE_CHECK_FAILED (sync): missing ${entry.id}`,
      };
    }
  }

  if (!skipBuild) {
    const api = generateApiReference({
      subjectId,
      deviceId,
      emitEvents: false,
      ...(opts.skipStale ? { skipStale: true } : {}),
    });
    if (api.status !== 0) {
      if (emitEvents) {
        emit({
          outcome: "fail",
          subjectId,
          deviceId,
          phase: "api",
          violationCount: api.violations?.length ?? 1,
        });
      }
      return {
        status: 1,
        phase: "api",
        violations: (api.violations ?? []).map((v) => ({
          obligation: OBLIGATIONS.API_FAILED,
          detail: `[${v.obligation}] ${v.detail}`,
        })),
        combined: `DOCS_SITE_CHECK_FAILED (api):\n${api.combined}`,
      };
    }

    const build = spawnSync("pnpm", ["exec", "vitepress", "build"], {
      cwd: DOCS_SITE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    if (build.status !== 0) {
      const detail = (build.stderr || build.stdout || "vitepress build failed").trim();
      if (emitEvents) {
        emit({ outcome: "fail", subjectId, deviceId, phase: "build" });
      }
      return {
        status: 1,
        phase: "build",
        violations: [{ obligation: OBLIGATIONS.BUILD_FAILED, detail }],
        combined: `DOCS_SITE_CHECK_FAILED (build): ${detail}`,
      };
    }
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: skipBuild ? "sync" : "build",
      copiedCount: synced.copied.length,
    });
  }

  return {
    status: 0,
    phase: skipBuild ? "sync" : "build",
    copied: synced.copied,
    combined: skipBuild
      ? `OK: docs-site scaffold + sync (${synced.copied.join(", ")})`
      : `OK: docs-site scaffold, sync, and VitePress build (${synced.copied.join(", ")})`,
  };
}

function main() {
  const result = runDocsSiteCheck();
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
