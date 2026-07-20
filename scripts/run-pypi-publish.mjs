/**
 * Gated twine upload for sutra-sdk.
 *
 * Always runs `python -m build` and `twine check` before any upload.
 * TestPyPI is the default registry until P7; production PyPI requires
 * PYPI_ALLOW_PROD_PUBLISH=true.
 *
 * Usage (repo root):
 *   node scripts/run-pypi-publish.mjs
 *   node scripts/run-pypi-publish.mjs --dry-run
 *   pnpm pypi:publish
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORCHESTRATOR_ROOT,
  runPypiWheelPipelineGate,
} from "./check-pypi-wheel-pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const DIST_DIR = path.join(ORCHESTRATOR_ROOT, "dist");

export const PYPI_TEST_UPLOAD_URL = "https://test.pypi.org/legacy/";
export const PYPI_PROD_UPLOAD_URL = "https://upload.pypi.org/legacy/";

export const OBLIGATIONS = Object.freeze({
  PROD_WITHOUT_FLAG: "pypi.publish.prod_without_flag",
  CREDENTIALS_MISSING: "pypi.publish.credentials_missing",
  TWINE_UPLOAD_FAILED: "pypi.publish.upload_failed",
  WHEEL_GATE_FAILED: "pypi.publish.wheel_gate_failed",
});

function emit(event) {
  process.stdout.write(`${JSON.stringify({ event: "pypi.publish", ...event })}\n`);
}

export function resolvePyPiPublishTarget(opts = {}) {
  const dryRun = opts.dryRun === true;
  const publishEnabled = opts.publishEnabled === true;
  const refName = String(opts.refName ?? process.env.GITHUB_REF_NAME ?? "");
  const allowProd =
    opts.allowProd === true ||
    process.env.PYPI_ALLOW_PROD_PUBLISH === "true" ||
    String(process.env.allow_prod_publish ?? "").toLowerCase() === "true";

  if (dryRun || !publishEnabled) {
    return {
      upload: false,
      repositoryUrl: PYPI_TEST_UPLOAD_URL,
      registry: "testpypi",
      dryRun: true,
      reason: dryRun ? "dry-run" : "publish-disabled",
    };
  }

  const isRehearsal = refName.includes("-rehearsal.") || refName.includes("-rc.");

  if (allowProd && !isRehearsal) {
    return {
      upload: true,
      repositoryUrl:
        process.env.PYPI_PROD_UPLOAD_URL?.trim() || PYPI_PROD_UPLOAD_URL,
      registry: "pypi",
      dryRun: false,
      reason: "production",
    };
  }

  if (!allowProd && !isRehearsal && opts.requestedRegistry === "pypi") {
    return {
      upload: false,
      violation: {
        obligation: OBLIGATIONS.PROD_WITHOUT_FLAG,
        detail:
          "production PyPI upload requires PYPI_ALLOW_PROD_PUBLISH=true until P7 gate",
      },
    };
  }

  return {
    upload: true,
    repositoryUrl:
      process.env.PYPI_TEST_UPLOAD_URL?.trim() || PYPI_TEST_UPLOAD_URL,
    registry: "testpypi",
    dryRun: false,
    reason: isRehearsal ? "rehearsal" : "testpypi-default",
  };
}

export function resolveTwineCredentials(registry) {
  if (registry === "pypi") {
    const token = process.env.PYPI_API_TOKEN?.trim();
    if (!token) {
      return {
        ok: false,
        obligation: OBLIGATIONS.CREDENTIALS_MISSING,
        detail: "PYPI_API_TOKEN is required for production PyPI upload",
      };
    }
    return { ok: true, username: "__token__", password: token };
  }

  const token = process.env.TEST_PYPI_API_TOKEN?.trim();
  if (!token) {
    return {
      ok: false,
      obligation: OBLIGATIONS.CREDENTIALS_MISSING,
      detail: "TEST_PYPI_API_TOKEN is required for TestPyPI upload",
    };
  }
  return { ok: true, username: "__token__", password: token };
}

export function runTwineUpload(distDir, target, creds) {
  const result = spawnSync(
    "python",
    [
      "-m",
      "twine",
      "upload",
      "--non-interactive",
      "--skip-existing",
      "--repository-url",
      target.repositoryUrl,
      `${distDir}/*`,
    ],
    {
      cwd: ORCHESTRATOR_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: {
        ...process.env,
        TWINE_USERNAME: creds.username,
        TWINE_PASSWORD: creds.password,
      },
    },
  );

  if (result.status !== 0) {
    return {
      ok: false,
      detail: (result.stderr || result.stdout || "twine upload failed").trim(),
    };
  }
  return { ok: true, stdout: result.stdout };
}

export function runPypiPublish(opts = {}) {
  const subjectId = opts.subjectId ?? "pypi-publish";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const dryRun =
    opts.dryRun === true ||
    process.argv.includes("--dry-run") ||
    process.env.PYPI_PUBLISH_DRY_RUN === "true";
  const publishEnabled =
    opts.publishEnabled === true || process.env.PYPI_PUBLISH_ENABLED === "true";

  const gate = runPypiWheelPipelineGate({
    subjectId,
    deviceId,
    emitEvents: false,
    pyprojectText: opts.pyprojectText,
    pyprojectPath: opts.pyprojectPath,
  });
  if (gate.status !== 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "wheel-gate",
        violationCount: gate.violations?.length ?? 1,
      });
    }
    return {
      status: 1,
      phase: "wheel-gate",
      combined: gate.combined ?? "PYPI_PUBLISH_FAILED: wheel pipeline gate failed",
      violations: gate.violations,
    };
  }

  const target = resolvePyPiPublishTarget({
    dryRun,
    publishEnabled,
    refName: opts.refName,
    allowProd: opts.allowProd,
    requestedRegistry: opts.requestedRegistry,
  });

  if (target.violation) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "policy",
        obligation: target.violation.obligation,
      });
    }
    return {
      status: 1,
      phase: "policy",
      violations: [target.violation],
      combined: `PYPI_PUBLISH_FAILED: [${target.violation.obligation}] ${target.violation.detail}`,
    };
  }

  if (!target.upload) {
    if (emitEvents) {
      emit({
        outcome: "ok",
        subjectId,
        deviceId,
        phase: "dry-run",
        reason: target.reason,
        registry: target.registry,
      });
    }
    return {
      status: 0,
      phase: "dry-run",
      combined: `OK: sutra-sdk built and twine-checked (${target.reason})`,
      target,
    };
  }

  const creds = resolveTwineCredentials(target.registry);
  if (!creds.ok) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "credentials",
        obligation: creds.obligation,
      });
    }
    return {
      status: 1,
      phase: "credentials",
      violations: [{ obligation: creds.obligation, detail: creds.detail }],
      combined: `PYPI_PUBLISH_FAILED: [${creds.obligation}] ${creds.detail}`,
    };
  }

  const uploaded = runTwineUpload(DIST_DIR, target, creds);
  if (!uploaded.ok) {
    const violation = {
      obligation: OBLIGATIONS.TWINE_UPLOAD_FAILED,
      detail: uploaded.detail,
    };
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "upload",
        registry: target.registry,
      });
    }
    return {
      status: 1,
      phase: "upload",
      violations: [violation],
      combined: `PYPI_PUBLISH_FAILED: [${violation.obligation}] ${violation.detail}`,
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "upload",
      registry: target.registry,
      reason: target.reason,
    });
  }

  return {
    status: 0,
    phase: "upload",
    combined: `OK: sutra-sdk uploaded to ${target.registry}`,
    target,
  };
}

function main() {
  const result = runPypiPublish();
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
