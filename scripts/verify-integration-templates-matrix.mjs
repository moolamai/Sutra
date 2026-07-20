/**
 * CI matrix: verify all three integration templates against packed SDK.
 *
 * Packs @moolam/* once, then for each template: copy → install → typecheck → smoke.
 *
 * Usage (repo root):
 *   node scripts/verify-integration-templates-matrix.mjs --matrix
 *   node scripts/verify-integration-templates-matrix.mjs --template=edge-app
 *   pnpm integration:templates:verify:matrix
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packPublicPackages } from "./verify-rehearsal-install.mjs";
import {
  CI_PINNED,
  SCAFFOLD_SDK_GRAPH,
  resolvePackagesForPack,
} from "./verify-create-sutra-scaffold.mjs";
import { runEdgeAppTemplateVerify } from "./verify-edge-app-template.mjs";
import { runNodeServiceTemplateVerify } from "./verify-node-service-template.mjs";
import { runFastapiAdapterTemplateVerify } from "./verify-fastapi-adapter-template.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export { CI_PINNED };

export const OBLIGATIONS = Object.freeze({
  MATRIX_EMPTY: "integration_templates.matrix.empty",
  MATRIX_CELL_FAILED: "integration_templates.matrix.cell_failed",
  MATRIX_UNKNOWN_TEMPLATE: "integration_templates.matrix.unknown_template",
  PACK_FAILED: "integration_templates.matrix.pack_failed",
});

/**
 * Matrix cells — one per integration template.
 * fastapi-adapter needs Python; others are Node-only.
 */
export const INTEGRATION_TEMPLATE_MATRIX = Object.freeze([
  {
    id: "edge-app",
    label: "edge-app (RN/Expo + StorageDriver)",
    needsPython: false,
  },
  {
    id: "node-service",
    label: "node-service (HTTP + CognitiveCore)",
    needsPython: false,
  },
  {
    id: "fastapi-adapter",
    label: "fastapi-adapter (SyncTransport + FastAPI)",
    needsPython: true,
  },
]);

export function matrixCellSubjectId(cell) {
  return `integration-matrix-${cell.id}`;
}

export function formatMatrixCellLabel(cell) {
  return `${cell.id} (${cell.label})`;
}

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "integration_templates.matrix.verify", ...event })}\n`,
  );
}

export function resolveMatrixCells(opts = {}) {
  if (opts.matrix) return opts.matrix;
  if (opts.template) {
    const cell = INTEGRATION_TEMPLATE_MATRIX.find((c) => c.id === opts.template);
    if (!cell) return null;
    return [cell];
  }
  return [...INTEGRATION_TEMPLATE_MATRIX];
}

function runCellVerify(cell, shared) {
  const subjectId = shared.subjectId ?? matrixCellSubjectId(cell);
  const common = {
    subjectId,
    deviceId: shared.deviceId ?? "ci",
    skipBuild: true,
    tarballs: shared.tarballs,
    emitEvents: false,
    cleanup: true,
  };

  if (cell.id === "edge-app") {
    return runEdgeAppTemplateVerify(common);
  }
  if (cell.id === "node-service") {
    return runNodeServiceTemplateVerify(common);
  }
  if (cell.id === "fastapi-adapter") {
    return runFastapiAdapterTemplateVerify(common);
  }
  return {
    status: 1,
    phase: "matrix",
    violations: [
      {
        obligation: OBLIGATIONS.MATRIX_UNKNOWN_TEMPLATE,
        detail: `unknown template cell: ${cell.id}`,
      },
    ],
    combined: `INTEGRATION_MATRIX_FAILED: unknown template ${cell.id}`,
  };
}

/**
 * Pack once, then verify each matrix cell. Failures print cell id + phase detail.
 */
export function runIntegrationTemplatesMatrix(opts = {}) {
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const cells = resolveMatrixCells(opts);
  const workRoot =
    opts.workRoot ??
    mkdtempSync(path.join(tmpdir(), "sutra-integration-templates-matrix-"));
  const cleanup = opts.cleanup !== false;

  if (cells === null) {
    return {
      status: 1,
      phase: "matrix",
      violations: [
        {
          obligation: OBLIGATIONS.MATRIX_UNKNOWN_TEMPLATE,
          detail: `unknown template: ${opts.template}`,
        },
      ],
      combined: `INTEGRATION_MATRIX_FAILED: unknown template ${opts.template}`,
    };
  }

  if (!Array.isArray(cells) || cells.length === 0) {
    return {
      status: 1,
      phase: "matrix",
      violations: [
        {
          obligation: OBLIGATIONS.MATRIX_EMPTY,
          detail: "integration template matrix has no cells",
        },
      ],
      combined: "INTEGRATION_MATRIX_FAILED (matrix): empty matrix",
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
        combined: `INTEGRATION_MATRIX_FAILED (build): ${detail}`,
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
        subjectId: "integration-matrix",
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
      combined: `INTEGRATION_MATRIX_FAILED (pack):\n${combined}`,
    };
  }

  const passed = [];
  for (const cell of cells) {
    const subjectId = matrixCellSubjectId(cell);
    const cellResult = runCellVerify(cell, {
      subjectId,
      deviceId,
      tarballs: packed.tarballs,
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
          `INTEGRATION_MATRIX_FAILED (matrix cell ${cell.id}):\n` +
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
      subjectId: "integration-matrix",
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
    combined: `OK: integration template matrix passed (${passed.length} cell(s): ${passed.join(", ")})`,
  };
}

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    if (arg === "--matrix") opts.matrixAll = true;
    if (arg.startsWith("--template=")) {
      opts.template = arg.slice("--template=".length).trim();
    }
  }
  return opts;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = args.template
    ? runIntegrationTemplatesMatrix({ template: args.template })
    : runIntegrationTemplatesMatrix();
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
