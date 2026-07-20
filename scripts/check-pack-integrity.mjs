/**
 * Post-pack tarball integrity gate for @moolam/* release artifacts.
 *
 * Records SHA-256 digests after pack, then verifies no drift before upload.
 * Verify re-hashes recorded tarballs and dist/ content (pnpm pack is not
 * deterministic across consecutive invocations).
 *
 * Usage (repo root):
 *   node scripts/check-pack-integrity.mjs --record
 *   node scripts/check-pack-integrity.mjs --verify
 *   pnpm publish:integrity:record
 *   pnpm publish:integrity:verify
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPublicMoolamPackages, packageDirForName } from "./check-changeset-config.mjs";
import { REPO_ROOT } from "./check-package-publish-readiness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const INTEGRITY_SCHEMA_VERSION = "release.pack-integrity.v2";
export const DEFAULT_MANIFEST_PATH = path.join(
  REPO_ROOT,
  "artifacts",
  "release-pack-integrity",
  "manifest.json",
);
export const DEFAULT_PACK_DIR = path.join(
  REPO_ROOT,
  "artifacts",
  "release-pack-integrity",
  "packs",
);

export const PACKAGE_SCAN_LIMIT = 64;

export const OBLIGATIONS = Object.freeze({
  PACK_FAILED: "pack.integrity.pack_failed",
  MANIFEST_MISSING: "pack.integrity.manifest_missing",
  MANIFEST_PACKAGE_MISSING: "pack.integrity.manifest_package_missing",
  DIGEST_DRIFT: "pack.integrity.digest_drift",
  DIST_MISSING: "pack.integrity.dist_missing",
  TARBALL_MISSING: "pack.integrity.tarball_missing",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "pack.integrity.gate", ...event })}\n`,
  );
}

export function listPublicPackageManifests() {
  return listPublicMoolamPackages()
    .slice(0, PACKAGE_SCAN_LIMIT)
    .map((name) => {
      const dir = packageDirForName(name);
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      return { name, dir, manifest };
    });
}

export function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

export function sha256DistDirectory(distDir) {
  const hash = createHash("sha256");

  function walk(relDir) {
    const absDir = relDir ? path.join(distDir, relDir) : distDir;
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      hash.update(relPath);
      hash.update("\0");
      hash.update(readFileSync(path.join(distDir, relPath)));
      hash.update("\0");
    }
  }

  walk("");
  return hash.digest("hex");
}

export function tarballPrefixForPackage(name) {
  if (name.startsWith("@")) {
    return name.replace("@", "").replace("/", "-");
  }
  return name;
}

export function findLatestTarball(packDir, name) {
  const prefix = tarballPrefixForPackage(name);
  const matches = readdirSync(packDir)
    .filter((file) => file.endsWith(".tgz") && file.startsWith(prefix))
    .sort();
  return matches.at(-1) ?? null;
}

export function packPackageToDir(pkg, packDir) {
  if (!existsSync(path.join(pkg.dir, "dist"))) {
    return {
      ok: false,
      violation: {
        obligation: OBLIGATIONS.DIST_MISSING,
        detail: `missing dist/ before pack: ${pkg.name}`,
      },
    };
  }
  try {
    execSync(`pnpm pack --pack-destination "${packDir}"`, {
      cwd: pkg.dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const detail =
      err && typeof err === "object" && "stderr" in err
        ? String(err.stderr).trim()
        : String(err);
    return {
      ok: false,
      violation: {
        obligation: OBLIGATIONS.PACK_FAILED,
        detail: `${pkg.name}: ${detail}`,
      },
    };
  }

  const tarball = findLatestTarball(packDir, pkg.name);
  if (!tarball) {
    return {
      ok: false,
      violation: {
        obligation: OBLIGATIONS.PACK_FAILED,
        detail: `no tarball produced for ${pkg.name}`,
      },
    };
  }

  const tarballPath = path.join(packDir, tarball);
  const distDir = path.join(pkg.dir, "dist");
  return {
    ok: true,
    entry: {
      name: pkg.name,
      version: String(pkg.manifest.version ?? ""),
      tarball,
      sha256: sha256File(tarballPath),
      distSha256: sha256DistDirectory(distDir),
    },
  };
}

export function recordPackIntegrityManifest(opts = {}) {
  const packDir = opts.packDir ?? DEFAULT_PACK_DIR;
  const manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const packages = opts.packages ?? listPublicPackageManifests();
  const violations = [];
  const entries = [];

  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });

  for (const pkg of packages) {
    const packed = packPackageToDir(pkg, packDir);
    if (!packed.ok) {
      violations.push(packed.violation);
      continue;
    }
    entries.push(packed.entry);
  }

  if (violations.length > 0) {
    return { status: 1, violations, entries, combined: formatViolations(violations) };
  }

  const manifest = {
    schemaVersion: INTEGRITY_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    packageCount: entries.length,
    packages: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    status: 0,
    manifest,
    manifestPath,
    packDir,
    combined: `OK: recorded pack integrity manifest for ${entries.length} package(s)`,
  };
}

export function loadPackIntegrityManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      violation: {
        obligation: OBLIGATIONS.MANIFEST_MISSING,
        detail: `manifest missing: ${manifestPath}`,
      },
    };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return { ok: true, manifest };
}

export function verifyPackIntegrityManifest(opts = {}) {
  const manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const packDir = opts.packDir ?? DEFAULT_PACK_DIR;
  const packages = opts.packages ?? listPublicPackageManifests();
  const loaded = loadPackIntegrityManifest(manifestPath);
  if (!loaded.ok) {
    return {
      status: 1,
      violations: [loaded.violation],
      combined: formatViolations([loaded.violation]),
    };
  }

  const expectedByName = new Map(
    (loaded.manifest.packages ?? []).map((entry) => [entry.name, entry]),
  );
  const violations = [];
  const observed = [];

  for (const pkg of packages) {
    const expected = expectedByName.get(pkg.name);
    if (!expected) {
      violations.push({
        obligation: OBLIGATIONS.MANIFEST_PACKAGE_MISSING,
        detail: `manifest missing package entry: ${pkg.name}`,
      });
      continue;
    }

    const distDir = path.join(pkg.dir, "dist");
    if (!existsSync(distDir)) {
      violations.push({
        obligation: OBLIGATIONS.DIST_MISSING,
        detail: `missing dist/ before verify: ${pkg.name}`,
      });
      continue;
    }

    const tarballPath = path.join(packDir, expected.tarball);
    if (!existsSync(tarballPath)) {
      violations.push({
        obligation: OBLIGATIONS.TARBALL_MISSING,
        detail: `recorded tarball missing for ${pkg.name}: ${expected.tarball}`,
      });
      continue;
    }

    const entry = {
      name: pkg.name,
      version: String(pkg.manifest.version ?? ""),
      tarball: expected.tarball,
      sha256: sha256File(tarballPath),
      distSha256: sha256DistDirectory(distDir),
    };
    observed.push(entry);

    if (entry.sha256 !== expected.sha256) {
      violations.push({
        obligation: OBLIGATIONS.DIGEST_DRIFT,
        detail: `${pkg.name} tarball digest drift (expected ${expected.sha256}, observed ${entry.sha256})`,
      });
    }
    if (expected.distSha256 && entry.distSha256 !== expected.distSha256) {
      violations.push({
        obligation: OBLIGATIONS.DIGEST_DRIFT,
        detail: `${pkg.name} dist digest drift (expected ${expected.distSha256}, observed ${entry.distSha256})`,
      });
    }
    if (entry.version !== expected.version) {
      violations.push({
        obligation: OBLIGATIONS.DIGEST_DRIFT,
        detail: `${pkg.name} version drift (expected ${expected.version}, observed ${entry.version})`,
      });
    }
  }

  if (violations.length > 0) {
    return {
      status: 1,
      violations,
      observed,
      combined: formatViolations(violations),
    };
  }

  return {
    status: 0,
    observed,
    combined: `OK: verified pack integrity for ${observed.length} package(s)`,
  };
}

function formatViolations(violations) {
  return `PACK_INTEGRITY_FAILED (${violations.length} violation(s)):\n${violations
    .map((v) => `[${v.obligation}] ${v.detail}`)
    .join("\n")}`;
}

export function runPackIntegrityGate(mode, opts = {}) {
  const subjectId = opts.subjectId ?? "ci-pack-integrity";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const result =
    mode === "record"
      ? recordPackIntegrityManifest(opts)
      : verifyPackIntegrityManifest(opts);

  if (emitEvents) {
    emit({
      outcome: result.status === 0 ? "ok" : "fail",
      subjectId,
      deviceId,
      mode,
      packageCount:
        result.manifest?.packageCount ??
        result.observed?.length ??
        result.entries?.length ??
        0,
      violationCount: result.violations?.length ?? 0,
    });
  }

  return result;
}

function main() {
  const record = process.argv.includes("--record");
  const verify = process.argv.includes("--verify");
  if (!record && !verify) {
    process.stderr.write("Usage: node scripts/check-pack-integrity.mjs --record|--verify\n");
    process.exit(2);
  }
  const result = runPackIntegrityGate(record ? "record" : "verify");
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
