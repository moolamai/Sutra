/**
 * CI smoke: one seeded episode per catalog slice.
 * Failures name scenarioId + slice (required).
 *
 * Usage:
 *   pnpm --filter @moolam/training-gym catalog:smoke
 */

import { runScenarioCatalogSmoke } from "../src/scenario_catalog.mjs";

const result = await runScenarioCatalogSmoke({
  deviceId: "ci-gym-catalog-smoke",
  onTelemetry: (e) => {
    process.stdout.write(`${JSON.stringify(e)}\n`);
  },
});

if (!result.ok) {
  process.stderr.write(
    `scenario catalog smoke failed: ${result.failureClass} — ${result.detail}\n`,
  );
  for (const f of result.failures ?? []) {
    process.stderr.write(`${f}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({
      event: "training.gym.scenario_catalog",
      outcome: "ok",
      phase: "smoke",
      subjectId: null,
      deviceId: "ci-gym-catalog-smoke",
      smoked: result.smoked,
      sliceCount: result.sliceCount,
      scenarioCount: result.scenarioCount,
    })}\n`,
  );
}
