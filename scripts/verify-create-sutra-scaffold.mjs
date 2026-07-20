/**
 * Verify scaffolded create-sutra output: install, typecheck, smoke.
 *
 * Uses packed local @moolam/* tarballs (same pattern as rehearsal install)
 * so generated package.json semver deps never use workspace: protocol.
 *
 * Usage (repo root):
 *   node scripts/verify-create-sutra-scaffold.mjs
 *   node scripts/verify-create-sutra-scaffold.mjs --matrix
 *   pnpm create-sutra:verify
 *   pnpm create-sutra:verify:matrix
 */

import { execSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCreateSutraScaffold } from "../tools/create-sutra/lib/scaffold.mjs";
import {
  buildConsumerDependenciesFromTarballs,
  buildPnpmOverridesFromTarballs,
  packPublicPackages,
} from "./verify-rehearsal-install.mjs";
import { packageDirForName } from "./check-changeset-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

/** Packages required for CognitiveCore smoke via sutra-sdk. */
export const SCAFFOLD_SDK_GRAPH = Object.freeze([
  "@moolam/contracts",
  "@moolam/observability",
  "@moolam/cognitive-core",
  "@moolam/telemetry",
  "@moolam/sync-protocol",
  "@moolam/runtime",
  "@moolam/edge-agent",
  "sutra-sdk",
]);

export const OBLIGATIONS = Object.freeze({
  SCAFFOLD_FAILED: "create_sutra.verify.scaffold_failed",
  PACK_FAILED: "create_sutra.verify.pack_failed",
  INSTALL_FAILED: "create_sutra.verify.install_failed",
  TYPECHECK_FAILED: "create_sutra.verify.typecheck_failed",
  SMOKE_FAILED: "create_sutra.verify.smoke_failed",
  SUBJECT_ISOLATION: "create_sutra.verify.subject_isolation",
  MATRIX_CELL_FAILED: "create_sutra.verify.matrix_cell_failed",
  MATRIX_EMPTY: "create_sutra.verify.matrix_empty",
});

/**
 * CI matrix cells — memory storage only so smoke needs no native addons.
 * Covers every domain pack × both transports (offline + http stubs).
 */
export const SCAFFOLD_VERIFY_MATRIX = Object.freeze([
  {
    id: "teacher-memory-offline",
    domainPack: "teacher",
    storageDriver: "memory",
    transport: "offline",
  },
  {
    id: "doctor-memory-http",
    domainPack: "doctor",
    storageDriver: "memory",
    transport: "http",
  },
  {
    id: "lawyer-memory-offline",
    domainPack: "lawyer",
    storageDriver: "memory",
    transport: "offline",
  },
  {
    id: "custom-memory-http",
    domainPack: "custom",
    storageDriver: "memory",
    transport: "http",
  },
]);

/** Pinned toolchain versions — must match .github/workflows/ci.yml. */
export const CI_PINNED = Object.freeze({
  pnpm: "10.30.3",
  nodeMajor: 22,
});

export function matrixCellSubjectId(cell) {
  return `create-sutra-matrix-${cell.id}`;
}

