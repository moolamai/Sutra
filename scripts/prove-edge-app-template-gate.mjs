/**
 * Seed-violation proof for edge-app integration template verify gate.
 *
 * Usage (repo root):
 *   node scripts/prove-edge-app-template-gate.mjs
 *   pnpm integration:edge-app:prove
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  runEdgeAppTemplateVerify,
  validateEdgeAppPackageJson,
} from "./verify-edge-app-template.mjs";

export function runEdgeAppTemplateProve() {
  const lines = [];

  // Red: workspace: protocol in package.json must fail validation with detail.
  const redPkg = validateEdgeAppPackageJson({
    dependencies: { "sutra-sdk": "workspace:*" },
  });
  if (redPkg.status === 0) {
    return {
      status: 1,
      combined: "EDGE_APP_PROVE_FAILED: workspace: dependency must fail validation",
    };
  }
  if (!redPkg.violations.some((v) => v.obligation === OBLIGATIONS.WORKSPACE_PROTOCOL)) {
    return {
      status: 1,
      combined: "EDGE_APP_PROVE_FAILED: expected workspace_protocol obligation",
    };
  }
  lines.push("red:workspace-protocol");

  // Red: missing dist seed must fail pack with printed detail.
  const scratch = mkdtempSync(path.join(tmpdir(), "sutra-edge-app-prove-"));
  try {
    const pkgDir = path.join(scratch, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: "@moolam/seed-edge-app-missing-dist",
          version: "0.0.0",
          type: "module",
          main: "./dist/index.js",
          files: ["dist"],
        },
        null,
        2,
      ),
    );
    const redPack = runEdgeAppTemplateVerify({
      packages: [
        {
          name: "@moolam/seed-edge-app-missing-dist",
          dir: pkgDir,
          manifest: {
            name: "@moolam/seed-edge-app-missing-dist",
            version: "0.0.0",
          },
        },
      ],
      skipBuild: true,
      emitEvents: false,
      cleanup: true,
    });
    if (redPack.status === 0) {
      return {
        status: 1,
        combined: "EDGE_APP_PROVE_FAILED: missing dist seed expected red",
      };
    }
    if (redPack.phase !== "pack") {
      return {
        status: 1,
        combined:
          `EDGE_APP_PROVE_FAILED: expected pack phase, got ${redPack.phase}:\n` +
          `${redPack.combined}`,
      };
    }
    if (!String(redPack.combined).includes("missing dist")) {
      return {
        status: 1,
        combined:
          "EDGE_APP_PROVE_FAILED: pack failure must print missing-dist detail:\n" +
          `${redPack.combined}`,
      };
    }
    lines.push("red:missing-dist:pack");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Green: baseline template verify against current SDK.
  const green = runEdgeAppTemplateVerify({
    skipBuild: true,
    emitEvents: false,
    cleanup: true,
  });
  if (green.status !== 0) {
    return {
      status: 1,
      combined: `EDGE_APP_PROVE_FAILED: baseline must pass:\n${green.combined}`,
    };
  }
  lines.push("green:baseline");

  return {
    status: 0,
    combined: `OK: edge-app template prove red→green (${lines.join(", ")})`,
  };
}

function main() {
  const result = runEdgeAppTemplateProve();
  if (result.status !== 0) {
    process.stderr.write(`${result.combined}\n`);
    process.exit(result.status);
  }
  process.stdout.write(`${result.combined}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
