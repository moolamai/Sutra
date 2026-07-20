/**
 * Compile B8 guidance evals → training/gym/scenarios/guidance/.
 *
 * Usage:
 *   node scripts/compile-guidance-scenarios.mjs --write   # materialize (human review before commit)
 *   node scripts/compile-guidance-scenarios.mjs --check   # CI / local byte-identical gate
 *   pnpm --filter @moolam/training-gym guidance:check
 */

import { materializeGuidanceScenarioFixtures } from "../src/guidance_episode_tasks.mjs";

const args = new Set(process.argv.slice(2));
const mode = args.has("--write") ? "write" : "check";

const result = materializeGuidanceScenarioFixtures({
  mode,
  deviceId: "ci-gym-guidance-compile",
  onTelemetry: (e) => {
    process.stdout.write(`${JSON.stringify(e)}\n`);
  },
});

if (!result.ok) {
  process.stderr.write(
    `guidance episode compile failed: ${result.failureClass} — ${result.detail}\n`,
  );
  if (result.diffs?.length) {
    process.stderr.write(`${result.diffs.join("\n")}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({
      event: "training.gym.guidance_episode",
      outcome: "ok",
      phase: "cli",
      mode: result.mode,
      subjectId: null,
      deviceId: "ci-gym-guidance-compile",
      taskCount: result.taskCount,
    })}\n`,
  );
}
