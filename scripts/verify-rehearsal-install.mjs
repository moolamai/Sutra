/**
 * Rehearsal release install verification for @moolam/* packages.
 *
 * Simulates a stranger machine installing sutra-sdk from scratch scope
 * (local packed tarballs in CI, or scratch registry after tag publish).
 *
 * Usage (repo root):
 *   node scripts/verify-rehearsal-install.mjs --from-local-packs
 *   node scripts/verify-rehearsal-install.mjs --from-registry
 *   pnpm publish:rehearsal:verify
 */

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPublicMoolamPackages, packageDirForName } from "./check-changeset-config.mjs";
import { REPO_ROOT } from "./check-package-publish-readiness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const OBLIGATIONS = Object.freeze({
  PACK_DIR_MISSING: "rehearsal.pack_dir.missing",
  PACK_FAILED: "rehearsal.pack.failed",
  CONSUMER_INSTALL_FAILED: "rehearsal.consumer.install_failed",
  IMPORT_FAILED: "rehearsal.consumer.import_failed",
  SDK_SURFACE_MISSING: "rehearsal.sdk.surface_missing",
  REGISTRY_VERSION_MISSING: "rehearsal.registry.version_missing",
  REGISTRY_URL_MISSING: "rehearsal.registry.url_missing",
});

