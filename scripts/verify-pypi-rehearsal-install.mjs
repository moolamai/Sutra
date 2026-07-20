/**
 * Rehearsal install verification for sutra-sdk on TestPyPI.
 *
 * Simulates a clean venv installing the published wheel from TestPyPI
 * (or from a local dist/ after build for CI without registry credentials).
 *
 * Usage (repo root):
 *   node scripts/verify-pypi-rehearsal-install.mjs --from-local-dist
 *   node scripts/verify-pypi-rehearsal-install.mjs --from-testpypi
 *   pnpm pypi:rehearsal:verify
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORCHESTRATOR_ROOT,
  PACKAGE_NAME,
  loadPyproject,
} from "./check-pypi-wheel-pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const DIST_DIR = path.join(ORCHESTRATOR_ROOT, "dist");

export const PYPI_TEST_SIMPLE_URL = "https://test.pypi.org/simple/";
export const PYPI_SIMPLE_URL = "https://pypi.org/simple/";

export const IMPORT_PROBE = "PROTOCOL_VERSION";

export const OBLIGATIONS = Object.freeze({
  VERSION_MISSING: "pypi.rehearsal.version_missing",
  DIST_MISSING: "pypi.rehearsal.dist_missing",
  WHEEL_MISSING: "pypi.rehearsal.wheel_missing",
  VENV_FAILED: "pypi.rehearsal.venv_failed",
  INSTALL_FAILED: "pypi.rehearsal.install_failed",
  IMPORT_FAILED: "pypi.rehearsal.import_failed",
  SURFACE_MISSING: "pypi.rehearsal.surface_missing",
  INDEX_URL_MISSING: "pypi.rehearsal.index_url_missing",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "pypi.rehearsal.install.verify", ...event })}\n`,
  );
}

export function parsePackageVersion(pyprojectText = loadPyproject()) {
  const match = pyprojectText.match(/^version\s*=\s*"([^"]+)"/m);
  return match?.[1] ?? "";
}

export function parseRehearsalVersion(tagOrVersion) {
  const raw = String(tagOrVersion ?? "").trim();
  if (!raw) return "";
  return raw.startsWith("v") ? raw.slice(1) : raw;
}

export function resolveInstallVersion(opts = {}) {
  return (
    opts.version ??
    process.env.PYPI_PACKAGE_VERSION ??
    parsePackageVersion(opts.pyprojectText) ??
    parseRehearsalVersion(process.env.REHEARSAL_VERSION ?? process.env.GITHUB_REF_NAME)
  );
}

export function findLatestWheel(distDir = DIST_DIR) {
  if (!existsSync(distDir)) {
    return null;
  }
  const wheels = readdirSync(distDir).filter((name) => name.endsWith(".whl"));
  return wheels.sort().at(-1) ?? null;
}

export function createCleanVenv(venvDir) {
  mkdirSync(path.dirname(venvDir), { recursive: true });
  const result = spawnSync("python", ["-m", "venv", venvDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      detail: (result.stderr || result.stdout || "python -m venv failed").trim(),
    };
  }
  return { ok: true };
}

function venvPython(venvDir) {
  const bin = process.platform === "win32" ? "Scripts" : "bin";
  const exe = process.platform === "win32" ? "python.exe" : "python";
  return path.join(venvDir, bin, exe);
}

export function pipInstallInVenv(venvDir, args) {
  const python = venvPython(venvDir);
  const result = spawnSync(python, ["-m", "pip", "install", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      detail: (result.stderr || result.stdout || "pip install failed").trim(),
    };
  }
  return { ok: true };
}

export function probePackageImport(venvDir, workRoot) {
  const python = venvPython(venvDir);
  const probePath = path.join(workRoot, "probe_import.py");
  writeFileSync(
    probePath,
    [
      "import sutra_orchestrator",
      `assert getattr(sutra_orchestrator, "${IMPORT_PROBE}", None)`,
      `print("ok:${IMPORT_PROBE}")`,
      "",
    ].join("\n"),
  );
  const result = spawnSync(python, [probePath], {
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
  if (!String(result.stdout).includes(`ok:${IMPORT_PROBE}`)) {
    return {
      ok: false,
      obligation: OBLIGATIONS.SURFACE_MISSING,
      detail: `${IMPORT_PROBE} surface probe did not succeed`,
    };
  }
  return { ok: true };
}

export function writePypiRehearsalRunRecord(recordPath, record) {
  mkdirSync(path.dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

export function runPypiRehearsalInstallFromLocalDist(opts = {}) {
  const subjectId = opts.subjectId ?? "pypi-rehearsal-local-dist";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const workRoot =
    opts.workRoot ?? mkdtempSync(path.join(tmpdir(), "sutra-pypi-rehearsal-"));
  const venvDir = path.join(workRoot, "venv");
  const cleanup = opts.cleanup !== false;
  const distDir = opts.distDir ?? DIST_DIR;

  const wheel = findLatestWheel(distDir);
  if (!wheel) {
    const violation = {
      obligation: OBLIGATIONS.WHEEL_MISSING,
      detail: `no wheel in ${distDir}`,
    };
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "local-dist",
        phase: "dist",
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "dist",
      violations: [violation],
      combined: `PYPI_REHEARSAL_FAILED: [${violation.obligation}] ${violation.detail}`,
    };
  }

  const venv = createCleanVenv(venvDir);
  if (!venv.ok) {
    const violation = {
      obligation: OBLIGATIONS.VENV_FAILED,
      detail: venv.detail,
    };
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "local-dist",
        phase: "venv",
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "venv",
      violations: [violation],
      combined: `PYPI_REHEARSAL_FAILED: [${violation.obligation}] ${violation.detail}`,
    };
  }

  const wheelPath = path.join(distDir, wheel).replace(/\\/g, "/");
  const installed = pipInstallInVenv(venvDir, [wheelPath]);
  if (!installed.ok) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "local-dist",
        phase: "install",
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "install",
      violations: [
        { obligation: OBLIGATIONS.INSTALL_FAILED, detail: installed.detail },
      ],
      combined: `PYPI_REHEARSAL_FAILED (install): ${installed.detail}`,
    };
  }

  const probed = probePackageImport(venvDir, workRoot);
  if (!probed.ok) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "local-dist",
        phase: "import",
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "import",
      violations: [{ obligation: probed.obligation, detail: probed.detail }],
      combined: `PYPI_REHEARSAL_FAILED (import): [${probed.obligation}] ${probed.detail}`,
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      mode: "local-dist",
      phase: "import",
      package: PACKAGE_NAME,
      wheel,
    });
  }

  if (cleanup) rmSync(workRoot, { recursive: true, force: true });
  return {
    status: 0,
    phase: "import",
    combined: `OK: rehearsal install verified from local wheel (${wheel})`,
  };
}

export function runPypiRehearsalInstallFromTestPyPI(opts = {}) {
  const subjectId = opts.subjectId ?? "pypi-rehearsal-testpypi";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const workRoot =
    opts.workRoot ?? mkdtempSync(path.join(tmpdir(), "sutra-pypi-rehearsal-"));
  const venvDir = path.join(workRoot, "venv");
  const cleanup = opts.cleanup !== false;
  const indexUrl =
    opts.indexUrl ?? process.env.PYPI_TEST_SIMPLE_URL ?? PYPI_TEST_SIMPLE_URL;
  const version = resolveInstallVersion(opts);
  const violations = [];

  if (!indexUrl) {
    violations.push({
      obligation: OBLIGATIONS.INDEX_URL_MISSING,
      detail: "PYPI_TEST_SIMPLE_URL is required for TestPyPI rehearsal install",
    });
  }
  if (!version) {
    violations.push({
      obligation: OBLIGATIONS.VERSION_MISSING,
      detail: "package version is required (pyproject.toml or REHEARSAL_VERSION)",
    });
  }
  if (violations.length > 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "testpypi",
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

  const venv = createCleanVenv(venvDir);
  if (!venv.ok) {
    const violation = {
      obligation: OBLIGATIONS.VENV_FAILED,
      detail: venv.detail,
    };
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "testpypi",
        phase: "venv",
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "venv",
      violations: [violation],
      combined: `PYPI_REHEARSAL_FAILED: [${violation.obligation}] ${violation.detail}`,
    };
  }

  const installed = pipInstallInVenv(venvDir, [
    "--index-url",
    indexUrl,
    "--extra-index-url",
    PYPI_SIMPLE_URL,
    `${PACKAGE_NAME}==${version}`,
  ]);
  if (!installed.ok) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "testpypi",
        phase: "install",
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "install",
      violations: [
        { obligation: OBLIGATIONS.INSTALL_FAILED, detail: installed.detail },
      ],
      combined: `PYPI_REHEARSAL_FAILED (install): ${installed.detail}`,
    };
  }

  const probed = probePackageImport(venvDir, workRoot);
  if (!probed.ok) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        mode: "testpypi",
        phase: "import",
      });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "import",
      violations: [{ obligation: probed.obligation, detail: probed.detail }],
      combined: `PYPI_REHEARSAL_FAILED (import): [${probed.obligation}] ${probed.detail}`,
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
    path.join(REPO_ROOT, "artifacts", "pypi-rehearsal-release", "rehearsal-run.json");
  if (runUrl) {
    writePypiRehearsalRunRecord(recordPath, {
      runUrl,
      tag: process.env.GITHUB_REF_NAME ?? `v${version}`,
      version,
      indexUrl,
      package: PACKAGE_NAME,
      outcome: "ok",
      capturedAt: new Date().toISOString(),
    });
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      mode: "testpypi",
      phase: "import",
      package: PACKAGE_NAME,
      version,
      runUrl,
    });
  }

  if (cleanup) rmSync(workRoot, { recursive: true, force: true });
  return {
    status: 0,
    phase: "import",
    runUrl,
    combined: `OK: rehearsal install verified from TestPyPI (${PACKAGE_NAME}==${version})`,
  };
}

function main() {
  const fromTestPyPI = process.argv.includes("--from-testpypi");
  const result = fromTestPyPI
    ? runPypiRehearsalInstallFromTestPyPI()
    : runPypiRehearsalInstallFromLocalDist();

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
