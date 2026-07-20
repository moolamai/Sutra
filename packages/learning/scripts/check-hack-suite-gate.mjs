/**
 * CI gate: hack suite must clear before critic calibration.
 * Blocks rubric version bumps that score positive on any degenerate fixture.
 *
 * Usage:
 *   pnpm --filter @moolam/learning hack:check
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HackFixtureContractError,
  proveHackSuiteCriticVersionGate,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

try {
  const proved = proveHackSuiteCriticVersionGate({
    repoRoot: REPO_ROOT,
    deviceId: "ci-hack-suite-gate",
    onTelemetry: (e) => {
      process.stdout.write(
        `${JSON.stringify({ event: "learning.critic.hack_ci_gate.ci", ...e })}\n`,
      );
    },
  });

  process.stdout.write(
    `${JSON.stringify({
      event: "learning.critic.hack_ci_gate.ci",
      outcome: "ok",
      subjectId: "hack-suite",
      deviceId: "ci-hack-suite-gate",
      fixtureCount: proved.baseline.fixtureCount,
      layerCount: proved.baseline.layerCount,
      baselinePasses: proved.baseline.passes,
      leakyBlocked: proved.leakyBlocked.verdict,
      leakyFailingFixtures: proved.leakyBlocked.failingFixtures,
      calibrationAllowedForLeaky: proved.leakyBlocked.calibrationAllowed,
      orderingOk: proved.orderingOk,
      runBeforeCalibration: true,
    })}\n`,
  );
  process.exit(0);
} catch (err) {
  const detail =
    err instanceof HackFixtureContractError
      ? `${err.obligation} failingSlice=${err.failingSlice ?? "(none)"} — ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  process.stderr.write(`hack suite critic-version gate failed: ${detail}\n`);
  process.exit(1);
}
