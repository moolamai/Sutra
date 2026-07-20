/**
 * Package publish metadata gate (DIST-01 / P5 package publish readiness).
 *
 * Audits every packages/<name>/package.json:
 * - Public @moolam scope packages: publishConfig.access public, repository, homepage, license, files whitelist
 * - Private workspace packages: must not declare public publishConfig
 * - main / types / exports must resolve under ./dist/
 *
 * Usage (repo root):
 *   node scripts/check-package-publish-readiness.mjs
 *   pnpm publish:readiness
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPublishableNpmPackageName } from "./check-changeset-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const MONO_REPO_GIT_URL = "git+https://github.com/moolamai/sutra.git";
export const MONO_REPO_HOMEPAGE_BASE =
  "https://github.com/moolamai/sutra/tree/main";

/** Bounded scan root (NFR — no full-repo walk). */
export const PACKAGES_ROOT = "packages";

/** Max packages audited per run (NFR). */
export const PACKAGE_SCAN_LIMIT = 64;

/** Max violation lines in human output. */
export const VIOLATION_REPORT_LIMIT = 64;

export const OBLIGATIONS = Object.freeze({
  PUBLISH_CONFIG_MISSING: "publishConfig.access:public",
  PUBLISH_CONFIG_NOT_PUBLIC: "publishConfig.access:public",
  REPOSITORY_MISSING: "repository.monorepo",
  REPOSITORY_DIRECTORY_MISMATCH: "repository.directory",
  HOMEPAGE_MISSING: "homepage",
  LICENSE_MISSING: "license",
  FILES_MISSING: "files",
  FILES_MISSING_DIST: "files.dist",
  FILES_FORBIDDEN_ENTRY: "files.forbidden",
  FILES_BIN_UNDECLARED: "files.bin",
  EXPORT_NOT_DIST: "exports.dist",
  MAIN_NOT_DIST: "main.dist",
  TYPES_NOT_DIST: "types.dist",
  DIST_ARTIFACT_MISSING: "dist.artifact",
  PRIVATE_HAS_PUBLIC_PUBLISH: "private.publishConfig",
  PACK_DRY_RUN_FAILED: "pack.dry_run",
  PACK_EXPORT_MISSING: "pack.export_missing",
  PACK_DIST_MISSING: "pack.dist_missing",
  PACK_WARNING: "pack.warning",
});

/** Tarball must never ship source, tests, or secrets. */
export const FORBIDDEN_FILES_ENTRIES = Object.freeze([
  "src",
  "tests",
  "test",
  "__tests__",
  "scripts",
  ".env",
]);