export function formatMatrixCellLabel(cell) {
  return `${cell.id} (domain=${cell.domainPack}, storage=${cell.storageDriver}, transport=${cell.transport})`;
}

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "create_sutra.verify", ...event })}\n`,
  );
}

export function filterPackagesForSdkGraph(allPackages) {
  const wanted = new Set(SCAFFOLD_SDK_GRAPH);
  return allPackages.filter((pkg) => wanted.has(pkg.name));
}

export function resolvePackagesForPack(opts = {}) {
  if (opts.packages) {
    // Explicit package list (prove seeds) — do not filter away.
    return opts.packages;
  }
  return filterPackagesForSdkGraph(
    SCAFFOLD_SDK_GRAPH.map((name) => {
      const dir = packageDirForName(name, REPO_ROOT);
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      return { name, dir, manifest };
    }),
  );
}

export function wireScaffoldConsumerDeps(consumerDir, tarballs) {
  const deps = buildConsumerDependenciesFromTarballs(tarballs);
  const pkgPath = path.join(consumerDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies = {
    ...pkg.dependencies,
    "sutra-sdk": deps["sutra-sdk"],
  };
  pkg.pnpm = {
    overrides: buildPnpmOverridesFromTarballs(tarballs),
  };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

export function runCreateSutraScaffoldVerify(opts = {}) {
  const subjectId = opts.subjectId ?? "create-sutra-verify";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const workRoot =
    opts.workRoot ?? mkdtempSync(path.join(tmpdir(), "sutra-create-sutra-verify-"));
  const packDir = path.join(workRoot, "packs");
  const consumerDir = opts.consumerDir ?? path.join(workRoot, "consumer");
  const cleanup = opts.cleanup !== false;
  const ownsWorkRoot = !opts.workRoot;

  if (!opts.skipBuild) {
    const filters = SCAFFOLD_SDK_GRAPH.map((name) => `--filter ${name}`).join(" ");
    try {
      execSync(`pnpm ${filters} build`, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      });
    } catch (err) {
      const detail =
        err && typeof err === "object" && "stderr" in err
          ? String(err.stderr || err.stdout || err).trim()
          : String(err);
      if (emitEvents) {
        emit({
          outcome: "fail",
          subjectId,
          deviceId,
          phase: "build",
        });
      }
      if (cleanup && ownsWorkRoot) rmSync(workRoot, { recursive: true, force: true });
      return {
        status: 1,
        phase: "build",
        violations: [{ obligation: OBLIGATIONS.PACK_FAILED, detail }],
        combined: `CREATE_SUTRA_VERIFY_FAILED (build): ${detail}`,
      };
    }
  }

  let tarballs = opts.tarballs;
  if (!tarballs) {
    const packed = packPublicPackages(packDir, resolvePackagesForPack(opts));
    if (packed.violations.length > 0) {
      const combined = packed.violations
        .map((v) => `[${v.obligation}] ${v.detail}`)
        .join("\n");
      if (emitEvents) {
        emit({
          outcome: "fail",
          subjectId,
          deviceId,
          phase: "pack",
          violationCount: packed.violations.length,
        });
      }
      if (cleanup && ownsWorkRoot) rmSync(workRoot, { recursive: true, force: true });
      return {
        status: 1,
        phase: "pack",
        violations: packed.violations,
        combined: `CREATE_SUTRA_VERIFY_FAILED (pack):\n${combined}`,
      };
    }
    tarballs = packed.tarballs;
  }

  const scaffold = runCreateSutraScaffold({
    projectName: opts.projectName ?? "verify-companion",
    domainPack: opts.domainPack ?? "teacher",
    storageDriver: opts.storageDriver ?? "memory",
    transport: opts.transport ?? "offline",
    outDir: consumerDir,
    overwrite: true,
    emitEvents: false,
  });
  if (scaffold.status !== 0) {
    const detail = scaffold.combined || "scaffold failed";
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "scaffold",
      });
    }
    if (cleanup && ownsWorkRoot) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "scaffold",
      violations: [
        {
          obligation: OBLIGATIONS.SCAFFOLD_FAILED,
          detail,
        },
      ],
      combined: `CREATE_SUTRA_VERIFY_FAILED (scaffold): ${detail}`,
    };
  }

  wireScaffoldConsumerDeps(consumerDir, tarballs);

  const install = spawnSync("pnpm", ["install", "--ignore-workspace"], {
    cwd: consumerDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  if (install.status !== 0) {
    const detail = (install.stderr || install.stdout || "pnpm install failed").trim();
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "install",
      });
    }
    if (cleanup && ownsWorkRoot) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "install",
      violations: [{ obligation: OBLIGATIONS.INSTALL_FAILED, detail }],
      combined: `CREATE_SUTRA_VERIFY_FAILED (install): ${detail}`,
    };
  }

  const typecheck = spawnSync("pnpm", ["run", "typecheck"], {
    cwd: consumerDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  if (typecheck.status !== 0) {
    const detail = (typecheck.stderr || typecheck.stdout || "tsc failed").trim();
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "typecheck",
      });
    }
    if (cleanup && ownsWorkRoot) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "typecheck",
      violations: [{ obligation: OBLIGATIONS.TYPECHECK_FAILED, detail }],
      combined: `CREATE_SUTRA_VERIFY_FAILED (typecheck): ${detail}`,
    };
  }

  const smoke = spawnSync("pnpm", ["run", "smoke"], {
    cwd: consumerDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: {
      ...process.env,
      SUTRA_SUBJECT_ID: subjectId,
      SUTRA_DEVICE_ID: deviceId,
    },
  });
  if (smoke.status !== 0) {
    const detail = (smoke.stderr || smoke.stdout || "smoke failed").trim();
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "smoke",
      });
    }
    if (cleanup && ownsWorkRoot) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "smoke",
      violations: [{ obligation: OBLIGATIONS.SMOKE_FAILED, detail }],
      combined: `CREATE_SUTRA_VERIFY_FAILED (smoke): ${detail}`,
    };
  }

  if (!String(smoke.stdout).includes("smoke OK")) {
    if (cleanup && ownsWorkRoot) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "smoke",
      violations: [
        {
          obligation: OBLIGATIONS.SMOKE_FAILED,
          detail: "smoke script did not emit success marker",
        },
      ],
      combined: "CREATE_SUTRA_VERIFY_FAILED (smoke): missing success marker",
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "smoke",
      projectName: scaffold.projectName,
      domainPack: opts.domainPack ?? "teacher",
      storageDriver: opts.storageDriver ?? "memory",
      transport: opts.transport ?? "offline",
    });
  }

  if (cleanup && ownsWorkRoot) rmSync(workRoot, { recursive: true, force: true });
  return {
    status: 0,
    phase: "smoke",
    tarballs,
    combined: "OK: scaffolded project installed, typechecked, and passed smoke turn",
  };
}

/**
 * Pack once, then scaffold → install → typecheck → smoke for every matrix cell.
 * Failures print the cell id and the underlying phase detail (never silent).
 */
export function runCreateSutraScaffoldVerifyMatrix(opts = {}) {
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const cells = opts.matrix ?? SCAFFOLD_VERIFY_MATRIX;
  const workRoot =
    opts.workRoot ?? mkdtempSync(path.join(tmpdir(), "sutra-create-sutra-matrix-"));
  const cleanup = opts.cleanup !== false;

  if (!Array.isArray(cells) || cells.length === 0) {
    return {
      status: 1,
      phase: "matrix",
      violations: [
        {
          obligation: OBLIGATIONS.MATRIX_EMPTY,
          detail: "scaffold verify matrix has no cells",
        },
      ],
      combined: "CREATE_SUTRA_VERIFY_FAILED (matrix): empty matrix",
    };
  }

  if (!opts.skipBuild) {
    const filters = SCAFFOLD_SDK_GRAPH.map((name) => `--filter ${name}`).join(" ");
    try {
      execSync(`pnpm ${filters} build`, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      });
    } catch (err) {
      const detail =
        err && typeof err === "object" && "stderr" in err
          ? String(err.stderr || err.stdout || err).trim()
          : String(err);
      if (cleanup) rmSync(workRoot, { recursive: true, force: true });
      return {
        status: 1,
        phase: "build",
        violations: [{ obligation: OBLIGATIONS.PACK_FAILED, detail }],
        combined: `CREATE_SUTRA_VERIFY_FAILED (build): ${detail}`,
      };
    }
  }

  const packDir = path.join(workRoot, "packs");
  const packed = packPublicPackages(packDir, resolvePackagesForPack(opts));
  if (packed.violations.length > 0) {
    const combined = packed.violations
      .map((v) => `[${v.obligation}] ${v.detail}`)
      .join("\n");
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId: "create-sutra-matrix",
        deviceId,
        phase: "pack",
        violationCount: packed.violations.length,
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "pack",
      violations: packed.violations,
      combined: `CREATE_SUTRA_VERIFY_FAILED (pack):\n${combined}`,
    };
  }

  const passed = [];
  for (const cell of cells) {
    const subjectId = opts.subjectId ?? matrixCellSubjectId(cell);
    const consumerDir = path.join(workRoot, "cells", cell.id);
    const cellResult = runCreateSutraScaffoldVerify({
      projectName: `verify-${cell.id}`,
      domainPack: cell.domainPack,
      storageDriver: cell.storageDriver,
      transport: cell.transport,
      subjectId,
      deviceId,
      workRoot,
      consumerDir,
      tarballs: packed.tarballs,
      skipBuild: true,
      cleanup: false,
      emitEvents: false,
    });

    if (cellResult.status !== 0) {
      const label = formatMatrixCellLabel(cell);
      const detail = cellResult.combined || "cell failed without detail";
      if (emitEvents) {
        emit({
          outcome: "fail",
          subjectId,
          deviceId,
          phase: cellResult.phase ?? "matrix",
          matrixCell: cell.id,
        });
      }
      if (cleanup) rmSync(workRoot, { recursive: true, force: true });
      return {
        status: 1,
        phase: cellResult.phase ?? "matrix",
        matrixCell: cell.id,
        violations: [
          {
            obligation: OBLIGATIONS.MATRIX_CELL_FAILED,
            detail: `${label}: ${detail}`,
          },
          ...(cellResult.violations ?? []),
        ],
        combined:
          `CREATE_SUTRA_VERIFY_FAILED (matrix cell ${cell.id}):\n` +
          `${label}\n${detail}`,
      };
    }

    passed.push(cell.id);
    if (emitEvents) {
      emit({
        outcome: "ok",
        subjectId,
        deviceId,
        phase: "smoke",
        matrixCell: cell.id,
      });
    }
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId: "create-sutra-matrix",
      deviceId,
      phase: "matrix",
      cellCount: passed.length,
    });
  }

  if (cleanup) rmSync(workRoot, { recursive: true, force: true });
  return {
    status: 0,
    phase: "matrix",
    cells: passed,
    combined: `OK: scaffold matrix passed (${passed.length} cell(s): ${passed.join(", ")})`,
  };
}

function main() {
  const matrix = process.argv.includes("--matrix");
  const result = matrix
    ? runCreateSutraScaffoldVerifyMatrix()
    : runCreateSutraScaffoldVerify();
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
