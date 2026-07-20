/**
 * Changeset config gate for @moolam/* publish packages.
 *
 * Ensures .changeset/config.json keeps every public package in the fixed
 * (lockstep) group and non-publishable workspace packages in ignore.
 *
 * Usage (repo root):
 *   node scripts/check-changeset-config.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const CHANGESET_CONFIG_PATH = path.join(REPO_ROOT, ".changeset", "config.json");

/** Workspace packages excluded from npm release versioning. */
export const DEFAULT_IGNORED_PACKAGES = Object.freeze([
  "@moolam/cloud-orchestrator",
  "@moolam/contract-mocks",
  "@moolam/examples",
  "@moolam/benchmarks",
  "@moolam/playground",
  "@moolam/training-corpus",
  "@moolam/training-distillation",
  "@moolam/training-gym",
]);

/** Public npm packages published under the Sutra SDK brand (unscoped). */
export const PUBLIC_UNSCOPED_NPM_PACKAGES = Object.freeze(
  new Set([
    "sutra-sdk",
    "sutra-bindings-knowledge",
    "sutra-bindings-slm",
    "sutra-bindings-speech",
    "sutra-bindings-vision",
  ]),
);

export function isPublishableNpmPackageName(name) {
  if (typeof name !== "string") return false;
  if (name.startsWith("@moolam/")) return true;
  return PUBLIC_UNSCOPED_NPM_PACKAGES.has(name);
}

export function packageDirForName(name, repoRoot = REPO_ROOT) {
  if (name === "sutra-sdk") {
    return path.join(repoRoot, "packages", "sdk");
  }
  const bindingMatch = /^sutra-bindings-(.+)$/.exec(name);
  if (bindingMatch) {
    return path.join(repoRoot, "packages", `bindings-${bindingMatch[1]}`);
  }
  const short = name.replace(/^@moolam\//, "");
  return path.join(repoRoot, "packages", short);
}

export function listPublicMoolamPackages() {
  const packagesDir = path.join(REPO_ROOT, "packages");
  const names = [];
  for (const entry of readdirSync(packagesDir)) {
    const pkgPath = path.join(packagesDir, entry, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.private === true) continue;
    const name = String(pkg.name ?? "");
    if (!isPublishableNpmPackageName(name)) continue;
    names.push(name);
  }
  return names.sort();
}

export function loadChangesetConfig(configPath = CHANGESET_CONFIG_PATH) {
  if (!existsSync(configPath)) {
    throw new Error(`CHANGESET_CONFIG_MISSING:${configPath}`);
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

export function validateChangesetConfig(config, publicPackages = listPublicMoolamPackages()) {
  const violations = [];
  const fixedGroups = Array.isArray(config.fixed) ? config.fixed : [];
  const linkedGroups = Array.isArray(config.linked) ? config.linked : [];
  const lockstep = fixedGroups.flat();
  const linked = linkedGroups.flat();
  const ignore = new Set(Array.isArray(config.ignore) ? config.ignore : []);

  if (lockstep.length === 0) {
    violations.push({
      obligation: "changeset.fixed.required",
      detail: "fixed group must list all publishable @moolam/* packages for lockstep versions",
    });
  }

  for (const pkg of publicPackages) {
    if (!lockstep.includes(pkg)) {
      violations.push({
        obligation: "changeset.fixed.package",
        detail: `missing publishable package in fixed group: ${pkg}`,
      });
    }
    if (linked.includes(pkg)) {
      violations.push({
        obligation: "changeset.group.conflict",
        detail: `package must not appear in both fixed and linked: ${pkg}`,
      });
    }
    if (ignore.has(pkg)) {
      violations.push({
        obligation: "changeset.ignore.publishable",
        detail: `publishable package must not be ignored: ${pkg}`,
      });
    }
  }

  for (const pkg of DEFAULT_IGNORED_PACKAGES) {
    if (!ignore.has(pkg)) {
      violations.push({
        obligation: "changeset.ignore.workspace",
        detail: `non-publishable workspace package must be ignored: ${pkg}`,
      });
    }
  }

  if (config.access !== "public") {
    violations.push({
      obligation: "changeset.access.public",
      detail: 'publish access must be "public"',
    });
  }

  if (config.commit !== false) {
    violations.push({
      obligation: "changeset.commit.false",
      detail: "commit must be false — release workflow owns git commits",
    });
  }

  return {
    status: violations.length === 0 ? 0 : 1,
    violations,
    publicPackages,
    lockstepPackages: lockstep.slice().sort(),
  };
}

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "changeset.config.gate", ...event })}\n`,
  );
}

export function runChangesetConfigGate(opts = {}) {
  const subjectId = opts.subjectId ?? "ci-changeset-config";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const config = opts.config ?? loadChangesetConfig(opts.configPath);
  const result = validateChangesetConfig(config, opts.publicPackages);

  if (emitEvents) {
    emit({
      outcome: result.status === 0 ? "ok" : "fail",
      subjectId,
      deviceId,
      packageCount: result.publicPackages.length,
      violationCount: result.violations.length,
    });
  }

  const combined =
    result.status === 0
      ? `OK: changeset config covers ${result.publicPackages.length} publishable package(s)`
      : `CHANGESET_CONFIG_FAILED (${result.violations.length} violation(s)):\n${result.violations
          .map((v) => `[${v.obligation}] ${v.detail}`)
          .join("\n")}`;

  return { ...result, combined };
}

function main() {
  const result = runChangesetConfigGate();
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
