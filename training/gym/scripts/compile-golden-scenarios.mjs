/**
 * Compile A P6 golden turns → training/gym/scenarios/golden/.
 *
 * Usage:
 *   node scripts/compile-golden-scenarios.mjs --write   # materialize (human review before commit)
 *   node scripts/compile-golden-scenarios.mjs --check   # CI / local byte-identical gate
 *   pnpm --filter @moolam/training-gym golden:check
 */

import { materializeGoldenScenarioFixtures } from "../src/golden_episode_tasks.mjs";

const args = new Set(process.argv.slice(2));
const mode = args.has("--write") ? "write" : "check";

const result = materializeGoldenScenarioFixtures({
  mode,
  deviceId: "ci-gym-golden-compile",
  onTelemetry: (e) => {
    process.stdout.write(`${JSON.stringify(e)}\n`);
  },
});

if (!result.ok) {
  process.stderr.write(
    `golden episode compile failed: ${result.failureClass} — ${result.detail}\n`,
  );
  if (result.diffs?.length) {
    process.stderr.write(`${result.diffs.join("\n")}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({
      event: "training.gym.golden_episode",
      outcome: "ok",
      phase: "cli",
      mode: result.mode,
      subjectId: null,
      deviceId: "ci-gym-golden-compile",
      taskCount: result.taskCount,
    })}\n`,
  );
}
