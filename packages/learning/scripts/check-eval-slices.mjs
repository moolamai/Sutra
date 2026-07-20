/**
 * CI gate: assert every registered domain pack / binding has a frozen slice
 * baseline. Missing slices are listed by name.
 *
 * Usage:
 *   pnpm --filter @moolam/learning slices:check
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAndAssertEvalSliceCoverage } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const result = await loadAndAssertEvalSliceCoverage({
  repoRoot: REPO_ROOT,
  deviceId: "ci-slices-check",
  onTelemetry: (e) => {
    process.stdout.write(
      `${JSON.stringify({ event: "learning.eval_slices.ci", ...e })}\n`,
    );
  },
});

if (!result.ok) {
  const missing = result.missingSliceIds?.length
    ? ` missing=[${result.missingSliceIds.join(",")}]`
    : "";
  process.stderr.write(
    `eval slice coverage check failed: ${result.failureClass} — ${result.detail}${missing}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    event: "learning.eval_slices.ci",
    outcome: "ok",
    subjectId: null,
    deviceId: "ci-slices-check",
    coveredCount: result.report.coveredSliceIds.length,
    emptyMarkerCount: result.report.emptyMarkerSliceIds.length,
    missingSliceIds: [],
  })}\n`,
);
