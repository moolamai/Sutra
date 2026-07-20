/**
 * Verify templates/edge-app: copy → install → typecheck → smoke.
 *
 * Uses packed local @moolam/* tarballs so the template never needs workspace:.
 *
 * Usage (repo root):
 *   node scripts/verify-edge-app-template.mjs
 *   pnpm integration:edge-app:verify
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
export const EDGE_APP_TEMPLATE_ROOT = path.join(REPO_ROOT, "templates", "edge-app");

export const OBLIGATIONS = Object.freeze({
  TEMPLATE_MISSING: "integration_templates.edge_app.template_missing",
  WORKSPACE_PROTOCOL: "integration_templates.edge_app.workspace_protocol",
  PACK_FAILED: "integration_templates.edge_app.pack_failed",
  INSTALL_FAILED: "integration_templates.edge_app.install_failed",
  TYPECHECK_FAILED: "integration_templates.edge_app.typecheck_failed",
  SMOKE_FAILED: "integration_templates.edge_app.smoke_failed",
  SUBJECT_ISOLATION: "integration_templates.edge_app.subject_isolation",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "integration_templates.edge_app.verify", ...event })}\n`,
  );
}

export function validateEdgeAppPackageJson(pkg) {
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
  return {
    status: violations.length === 0 ? 0 : 1,
    violations,
  };
}

export function wireEdgeAppConsumerDeps(consumerDir, tarballs) {
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

export function runEdgeAppTemplateVerify(opts = {}) {
  const subjectId = opts.subjectId ?? "edge-app-verify";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const templateRoot = opts.templateRoot ?? EDGE_APP_TEMPLATE_ROOT;
  const workRoot =
    opts.workRoot ?? mkdtempSync(path.join(tmpdir(), "sutra-edge-app-verify-"));
  const packDir = path.join(workRoot, "packs");
  const consumerDir = opts.consumerDir ?? path.join(workRoot, "consumer");
  const cleanup = opts.cleanup !== false;

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
      combined: `EDGE_APP_VERIFY_FAILED (template): missing ${templateRoot}`,
    };
  }

  const pkgCheck = validateEdgeAppPackageJson(
    JSON.parse(readFileSync(path.join(templateRoot, "package.json"), "utf8")),
  );
  if (pkgCheck.status !== 0) {
    const detail = pkgCheck.violations.map((v) => `[${v.obligation}] ${v.detail}`).join("\n");
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "package",
      violations: pkgCheck.violations,
      combined: `EDGE_APP_VERIFY_FAILED (package):\n${detail}`,
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
        combined: `EDGE_APP_VERIFY_FAILED (build): ${detail}`,
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
      if (cleanup) rmSync(workRoot, { recursive: true, force: true });
      return {
        status: 1,
        phase: "pack",
        violations: packed.violations,
        combined: `EDGE_APP_VERIFY_FAILED (pack):\n${combined}`,
      };
    }
    tarballs = packed.tarballs;
  }

  cpSync(templateRoot, consumerDir, { recursive: true });
  wireEdgeAppConsumerDeps(consumerDir, tarballs);

  const install = spawnSync("pnpm", ["install", "--ignore-workspace"], {
    cwd: consumerDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  if (install.status !== 0) {
    const detail = (install.stderr || install.stdout || "pnpm install failed").trim();
    if (emitEvents) {
      emit({ outcome: "fail", subjectId, deviceId, phase: "install" });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "install",
      violations: [{ obligation: OBLIGATIONS.INSTALL_FAILED, detail }],
      combined: `EDGE_APP_VERIFY_FAILED (install): ${detail}`,
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
      emit({ outcome: "fail", subjectId, deviceId, phase: "typecheck" });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "typecheck",
      violations: [{ obligation: OBLIGATIONS.TYPECHECK_FAILED, detail }],
      combined: `EDGE_APP_VERIFY_FAILED (typecheck): ${detail}`,
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
      emit({ outcome: "fail", subjectId, deviceId, phase: "smoke" });
    }
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "smoke",
      violations: [{ obligation: OBLIGATIONS.SMOKE_FAILED, detail }],
      combined: `EDGE_APP_VERIFY_FAILED (smoke): ${detail}`,
    };
  }

  if (!String(smoke.stdout).includes("smoke OK")) {
    if (cleanup) rmSync(workRoot, { recursive: true, force: true });
    return {
      status: 1,
      phase: "smoke",
      violations: [
        {
          obligation: OBLIGATIONS.SMOKE_FAILED,
          detail: "smoke script did not emit success marker",
        },
      ],
      combined: "EDGE_APP_VERIFY_FAILED (smoke): missing success marker",
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "smoke",
      template: "edge-app",
    });
  }

  if (cleanup) rmSync(workRoot, { recursive: true, force: true });
  return {
    status: 0,
    phase: "smoke",
    combined: "OK: edge-app template installed, typechecked, and passed smoke turn",
  };
}

function main() {
  const result = runEdgeAppTemplateVerify();
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
