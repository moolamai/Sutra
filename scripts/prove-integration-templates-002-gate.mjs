/**
 * Seed-violation proof for node-service + fastapi-adapter template gates.
 *
 * Usage:
 *   node scripts/prove-integration-templates-002-gate.mjs
 *   pnpm integration:templates-002:prove
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS as NODE_OBLIGATIONS,
  runNodeServiceTemplateVerify,
  validateNodeServicePackageJson,
} from "./verify-node-service-template.mjs";
import {
  OBLIGATIONS as FASTAPI_OBLIGATIONS,
  assertNoOrchestratorInternals,
  runFastapiAdapterTemplateVerify,
  validateFastapiAdapterPackageJson,
} from "./verify-fastapi-adapter-template.mjs";

export function runIntegrationTemplates002Prove() {
  const lines = [];

  const redNode = validateNodeServicePackageJson({
    dependencies: { "sutra-sdk": "workspace:*" },
  });
  if (redNode.status === 0) {
    return {
      status: 1,
      combined: "TEMPLATES_002_PROVE_FAILED: node-service workspace: must fail",
    };
  }
  if (
    !redNode.violations.some((v) => v.obligation === NODE_OBLIGATIONS.WORKSPACE_PROTOCOL)
  ) {
    return {
      status: 1,
      combined: "TEMPLATES_002_PROVE_FAILED: expected node-service workspace_protocol",
    };
  }
  lines.push("red:node-service:workspace");

  const redFastapi = validateFastapiAdapterPackageJson({
    dependencies: { "sutra-sdk": "workspace:*" },
  });
  if (redFastapi.status === 0) {
    return {
      status: 1,
      combined: "TEMPLATES_002_PROVE_FAILED: fastapi-adapter workspace: must fail",
    };
  }
  lines.push("red:fastapi-adapter:workspace");

  // Seed orchestrator internals import → red.
  const scratch = mkdtempSync(path.join(tmpdir(), "sutra-fastapi-internals-"));
  try {
    mkdirSync(path.join(scratch, "app"), { recursive: true });
    writeFileSync(
      path.join(scratch, "app", "main.py"),
      "from sutra_orchestrator.sync_service import SyncService\n",
    );
    writeFileSync(path.join(scratch, "app", "sync_store.py"), "");
    writeFileSync(path.join(scratch, "app", "wire_models.py"), "");
    const redInternals = assertNoOrchestratorInternals(scratch);
    if (redInternals.status === 0) {
      return {
        status: 1,
        combined: "TEMPLATES_002_PROVE_FAILED: orchestrator internals seed expected red",
      };
    }
    if (
      !redInternals.violations.some(
        (v) => v.obligation === FASTAPI_OBLIGATIONS.ORCHESTRATOR_INTERNALS,
      )
    ) {
      return {
        status: 1,
        combined: "TEMPLATES_002_PROVE_FAILED: expected orchestrator_internals obligation",
      };
    }
    lines.push("red:fastapi-adapter:orchestrator-internals");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Missing dist pack seed for node-service.
  const packScratch = mkdtempSync(path.join(tmpdir(), "sutra-node-prove-pack-"));
  try {
    const pkgDir = path.join(packScratch, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: "@moolam/seed-node-service-missing-dist",
          version: "0.0.0",
          type: "module",
          main: "./dist/index.js",
          files: ["dist"],
        },
        null,
        2,
      ),
    );
    const redPack = runNodeServiceTemplateVerify({
      packages: [
        {
          name: "@moolam/seed-node-service-missing-dist",
          dir: pkgDir,
          manifest: {
            name: "@moolam/seed-node-service-missing-dist",
            version: "0.0.0",
          },
        },
      ],
      skipBuild: true,
      emitEvents: false,
      cleanup: true,
    });
    if (redPack.status === 0 || redPack.phase !== "pack") {
      return {
        status: 1,
        combined:
          `TEMPLATES_002_PROVE_FAILED: missing dist expected pack red:\n${redPack.combined}`,
      };
    }
    if (!String(redPack.combined).includes("missing dist")) {
      return {
        status: 1,
        combined: `TEMPLATES_002_PROVE_FAILED: pack detail missing:\n${redPack.combined}`,
      };
    }
    lines.push("red:node-service:missing-dist");
  } finally {
    rmSync(packScratch, { recursive: true, force: true });
  }

  const greenNode = runNodeServiceTemplateVerify({
    skipBuild: true,
    emitEvents: false,
    cleanup: true,
  });
  if (greenNode.status !== 0) {
    return {
      status: 1,
      combined: `TEMPLATES_002_PROVE_FAILED: node-service baseline:\n${greenNode.combined}`,
    };
  }
  lines.push("green:node-service");

  const greenFastapi = runFastapiAdapterTemplateVerify({
    skipBuild: true,
    emitEvents: false,
    cleanup: true,
  });
  if (greenFastapi.status !== 0) {
    return {
      status: 1,
      combined: `TEMPLATES_002_PROVE_FAILED: fastapi-adapter baseline:\n${greenFastapi.combined}`,
    };
  }
  lines.push("green:fastapi-adapter");

  return {
    status: 0,
    combined: `OK: integration templates 002 prove red→green (${lines.join(", ")})`,
  };
}

function main() {
  const result = runIntegrationTemplates002Prove();
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
