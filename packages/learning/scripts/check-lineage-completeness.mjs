/**
 * CI gate: checkpoint lineage completeness before candidate emission.
 * Missing-critics fixture must fail; micro-run complete row must admit.
 *
 * Usage:
 *   pnpm --filter @moolam/learning lineage:check
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CheckpointLineageContractError,
  proveCheckpointLineageCompletenessGateCi,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

try {
  const proved = proveCheckpointLineageCompletenessGateCi({
    repoRoot: REPO_ROOT,
    deviceId: "ci-lineage-completeness",
    onTelemetry: (e) => {
      process.stdout.write(
        `${JSON.stringify({ event: "learning.lineage.completeness.ci", ...e })}\n`,
      );
    },
  });

  process.stdout.write(
    `${JSON.stringify({
      event: "learning.lineage.completeness.ci",
      outcome: "ok",
      subjectId: "lineage-completeness",
      deviceId: "ci-lineage-completeness",
      violationRejected: proved.violationRejected,
      violationFailureClass: proved.violationFailureClass,
      microRunAdmitted: proved.microRunAdmitted,
      missingRowDenied: proved.missingRowDenied,
    })}\n`,
  );
  process.exit(0);
} catch (err) {
  const detail =
    err instanceof CheckpointLineageContractError
      ? `${err.obligation} failingSlice=${err.failingSlice ?? "(none)"} — ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  process.stderr.write(`Lineage completeness gate failed: ${detail}\n`);
  process.exit(1);
}
