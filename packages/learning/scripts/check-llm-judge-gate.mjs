/**
 * CI gate: LLM-judge agreement on held-out tone/clarity fixtures.
 * Known-good oracle must promote; known-bad always-pass must fail.
 * Independent of critic calibration:check.
 *
 * Usage:
 *   pnpm --filter @moolam/learning llm-judge-gate:check
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LlmJudgePolicyContractError,
  proveLlmJudgeAgreementGate,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

try {
  const proved = proveLlmJudgeAgreementGate({
    repoRoot: REPO_ROOT,
    deviceId: "ci-llm-judge-gate",
    onTelemetry: (e) => {
      process.stdout.write(
        `${JSON.stringify({ event: "learning.critic.llm_judge_gate.ci", ...e })}\n`,
      );
    },
  });

  process.stdout.write(
    `${JSON.stringify({
      event: "learning.critic.llm_judge_gate.ci",
      outcome: "ok",
      subjectId: "llm-judge-gate",
      deviceId: "ci-llm-judge-gate",
      championVerdict: proved.champion.verdict,
      knownBadVerdict: proved.knownBad.verdict,
      knownBadFailingAspects: proved.knownBad.failingAspects,
      trainingConfigAllowed: proved.champion.pin.trainingConfigAllowed,
      setContentHash: proved.champion.pin.setContentHash,
      agreementValue: proved.champion.report.overall.value,
      threshold: proved.champion.report.threshold,
    })}\n`,
  );
  process.exit(0);
} catch (err) {
  const detail =
    err instanceof LlmJudgePolicyContractError
      ? `${err.obligation} failingSlice=${err.failingSlice ?? "(none)"} — ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  process.stderr.write(`LLM judge agreement gate failed: ${detail}\n`);
  process.exit(1);
}
