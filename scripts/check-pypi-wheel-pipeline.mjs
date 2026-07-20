/**
 * PyPI wheel pipeline gate for sutra-sdk.
 *
 * Validates pyproject.toml publish metadata + hatchling config, then runs
 * `python -m build` and `twine check` before any registry upload.
 *
 * Usage (repo root):
 *   node scripts/check-pypi-wheel-pipeline.mjs
 *   node scripts/check-pypi-wheel-pipeline.mjs --metadata-only
 *   pnpm pypi:wheel
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const ORCHESTRATOR_ROOT = path.join(REPO_ROOT, "packages", "cloud-orchestrator");
export const PYPROJECT_PATH = path.join(ORCHESTRATOR_ROOT, "pyproject.toml");

export const PACKAGE_NAME = "sutra-sdk";
export const REQUIRED_URLS = Object.freeze(["Homepage", "Repository", "Documentation"]);

export const OBLIGATIONS = Object.freeze({
  PYPROJECT_MISSING: "pypi.pyproject.missing",
  PACKAGE_NAME: "pypi.project.name",
  README_MISSING: "pypi.project.readme",
  URLS_MISSING: "pypi.project.urls",
  BUILD_BACKEND: "pypi.build.backend",
  HATCH_PACKAGES: "pypi.hatch.packages",
  BUILD_FAILED: "pypi.build.failed",
  TWINE_FAILED: "pypi.twine.failed",
  DIST_MISSING: "pypi.dist.missing",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "pypi.wheel.pipeline.gate", ...event })}\n`,
  );
}

export function loadPyproject(pyprojectPath = PYPROJECT_PATH) {
  if (!existsSync(pyprojectPath)) {
    throw new Error(`PYPROJECT_MISSING:${pyprojectPath}`);
  }
  return readFileSync(pyprojectPath, "utf8");
}

export function parseProjectUrls(pyprojectText) {
  const match = pyprojectText.match(/\[project\.urls\]([\s\S]*?)(?=\n\[|$)/);
  if (!match) {
    return {};
  }
  const urls = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^\s*([A-Za-z]+)\s*=\s*"([^"]+)"/);
    if (kv) {
      urls[kv[1]] = kv[2];
    }
  }
  return urls;
}

export function validatePyprojectMetadata(pyprojectText) {
  const violations = [];

  const nameMatch = pyprojectText.match(/^name\s*=\s*"([^"]+)"/m);
  if (!nameMatch || nameMatch[1] !== PACKAGE_NAME) {
    violations.push({
      obligation: OBLIGATIONS.PACKAGE_NAME,
      detail: `project.name must be "${PACKAGE_NAME}"`,
    });
  }

  if (!/^readme\s*=\s*"README\.md"/m.test(pyprojectText)) {
    violations.push({
      obligation: OBLIGATIONS.README_MISSING,
      detail: 'project.readme must be "README.md"',
    });
  }

  const urls = parseProjectUrls(pyprojectText);
  for (const key of REQUIRED_URLS) {
    if (!urls[key]) {
      violations.push({
        obligation: OBLIGATIONS.URLS_MISSING,
        detail: `project.urls.${key} is required`,
      });
    }
  }

  if (!/build-backend\s*=\s*"hatchling\.build"/m.test(pyprojectText)) {
    violations.push({
      obligation: OBLIGATIONS.BUILD_BACKEND,
      detail: 'build-system.build-backend must be "hatchling.build"',
    });
  }

  if (!/packages\s*=\s*\["src\/sutra_orchestrator"\]/m.test(pyprojectText)) {
    violations.push({
      obligation: OBLIGATIONS.HATCH_PACKAGES,
      detail: 'tool.hatch.build.targets.wheel.packages must include ["src/sutra_orchestrator"]',
    });
  }

  return {
    status: violations.length === 0 ? 0 : 1,
    violations,
    urls,
  };
}

export function runPythonBuild(distDir) {
  rmSync(distDir, { recursive: true, force: true });
  const result = spawnSync("python", ["-m", "build", "--outdir", distDir], {
    cwd: ORCHESTRATOR_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      detail: (result.stderr || result.stdout || "python -m build failed").trim(),
    };
  }
  return { ok: true, stdout: result.stdout };
}

export function runTwineCheck(distDir) {
  if (!existsSync(distDir)) {
    return {
      ok: false,
      obligation: OBLIGATIONS.DIST_MISSING,
      detail: `dist output missing: ${distDir}`,
    };
  }

  const result = spawnSync("python", ["-m", "twine", "check", `${distDir}/*`], {
    cwd: ORCHESTRATOR_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      obligation: OBLIGATIONS.TWINE_FAILED,
      detail: (result.stderr || result.stdout || "twine check failed").trim(),
    };
  }
  return { ok: true, stdout: result.stdout };
}

export function runPypiWheelPipelineGate(opts = {}) {
  const subjectId = opts.subjectId ?? "ci-pypi-wheel";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const metadataOnly = opts.metadataOnly === true;
  const pyprojectText = opts.pyprojectText ?? loadPyproject(opts.pyprojectPath);

  const metadata = validatePyprojectMetadata(pyprojectText);
  if (metadata.status !== 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "metadata",
        violationCount: metadata.violations.length,
      });
    }
    return {
      status: 1,
      phase: "metadata",
      violations: metadata.violations,
      combined: formatViolations(metadata.violations),
    };
  }

  if (metadataOnly) {
    if (emitEvents) {
      emit({
        outcome: "ok",
        subjectId,
        deviceId,
        phase: "metadata",
      });
    }
    return {
      status: 0,
      phase: "metadata",
      combined: "OK: sutra-sdk pyproject metadata is publish-ready",
    };
  }

  const distDir = path.join(ORCHESTRATOR_ROOT, "dist");
  const built = runPythonBuild(distDir);
  if (!built.ok) {
    const violation = {
      obligation: OBLIGATIONS.BUILD_FAILED,
      detail: built.detail,
    };
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "build",
      });
    }
    return {
      status: 1,
      phase: "build",
      violations: [violation],
      combined: formatViolations([violation]),
    };
  }

  const checked = runTwineCheck(distDir);
  if (!checked.ok) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "twine",
        obligation: checked.obligation,
      });
    }
    return {
      status: 1,
      phase: "twine",
      violations: [{ obligation: checked.obligation, detail: checked.detail }],
      combined: `PYPI_WHEEL_FAILED: [${checked.obligation}] ${checked.detail}`,
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "twine",
      package: PACKAGE_NAME,
    });
  }

  return {
    status: 0,
    phase: "twine",
    combined: "OK: python -m build and twine check passed for sutra-sdk",
  };
}

function formatViolations(violations) {
  return `PYPI_WHEEL_FAILED (${violations.length} violation(s)):\n${violations
    .map((v) => `[${v.obligation}] ${v.detail}`)
    .join("\n")}`;
}

function main() {
  const metadataOnly = process.argv.includes("--metadata-only");
  const result = runPypiWheelPipelineGate({ metadataOnly });
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
