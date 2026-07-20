/**
 * CI gate: load baseline registry, export hash index, assert completeness
 * against known eval directories.
 *
 * Usage:
 *   pnpm --filter @moolam/learning baselines:check
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBaselineRegistryApi } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const result = await loadBaselineRegistryApi({
  repoRoot: REPO_ROOT,
  deviceId: "ci-baselines-check",
  onTelemetry: (e) => {
    process.stdout.write(
      `${JSON.stringify({ event: "learning.baseline_registry.ci", ...e })}\n`,
    );
  },
});

if (!result.ok) {
  process.stderr.write(
    `baseline registry check failed: ${result.failureClass} — ${result.detail}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    event: "learning.baseline_registry.ci",
    outcome: "ok",
    subjectId: null,
    deviceId: "ci-baselines-check",
    entryCount: result.export.entries.length,
    contentHashCount: result.export.contentHashes.length,
    artifactCount: result.completeness.artifactCount,
  })}\n`,
);
