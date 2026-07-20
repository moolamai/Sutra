/**
 * CI gate: LLM-judge policy governance document coherence.
 *
 * Usage:
 *   pnpm --filter @moolam/learning llm-judge-policy:check
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LlmJudgePolicyContractError,
  proveLlmJudgePolicyGate,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

try {
  const proved = proveLlmJudgePolicyGate({
    repoRoot: REPO_ROOT,
    deviceId: "ci-llm-judge-policy",
    onTelemetry: (e) => {
      process.stdout.write(
        `${JSON.stringify({ event: "learning.critic.llm_judge_policy.ci", ...e })}\n`,
      );
    },
  });

  process.stdout.write(
    `${JSON.stringify({
      event: "learning.critic.llm_judge_policy.ci",
      outcome: "ok",
      subjectId: "llm-judge-policy",
      deviceId: "ci-llm-judge-policy",
      relpath: proved.relpath,
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
  process.stderr.write(`LLM judge policy gate failed: ${detail}\n`);
  process.exit(1);
}
