/**
 * CI gate: critic version promotion against held-out human labels.
 * Known-good (core rubric) must promote; known-bad fixture must fail.
 *
 * Usage:
 *   pnpm --filter @moolam/learning calibration:check
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CalibrationContractError,
  proveCalibrationPromotionGate,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

try {
  const proved = proveCalibrationPromotionGate({
    repoRoot: REPO_ROOT,
    deviceId: "ci-calibration-gate",
    onTelemetry: (e) => {
      process.stdout.write(
        `${JSON.stringify({ event: "learning.critic.calibration_promotion.ci", ...e })}\n`,
      );
    },
  });

  process.stdout.write(
    `${JSON.stringify({
      event: "learning.critic.calibration_promotion.ci",
      outcome: "ok",
      subjectId: "calibration-set",
      deviceId: "ci-calibration-gate",
      championVerdict: proved.champion.verdict,
      knownBadVerdict: proved.knownBad.verdict,
      knownBadFailingSlices: proved.knownBad.failingSlices,
      trainingConfigAllowed: proved.champion.trainingConfigAllowed,
      agreementValue: proved.champion.agreement.overall.value,
      threshold: proved.champion.agreement.threshold,
    })}\n`,
  );
  process.exit(0);
} catch (err) {
  const detail =
    err instanceof CalibrationContractError
      ? `${err.obligation} failingSlice=${err.failingSlice ?? "(none)"} — ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  process.stderr.write(`calibration promotion gate failed: ${detail}\n`);
  process.exit(1);
}