export const ALLOWED_FILES_EXTRAS = Object.freeze([
  "dist",
  "bin",
  "fixtures",
  "schemas",
  "certification",
  "android",
  "macos",
]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "publish.readiness.gate", ...event })}\n`,
  );
}

function normalizeRepoUrl(url) {
  return String(url ?? "")
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

function isDistRelative(p) {
  if (typeof p !== "string" || !p.startsWith("./dist/")) {
    return false;
  }
  return !p.includes("..");
}

function collectExportPaths(exportsField) {
  const paths = [];
  if (!exportsField || typeof exportsField !== "object") {
    return paths;
  }
  for (const value of Object.values(exportsField)) {
    if (typeof value === "string") {
      paths.push(value);
    } else if (value && typeof value === "object") {
      for (const sub of Object.values(value)) {
        if (typeof sub === "string") {
          paths.push(sub);
        }
      }
    }
  }
  return paths;
}

function binDirectories(binField) {
  if (!binField || typeof binField !== "object") {
    return [];
  }
  const dirs = new Set();
  for (const target of Object.values(binField)) {
    if (typeof target !== "string") continue;
    const dir = path.posix.dirname(target.replace(/^\.\//, ""));
    if (dir && dir !== ".") {
      dirs.add(dir);
    }
  }
  return [...dirs];
}

/**
 * Audit one package manifest. Returns violation rows (empty = pass).
 */
export function auditPackageManifest(manifest, relDir, opts = {}) {
  const violations = [];
  const pkgDir = path.join(REPO_ROOT, relDir);
  const isPrivate = manifest.private === true;
  const isPublishable = isPublishableNpmPackageName(manifest.name);

  if (!isPublishable) {
    return violations;
  }

  if (isPrivate) {
    if (manifest.publishConfig?.access === "public") {
      violations.push({
        obligation: OBLIGATIONS.PRIVATE_HAS_PUBLIC_PUBLISH,
        package: manifest.name,
        path: relDir,
        detail: "private workspace package must not declare publishConfig.access public",
      });
    }
    return violations;
  }

  if (manifest.publishConfig?.access !== "public") {
    violations.push({
      obligation: OBLIGATIONS.PUBLISH_CONFIG_MISSING,
      package: manifest.name,
      path: relDir,
      detail: 'missing publishConfig.access "public"',
    });
  }

  const repo = manifest.repository;
  if (!repo || repo.type !== "git" || !repo.url) {
    violations.push({
      obligation: OBLIGATIONS.REPOSITORY_MISSING,
      package: manifest.name,
      path: relDir,
      detail: "repository.type git and repository.url required",
    });
  } else {
    const normalized = normalizeRepoUrl(repo.url);
    const expected = normalizeRepoUrl(MONO_REPO_GIT_URL);
    if (normalized !== expected) {
      violations.push({
        obligation: OBLIGATIONS.REPOSITORY_MISSING,
        package: manifest.name,
        path: relDir,
        detail: `repository.url must point at ${MONO_REPO_GIT_URL}`,
      });
    }
    const expectedDir = relDir.replace(/\\/g, "/");
    if (repo.directory !== expectedDir) {
      violations.push({
        obligation: OBLIGATIONS.REPOSITORY_DIRECTORY_MISMATCH,
        package: manifest.name,
        path: relDir,
        detail: `repository.directory must be ${expectedDir}`,
      });
    }
  }

  const expectedHomepage = `${MONO_REPO_HOMEPAGE_BASE}/${relDir.replace(/\\/g, "/")}#readme`;
  if (manifest.homepage !== expectedHomepage) {
    violations.push({
      obligation: OBLIGATIONS.HOMEPAGE_MISSING,
      package: manifest.name,
      path: relDir,
      detail: `homepage must be ${expectedHomepage}`,
    });
  }

  if (!manifest.license) {
    violations.push({
      obligation: OBLIGATIONS.LICENSE_MISSING,
      package: manifest.name,
      path: relDir,
      detail: "license field required",
    });
  }

  const files = manifest.files;
  if (!Array.isArray(files) || files.length === 0) {
    violations.push({
      obligation: OBLIGATIONS.FILES_MISSING,
      package: manifest.name,
      path: relDir,
      detail: "files whitelist required",
    });
  } else {
    if (!files.includes("dist")) {
      violations.push({
        obligation: OBLIGATIONS.FILES_MISSING_DIST,
        package: manifest.name,
        path: relDir,
        detail: 'files must include "dist"',
      });
    }
    for (const entry of files) {
      if (FORBIDDEN_FILES_ENTRIES.includes(entry)) {
        violations.push({
          obligation: OBLIGATIONS.FILES_FORBIDDEN_ENTRY,
          package: manifest.name,
          path: relDir,
          detail: `files must not include forbidden entry "${entry}"`,
        });
      }
    }
    for (const binDir of binDirectories(manifest.bin)) {
      if (!files.includes(binDir)) {
        violations.push({
          obligation: OBLIGATIONS.FILES_BIN_UNDECLARED,
          package: manifest.name,
          path: relDir,
          detail: `files must include bin directory "${binDir}"`,
        });
      }
    }
  }

  if (manifest.main && !isDistRelative(manifest.main)) {
    violations.push({
      obligation: OBLIGATIONS.MAIN_NOT_DIST,
      package: manifest.name,
      path: relDir,
      detail: `main must point under ./dist/ (got ${manifest.main})`,
    });
  }

  if (manifest.types && !isDistRelative(manifest.types)) {
    violations.push({
      obligation: OBLIGATIONS.TYPES_NOT_DIST,
      package: manifest.name,
      path: relDir,
      detail: `types must point under ./dist/ (got ${manifest.types})`,
    });
  }

  for (const exportPath of collectExportPaths(manifest.exports)) {
    if (!isDistRelative(exportPath)) {
      violations.push({
        obligation: OBLIGATIONS.EXPORT_NOT_DIST,
        package: manifest.name,
        path: relDir,
        detail: `exports must point under ./dist/ (got ${exportPath})`,
      });
    } else if (opts.verifyDistArtifacts) {
      const artifact = path.join(pkgDir, exportPath);
      if (!existsSync(artifact)) {
        violations.push({
          obligation: OBLIGATIONS.DIST_ARTIFACT_MISSING,
          package: manifest.name,
          path: relDir,
          detail: `missing built artifact ${exportPath}`,
        });
      }
    }
  }

  return violations;
}

/** pnpm pack stderr/stdout lines that indicate broken exports or undeclared files. */
export const PACK_FAILURE_PATTERNS = Object.freeze([
  /\bwarn(?:ing)?\b/i,
  /\bnot found\b/i,
  /\bcannot find\b/i,
  /\bfailed to resolve\b/i,
  /\bundeclared\b/i,
  /\bmissing\b/i,
  /\bENOENT\b/,
  /\berror\b/i,
]);

