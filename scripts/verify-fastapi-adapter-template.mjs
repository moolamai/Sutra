/**
 * Verify templates/fastapi-adapter: Python smoke + TS SyncTransport typecheck/smoke.
 *
 * Usage (repo root):
 *   node scripts/verify-fastapi-adapter-template.mjs
 *   pnpm integration:fastapi-adapter:verify
 */

import { execSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildConsumerDependenciesFromTarballs,
  buildPnpmOverridesFromTarballs,
  packPublicPackages,
} from "./verify-rehearsal-install.mjs";
import {
  SCAFFOLD_SDK_GRAPH,
  resolvePackagesForPack,
} from "./verify-create-sutra-scaffold.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const FASTAPI_ADAPTER_TEMPLATE_ROOT = path.join(
  REPO_ROOT,
  "templates",
  "fastapi-adapter",
);

export const OBLIGATIONS = Object.freeze({
  TEMPLATE_MISSING: "integration_templates.fastapi_adapter.template_missing",
  WORKSPACE_PROTOCOL: "integration_templates.fastapi_adapter.workspace_protocol",
  ORCHESTRATOR_INTERNALS:
    "integration_templates.fastapi_adapter.orchestrator_internals",
  PACK_FAILED: "integration_templates.fastapi_adapter.pack_failed",
  INSTALL_FAILED: "integration_templates.fastapi_adapter.install_failed",
  TYPECHECK_FAILED: "integration_templates.fastapi_adapter.typecheck_failed",
  SMOKE_FAILED: "integration_templates.fastapi_adapter.smoke_failed",
  PYTHON_SMOKE_FAILED: "integration_templates.fastapi_adapter.python_smoke_failed",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "integration_templates.fastapi_adapter.verify", ...event })}\n`,
  );
}

export function validateFastapiAdapterPackageJson(pkg) {
  const violations = [];
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const [name, range] of Object.entries(deps)) {
    if (String(range).startsWith("workspace:")) {
      violations.push({
        obligation: OBLIGATIONS.WORKSPACE_PROTOCOL,
        detail: `${name} uses workspace: protocol (${range})`,
      });
    }
  }
  if (!pkg.dependencies?.["sutra-sdk"]) {
    violations.push({
      obligation: OBLIGATIONS.TEMPLATE_MISSING,
      detail: "package.json must depend on sutra-sdk",
    });
  }
  return { status: violations.length === 0 ? 0 : 1, violations };
}

/** Fail if Python sources import sutra_orchestrator internals. */
export function assertNoOrchestratorInternals(templateRoot) {
  const violations = [];
  const files = [
    path.join(templateRoot, "app", "main.py"),
    path.join(templateRoot, "app", "sync_store.py"),
    path.join(templateRoot, "app", "wire_models.py"),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (/sutra_orchestrator/.test(text)) {
      violations.push({
        obligation: OBLIGATIONS.ORCHESTRATOR_INTERNALS,
        detail: `${path.relative(templateRoot, file)} imports sutra_orchestrator`,
      });
    }
  }
  return { status: violations.length === 0 ? 0 : 1, violations };
}

export function wireFastapiTransportDeps(consumerDir, tarballs) {
  const deps = buildConsumerDependenciesFromTarballs(tarballs);
  const pkgPath = path.join(consumerDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies = {
    ...pkg.dependencies,
    "sutra-sdk": deps["sutra-sdk"],
  };
  pkg.pnpm = { overrides: buildPnpmOverridesFromTarballs(tarballs) };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

export function runFastapiAdapterTemplateVerify(opts = {}) {
  const subjectId = opts.subjectId ?? "fastapi-adapter-verify";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const templateRoot = opts.templateRoot ?? FASTAPI_ADAPTER_TEMPLATE_ROOT;
  const workRoot =
    opts.workRoot ??
    mkdtempSync(path.join(tmpdir(), "sutra-fastapi-adapter-verify-"));
  const packDir = path.join(workRoot, "packs");
  const consumerDir = opts.consumerDir ?? path.join(workRoot, "consumer");
  const cleanup = opts.cleanup !== false;
  const skipPython = opts.skipPython === true;
  const skipTs = opts.skipTs === true;

  if (!existsSync(templateRoot)) {
    return {
      status: 1,
      phase: "template",
      violations: [
        {
          obligation: OBLIGATIONS.TEMPLATE_MISSING,
          detail: `missing template root: ${templateRoot}`,
        },
      ],
      combined: `FASTAPI_ADAPTER_VERIFY_FAILED (template): missing ${templateRoot}`,
    };
  }

  const internals = assertNoOrchestratorInternals(templateRoot);
  if (internals.status !== 0) {
    const detail = internals.violations
      .map((v) => `[${v.obligation}] ${v.detail}`)
      .join("\n");
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "internals",
      violations: internals.violations,
      combined: `FASTAPI_ADAPTER_VERIFY_FAILED (internals):\n${detail}`,
    };
  }

  const pkgCheck = validateFastapiAdapterPackageJson(
    JSON.parse(readFileSync(path.join(templateRoot, "package.json"), "utf8")),
  );
  if (pkgCheck.status !== 0) {
    const detail = pkgCheck.violations.map((v) => `[${v.obligation}] ${v.detail}`).join("\n");
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "package",
      violations: pkgCheck.violations,
      combined: `FASTAPI_ADAPTER_VERIFY_FAILED (package):\n${detail}`,
    };
  }

  if (!skipPython) {
    cpSync(templateRoot, consumerDir, { recursive: true });
    const pip = spawnSync(
      "python",
      ["-m", "pip", "install", "-e", ".[dev]", "-q"],
      {
        cwd: consumerDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      },
    );
    if (pip.status !== 0) {
      const detail = (pip.stderr || pip.stdout || "pip install failed").trim();
      if (emitEvents) emit({ outcome: "fail", subjectId, deviceId, phase: "pip" });
      if (cleanup) rmSync(workRoot, { recursive: true, force: true });
      return {
        status: 1,
        phase: "pip",
        violations: [{ obligation: OBLIGATIONS.INSTALL_FAILED, detail }],
        combined: `FASTAPI_ADAPTER_VERIFY_FAILED (pip): ${detail}`,
      };
    }

    const pySmoke = spawnSync("python", ["scripts/smoke.py"], {
      cwd: consumerDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: { ...process.env, SUTRA_SUBJECT_ID: subjectId, SUTRA_DEVICE_ID: deviceId },
    });
    if (pySmoke.status !== 0 || !String(pySmoke.stdout).includes("smoke OK")) {
      const detail = (pySmoke.stderr || pySmoke.stdout || "python smoke failed").trim();
      if (emitEvents) {
        emit({ outcome: "fail", subjectId, deviceId, phase: "python-smoke" });
      }
      if (cleanup) rmSync(workRoot, { recursive: true, force: true });
      return {
        status: 1,
        phase: "python-smoke",
        violations: [{ obligation: OBLIGATIONS.PYTHON_SMOKE_FAILED, detail }],
        combined: `FASTAPI_ADAPTER_VERIFY_FAILED (python-smoke): ${detail}`,
      };
    }
  }

  if (!skipTs) {
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
          combined: `FASTAPI_ADAPTER_VERIFY_FAILED (build): ${detail}`,
        };
      }
    }

    const tsDir = path.join(workRoot, "ts-consumer");
    if (!existsSync(tsDir)) {
      cpSync(templateRoot, tsDir, { recursive: true });
    }

    let tarballs = opts.tarballs;
    if (!tarballs) {
      const packed = packPublicPackages(packDir, resolvePackagesForPack(opts));
      if (packed.violations.length > 0) {
        const combined = packed.violations
          .map((v) => `[${v.obligation}] ${v.detail}`)
          .join("\n");
        if (cleanup) rmSync(workRoot, { recursive: true, force: true });
        return {
          status: 1,
          phase: "pack",
          violations: packed.violations,
          combined: `FASTAPI_ADAPTER_VERIFY_FAILED (pack):\n${combined}`,
        };
      }
      tarballs = packed.tarballs;
    }

    wireFastapiTransportDeps(tsDir, tarballs);

    const install = spawnSync("pnpm", ["install", "--ignore-workspace"], {
      cwd: tsDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    if (install.status !== 0) {
      const detail = (install.stderr || install.stdout || "pnpm install failed").trim();
      if (cleanup) rmSync(workRoot, { recursive: true, force: true });
      return {
        status: 1,
        phase: "install",
        violations: [{ obligation: OBLIGATIONS.INSTALL_FAILED, detail }],
        combined: `FASTAPI_ADAPTER_VERIFY_FAILED (install): ${detail}`,
      };
    }

    const typecheck = spawnSync("pnpm", ["run", "typecheck"], {
      cwd: tsDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    if (typecheck.status !== 0) {
      const detail = (typecheck.stderr || typecheck.stdout || "tsc failed").trim();
      if (cleanup) rmSync(workRoot, { recursive: true, force: true });
      return {
        status: 1,
        phase: "typecheck",
        violations: [{ obligation: OBLIGATIONS.TYPECHECK_FAILED, detail }],
        combined: `FASTAPI_ADAPTER_VERIFY_FAILED (typecheck): ${detail}`,
      };
    }

    const smoke = spawnSync("pnpm", ["run", "smoke"], {
      cwd: tsDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: { ...process.env, SUTRA_SUBJECT_ID: subjectId, SUTRA_DEVICE_ID: deviceId },
    });
    if (smoke.status !== 0 || !String(smoke.stdout).includes("smoke OK")) {
      const detail = (smoke.stderr || smoke.stdout || "transport smoke failed").trim();
      if (cleanup) rmSync(workRoot, { recursive: true, force: true });
      return {
        status: 1,
        phase: "smoke",
        violations: [{ obligation: OBLIGATIONS.SMOKE_FAILED, detail }],
        combined: `FASTAPI_ADAPTER_VERIFY_FAILED (smoke): ${detail}`,
      };
    }
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "smoke",
      template: "fastapi-adapter",
    });
  }
  if (cleanup) rmSync(workRoot, { recursive: true, force: true });
  return {
    status: 0,
    phase: "smoke",
    combined:
      "OK: fastapi-adapter template passed python smoke, typecheck, and transport smoke",
  };
}

function main() {
  const result = runFastapiAdapterTemplateVerify();
  if (result.status !== 0) {
    process.stderr.write(`${result.combined}\n`);
    process.exit(result.status);
  }
  process.stdout.write(`${result.combined}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