export const SDK_IMPORT_PROBE = "CognitiveCore";

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "rehearsal.install.verify", ...event })}\n`,
  );
}

export function parseRehearsalVersion(tagOrVersion) {
  const raw = String(tagOrVersion ?? "").trim();
  if (!raw) return "";
  return raw.startsWith("v") ? raw.slice(1) : raw;
}

export function listPublicPackageManifests() {
  return listPublicMoolamPackages().map((name) => {
    const dir = packageDirForName(name);
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    return { name, dir, manifest };
  });
}

export function packPublicPackages(packDir, packages = listPublicPackageManifests()) {
  mkdirSync(packDir, { recursive: true });
  const tarballs = [];
  const violations = [];

  for (const pkg of packages) {
    if (!existsSync(path.join(pkg.dir, "dist"))) {
      violations.push({
        obligation: OBLIGATIONS.PACK_FAILED,
        detail: `missing dist/ before pack: ${pkg.name}`,
      });
      continue;
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
      violations.push({
        obligation: OBLIGATIONS.PACK_FAILED,
        detail: `${pkg.name}: ${detail}`,
      });
      continue;
    }

    const matches = readdirSync(packDir)
      .filter((file) => file.endsWith(".tgz"))
      .filter((file) => file.startsWith(pkg.name.replace("/", "-").replace("@", "")));
    const tarball = matches.sort().at(-1);
    if (!tarball) {
      violations.push({
        obligation: OBLIGATIONS.PACK_FAILED,
        detail: `no tarball produced for ${pkg.name}`,
      });
      continue;
    }
    tarballs.push({
      name: pkg.name,
      version: pkg.manifest.version,
      path: path.join(packDir, tarball),
    });
  }

  return { tarballs, violations };
}

export function buildConsumerDependenciesFromTarballs(tarballs) {
  const deps = {};
  for (const entry of tarballs) {
    deps[entry.name] = `file:${entry.path.replace(/\\/g, "/")}`;
  }
  return deps;
}

export function buildPnpmOverridesFromTarballs(tarballs) {
  return buildConsumerDependenciesFromTarballs(tarballs);
}

export function writeConsumerProject(consumerDir, deps, targetPackage = "sutra-sdk") {
  mkdirSync(consumerDir, { recursive: true });
  const overrides = buildPnpmOverridesFromTarballs(
    Object.entries(deps).map(([name, filePath]) => ({
      name,
      path: filePath.replace(/^file:/, ""),
    })),
  );
  writeFileSync(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "rehearsal-consumer",
        private: true,
        type: "module",
        dependencies: {
          [targetPackage]: deps[targetPackage],
        },
        pnpm: {
          overrides,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(consumerDir, "probe.mjs"),
    `import * as sdk from "${targetPackage}";\n` +
      `if (sdk.${SDK_IMPORT_PROBE} == null) {\n` +
      `  throw new Error("missing ${SDK_IMPORT_PROBE} export");\n` +
      `}\n` +
      `console.log("ok:${SDK_IMPORT_PROBE}");\n`,
  );
}

export function installInConsumerProject(consumerDir) {
  const result = spawnSync("pnpm", ["install", "--ignore-workspace"], {
    cwd: consumerDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      detail: (result.stderr || result.stdout || "pnpm install failed").trim(),
    };
  }
  return { ok: true };
}

export function probeSdkImport(consumerDir) {
  const result = spawnSync("node", ["probe.mjs"], {
    cwd: consumerDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      obligation: OBLIGATIONS.IMPORT_FAILED,
      detail: (result.stderr || result.stdout || "import probe failed").trim(),
    };
  }
  if (!String(result.stdout).includes(`ok:${SDK_IMPORT_PROBE}`)) {
    return {
      ok: false,
      obligation: OBLIGATIONS.SDK_SURFACE_MISSING,
      detail: `${SDK_IMPORT_PROBE} export probe did not succeed`,
    };
  }
  return { ok: true };
}

export function writeRehearsalRunRecord(recordPath, record) {
  mkdirSync(path.dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

export function runRehearsalInstallFromLocalPacks(opts = {}) {
  const subjectId = opts.subjectId ?? "rehearsal-local-packs";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const workRoot =
    opts.workRoot ?? mkdtempSync(path.join(tmpdir(), "sutra-rehearsal-install-"));
  const packDir = path.join(workRoot, "packs");
  const consumerDir = path.join(workRoot, "consumer");
  const cleanup = opts.cleanup !== false;

  const packed = packPublicPackages(packDir, opts.packages);
  if (packed.violations.length > 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "local-packs",
        phase: "pack",
        violationCount: packed.violations.length,
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "pack",
      violations: packed.violations,
      combined: `REHEARSAL_INSTALL_FAILED (pack):\n${packed.violations
        .map((v) => `[${v.obligation}] ${v.detail}`)
        .join("\n")}`,
    };
  }

  const deps = buildConsumerDependenciesFromTarballs(packed.tarballs);
  writeConsumerProject(consumerDir, deps, opts.targetPackage ?? "sutra-sdk");

  const installed = installInConsumerProject(consumerDir);
  if (!installed.ok) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "local-packs",
        phase: "install",
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "install",
      violations: [
        {
          obligation: OBLIGATIONS.CONSUMER_INSTALL_FAILED,
          detail: installed.detail,
        },
      ],
      combined: `REHEARSAL_INSTALL_FAILED (install): ${installed.detail}`,
    };
  }

  const probed = probeSdkImport(consumerDir);
  if (!probed.ok) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "local-packs",
        phase: "import",
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "import",
      violations: [{ obligation: probed.obligation, detail: probed.detail }],
      combined: `REHEARSAL_INSTALL_FAILED (import): [${probed.obligation}] ${probed.detail}`,
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      mode: "local-packs",
      phase: "import",
      packageCount: packed.tarballs.length,
      targetPackage: opts.targetPackage ?? "sutra-sdk",
    });
  }

  if (cleanup) rmSync(workRoot, { recursive: true, force: true });
  return {
    status: 0,
    phase: "import",
    combined: `OK: rehearsal install verified from local packs (${packed.tarballs.length} package(s))`,
  };
}

export function runRehearsalInstallFromRegistry(opts = {}) {
  const subjectId = opts.subjectId ?? "rehearsal-registry";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const registryUrl = opts.registryUrl ?? process.env.NPM_SCRATCH_REGISTRY_URL;
  const version = parseRehearsalVersion(
    opts.version ?? process.env.REHEARSAL_VERSION ?? process.env.GITHUB_REF_NAME,
  );
  const targetPackage = opts.targetPackage ?? "sutra-sdk";
  const workRoot =
    opts.workRoot ?? mkdtempSync(path.join(tmpdir(), "sutra-rehearsal-registry-"));
  const consumerDir = path.join(workRoot, "consumer");
  const cleanup = opts.cleanup !== false;
  const violations = [];

  if (!registryUrl) {
    violations.push({
      obligation: OBLIGATIONS.REGISTRY_URL_MISSING,
      detail: "NPM_SCRATCH_REGISTRY_URL is required for registry rehearsal install",
    });
  }
  if (!version) {
    violations.push({
      obligation: OBLIGATIONS.REGISTRY_VERSION_MISSING,
      detail: "REHEARSAL_VERSION or GITHUB_REF_NAME is required",
    });
  }
  if (violations.length > 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "registry",
        phase: "config",
        violationCount: violations.length,
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "config",
      violations,
      combined: violations.map((v) => `[${v.obligation}] ${v.detail}`).join("\n"),
    };
  }

  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    path.join(consumerDir, ".npmrc"),
    `@moolam:registry=${registryUrl}\n` +
      `//${registryUrl.replace(/^https?:\/\//, "")}/:_authToken=${process.env.NODE_AUTH_TOKEN ?? ""}\n`,
  );
  writeFileSync(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "rehearsal-registry-consumer",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(consumerDir, "probe.mjs"),
    `import * as sdk from "${targetPackage}";\n` +
      `if (sdk.${SDK_IMPORT_PROBE} == null) {\n` +
      `  throw new Error("missing ${SDK_IMPORT_PROBE} export");\n` +
      `}\n` +
      `console.log("ok:${SDK_IMPORT_PROBE}");\n`,
  );

  const add = spawnSync(
    "pnpm",
    ["add", `${targetPackage}@${version}`, "--ignore-workspace"],
    {
      cwd: consumerDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: {
        ...process.env,
        npm_config_registry: registryUrl,
      },
    },
  );
  if (add.status !== 0) {
    const detail = (add.stderr || add.stdout || "pnpm add failed").trim();
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "registry",
        phase: "install",
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "install",
      violations: [
        { obligation: OBLIGATIONS.CONSUMER_INSTALL_FAILED, detail },
      ],
      combined: `REHEARSAL_INSTALL_FAILED (registry install): ${detail}`,
    };
  }

  const probed = probeSdkImport(consumerDir);
  if (!probed.ok) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "registry",
        phase: "import",
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "import",
      violations: [{ obligation: probed.obligation, detail: probed.detail }],
      combined: `REHEARSAL_INSTALL_FAILED (registry import): [${probed.obligation}] ${probed.detail}`,
    };
  }

  const runUrl =
    opts.runUrl ??
    (process.env.GITHUB_SERVER_URL &&
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined);

  const recordPath =
    opts.recordPath ??
    path.join(REPO_ROOT, "artifacts", "rehearsal-release", "rehearsal-run.json");
  if (runUrl) {
    writeRehearsalRunRecord(recordPath, {
      runUrl,
      tag: process.env.GITHUB_REF_NAME ?? `v${version}`,
      version,
      registry: registryUrl,
      targetPackage,
      outcome: "ok",
      capturedAt: new Date().toISOString(),
    });
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      mode: "registry",
      phase: "import",
      targetPackage,
      version,
      runUrl,
    });
  }

  if (cleanup) rmSync(workRoot, { recursive: true, force: true });
  return {
    status: 0,
    phase: "import",
    runUrl,
    combined: `OK: rehearsal install verified from scratch registry (${targetPackage}@${version})`,
  };
}

function main() {
  const fromRegistry = process.argv.includes("--from-registry");
  const result = fromRegistry
    ? runRehearsalInstallFromRegistry()
    : runRehearsalInstallFromLocalPacks();

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