/**
 * Parse pnpm pack --dry-run output and verify tarball includes dist + export targets.
 */
export function analyzePackDryRunOutput(output, manifest) {
  const issues = [];
  const contentsStart = output.indexOf("Tarball Contents");
  const detailsStart = output.indexOf("Tarball Details");
  const prePackSection =
    contentsStart >= 0 ? output.slice(0, contentsStart) : output;

  for (const line of prePackSection.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("📦")) continue;
    if (PACK_FAILURE_PATTERNS.some((re) => re.test(trimmed))) {
      issues.push({ obligation: OBLIGATIONS.PACK_WARNING, detail: trimmed });
    }
  }

  const tarballSection =
    contentsStart >= 0
      ? output.slice(
          contentsStart,
          detailsStart >= 0 ? detailsStart : undefined,
        )
      : "";

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.includes("dist")) {
    const hasDistEntry = /\ndist\//m.test(tarballSection) || /^dist\//m.test(tarballSection);
    if (!hasDistEntry) {
      issues.push({
        obligation: OBLIGATIONS.PACK_DIST_MISSING,
        detail: 'tarball missing dist/ entries (build output not included)',
      });
    }
  }

  for (const exportPath of collectExportPaths(manifest.exports)) {
    const rel = exportPath.replace(/^\.\//, "").replace(/\\/g, "/");
    if (!tarballSection.includes(rel)) {
      issues.push({
        obligation: OBLIGATIONS.PACK_EXPORT_MISSING,
        detail: `export target not in tarball: ${exportPath}`,
      });
    }
  }

  if (manifest.main) {
    const rel = manifest.main.replace(/^\.\//, "").replace(/\\/g, "/");
    if (!tarballSection.includes(rel)) {
      issues.push({
        obligation: OBLIGATIONS.PACK_EXPORT_MISSING,
        detail: `main entry not in tarball: ${manifest.main}`,
      });
    }
  }

  return issues;
}

/**
 * Run pnpm pack --dry-run for one package directory.
 */
export function runPackDryRun(packageDir, manifest) {
  try {
    const stdout = execSync("pnpm pack --dry-run", {
      cwd: packageDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = "";
    const combined = `${stdout}\n${stderr}`.trim();
    const issues = analyzePackDryRunOutput(combined, manifest);
    if (issues.length > 0) {
      return {
        ok: false,
        detail: issues.map((i) => `[${i.obligation}] ${i.detail}`).join("\n"),
        issues,
        output: combined,
      };
    }
    return { ok: true, output: combined, issues: [] };
  } catch (err) {
    const stdout =
      err && typeof err === "object" && "stdout" in err ? String(err.stdout) : "";
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String(err.stderr).trim()
        : String(err);
    const combined = `${stdout}\n${stderr}`.trim();
    const issues = analyzePackDryRunOutput(combined, manifest);
    if (issues.length === 0) {
      issues.push({
        obligation: OBLIGATIONS.PACK_DRY_RUN_FAILED,
        detail: stderr || "pnpm pack --dry-run exited non-zero",
      });
    }
    return {
      ok: false,
      detail: issues.map((i) => `[${i.obligation}] ${i.detail}`).join("\n"),
      issues,
      output: combined,
    };
  }
}

export function formatViolations(violations) {
  return violations
    .slice(0, VIOLATION_REPORT_LIMIT)
    .map(
      (v) =>
        `${v.package} (${v.path}): [${v.obligation}] ${v.detail}`,
    )
    .join("\n");
}

export function listPackageManifests() {
  const root = path.join(REPO_ROOT, PACKAGES_ROOT);
  const entries = readdirSync(root)
    .filter((name) => {
      const pkgJson = path.join(root, name, "package.json");
      return existsSync(pkgJson) && statSync(pkgJson).isFile();
    })
    .sort()
    .slice(0, PACKAGE_SCAN_LIMIT);

  return entries.map((name) => {
    const relDir = `${PACKAGES_ROOT}/${name}`;
    const pkgJsonPath = path.join(REPO_ROOT, relDir, "package.json");
    const manifest = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    return { relDir, manifest, pkgJsonPath };
  });
}

/**
 * Full gate. Returns { status, violations, combined, packagesAudited }.
 */
export function runPackagePublishReadinessGate(opts = {}) {
  const subjectId = opts.subjectId ?? "ci-publish-readiness";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const verifyDistArtifacts = opts.verifyDistArtifacts === true;
  const runPack = opts.runPack === true;

  const packages = listPackageManifests();
  const violations = [];

  for (const { relDir, manifest } of packages) {
    violations.push(
      ...auditPackageManifest(manifest, relDir, { verifyDistArtifacts }),
    );

    if (
      runPack &&
      manifest.private !== true &&
      typeof manifest.name === "string" &&
      isPublishableNpmPackageName(manifest.name)
    ) {
      const packed = runPackDryRun(path.join(REPO_ROOT, relDir), manifest);
      if (!packed.ok) {
        for (const issue of packed.issues ?? [{ obligation: OBLIGATIONS.PACK_DRY_RUN_FAILED, detail: packed.detail }]) {
          violations.push({
            obligation: issue.obligation ?? OBLIGATIONS.PACK_DRY_RUN_FAILED,
            package: manifest.name,
            path: relDir,
            detail: issue.detail ?? packed.detail ?? "pnpm pack --dry-run failed",
          });
        }
        if (emitEvents) {
          emit({
            outcome: "fail",
            subjectId,
            deviceId,
            package: manifest.name,
            op: "pack",
            failureClass: "pack_dry_run_failed",
          });
        }
      } else if (emitEvents) {
        emit({
          outcome: "ok",
          subjectId,
          deviceId,
          package: manifest.name,
          op: "pack",
        });
      }
    }
  }

  const status = violations.length === 0 ? 0 : 1;
  const combined =
    violations.length === 0
      ? `OK: ${packages.length} package manifest(s) publish-ready`
      : `PUBLISH_READINESS_FAILED (${violations.length} violation(s)):\n${formatViolations(violations)}`;

  if (emitEvents) {
    emit({
      outcome: status === 0 ? "ok" : "fail",
      subjectId,
      deviceId,
      packagesAudited: packages.length,
      violationCount: violations.length,
    });
  }

  return { status, violations, combined, packagesAudited: packages.length };
}

/**
 * Pack dry-run gate for public @moolam/* packages only (DIST-01 pack slice).
 */
export function runPackagePackDryRunGate(opts = {}) {
  const subjectId = opts.subjectId ?? "ci-publish-pack";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;

  const packages = listPackageManifests();
  const violations = [];
  let packsRun = 0;

  for (const { relDir, manifest } of packages) {
    if (
      manifest.private === true ||
      typeof manifest.name !== "string" ||
      !isPublishableNpmPackageName(manifest.name)
    ) {
      continue;
    }
    packsRun += 1;
    const packed = runPackDryRun(path.join(REPO_ROOT, relDir), manifest);
    if (!packed.ok) {
      for (const issue of packed.issues ?? [{ obligation: OBLIGATIONS.PACK_DRY_RUN_FAILED, detail: packed.detail }]) {
        violations.push({
          obligation: issue.obligation ?? OBLIGATIONS.PACK_DRY_RUN_FAILED,
          package: manifest.name,
          path: relDir,
          detail: issue.detail ?? packed.detail ?? "pnpm pack --dry-run failed",
        });
      }
      if (emitEvents) {
        emit({
          outcome: "fail",
          subjectId,
          deviceId,
          package: manifest.name,
          op: "pack",
          failureClass: "pack_dry_run_failed",
        });
      }
    } else if (emitEvents) {
      emit({
        outcome: "ok",
        subjectId,
        deviceId,
        package: manifest.name,
        op: "pack",
      });
    }
  }

  const status = violations.length === 0 ? 0 : 1;
  const combined =
    violations.length === 0
      ? `OK: ${packsRun} publishable package(s) passed pack dry-run`
      : `PACK_DRY_RUN_FAILED (${violations.length} violation(s)):\n${formatViolations(violations)}`;

  if (emitEvents) {
    emit({
      outcome: status === 0 ? "ok" : "fail",
      subjectId,
      deviceId,
      packagesAudited: packsRun,
      violationCount: violations.length,
      op: "pack_gate",
    });
  }

  return { status, violations, combined, packagesAudited: packsRun };
}

function main() {
  const packOnly = process.argv.includes("--pack-only");
  const verifyDistArtifacts =
    process.env.PUBLISH_READINESS_VERIFY_DIST === "1" || process.env.CI === "true";
  const runPack =
    packOnly ||
    process.argv.includes("--pack") ||
    process.env.PUBLISH_READINESS_PACK === "1";

  if (packOnly) {
    const result = runPackagePackDryRunGate();
    if (result.status !== 0) {
      process.stderr.write(`${result.combined}\n`);
      process.exit(1);
    }
    process.stdout.write(`${result.combined}\n`);
    return;
  }

  const result = runPackagePublishReadinessGate({
    verifyDistArtifacts,
    runPack,
  });
  if (result.status !== 0) {
    process.stderr.write(`${result.combined}\n`);
    process.exit(1);
  }
  process.stdout.write(`${result.combined}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
