/**
 * CI gate: one-surgery-per-stage promotion-candidate linter prove.
 * Green fixture must pass; violation fixture must fail attribution_void.
 *
 * Usage:
 *   pnpm --filter @moolam/learning surgery:check
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { proveOneSurgeryPromotionLint } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const result = await proveOneSurgeryPromotionLint({
  repoRoot: REPO_ROOT,
  deviceId: "ci-one-surgery-check",
  onTelemetry: (e) => {
    process.stdout.write(`${JSON.stringify(e)}\n`);
  },
});

if (!result.ok) {
  process.stderr.write(
    `one-surgery promotion lint prove failed: ${result.failureClass} — ${result.detail}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    event: "learning.governance.ci",
    outcome: "ok",
    subjectId: null,
    deviceId: "ci-one-surgery-check",
    greenStageId: result.greenStageId,
    redStageId: result.redStageId,
    failureClass: "attribution_void",
  })}\n`,
);
