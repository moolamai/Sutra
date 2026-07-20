/**
 * CI gate: candidate red-team pre-gate with constitutional erosion fixtures.
 * Unsafe + locality-violating fixtures must fail; safe must pass; workflow
 * orders red-team:check before surgery:check.
 *
 * Usage:
 *   pnpm --filter @moolam/learning red-team:check
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CandidateSafetyContractError,
  proveCandidateRedTeamCiGate,
} from "../dist/candidate_safety.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

try {
  const proved = await proveCandidateRedTeamCiGate({
    repoRoot: REPO_ROOT,
    deviceId: "ci-candidate-red-team-gate",
    onTelemetry: (e) => {
      process.stdout.write(
        `${JSON.stringify({ event: "learning.candidate_red_team.ci_gate.ci", ...e })}\n`,
      );
    },
  });

  process.stdout.write(
    `${JSON.stringify({
      event: "learning.candidate_red_team.ci_gate.ci",
      outcome: "ok",
      subjectId: "subject.red-team.ci",
      deviceId: "ci-candidate-red-team-gate",
      unsafeBlocked: proved.unsafeBlocked,
      localityBlocked: proved.localityBlocked,
      safePassed: proved.safePassed,
      scenarioCount: proved.scenarioCount,
      orderingOk: proved.orderingOk,
      killSwitchBaseline: proved.killSwitchBaseline,
      runBeforeEvalGates: true,
    })}\n`,
  );
  process.exit(0);
} catch (err) {
  const detail =
    err instanceof CandidateSafetyContractError
      ? `${err.obligation} scenarios=[${(err.failingScenarioIds ?? []).join(",")}] — ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  process.stderr.write(`candidate red-team CI gate failed: ${detail}\n`);
  process.exit(1);
}
