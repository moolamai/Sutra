/**
 * Build / verify unified scenario catalog (golden + guidance).
 *
 * Usage:
 *   node scripts/compile-scenario-catalog.mjs --write
 *   node scripts/compile-scenario-catalog.mjs --check
 *   pnpm --filter @moolam/training-gym catalog:check
 */

import { materializeScenarioCatalog } from "../src/scenario_catalog.mjs";

const args = new Set(process.argv.slice(2));
const mode = args.has("--write") ? "write" : "check";

const result = materializeScenarioCatalog({
  mode,
  deviceId: "ci-gym-catalog-compile",
  onTelemetry: (e) => {
    process.stdout.write(`${JSON.stringify(e)}\n`);
  },
});

if (!result.ok) {
  process.stderr.write(
    `scenario catalog failed: ${result.failureClass} — ${result.detail}\n`,
  );
  if (result.diffs?.length) {
    process.stderr.write(`${result.diffs.join("\n")}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({
      event: "training.gym.scenario_catalog",
      outcome: "ok",
      phase: "cli",
      mode: result.mode,
      subjectId: null,
      deviceId: "ci-gym-catalog-compile",
      scenarioCount: result.scenarioCount,
      sliceCount: result.sliceCount,
    })}\n`,
  );
}
