/**
 * CI gate: replay recorded production golden trajectories through the gym
 * harness bridge; require byte-identical canonical frame sequences.
 *
 * On failure, prints the first divergent frameIndex (and frameType) so the
 * path-filtered root CI job can block merge with a precise locator.
 *
 * Usage:
 *   pnpm --filter @moolam/training-gym parity:check
 *   pnpm --filter @moolam/training-gym ci:parity
 */

import { runTrajectoryReplayParityGate } from "../src/frame_parity.mjs";

const result = runTrajectoryReplayParityGate({
  subjectId: "subj-gym-replay-parity-ci",
  deviceId: "dev-gym-replay-parity-ci",
  onTelemetry: (e) => {
    process.stdout.write(`${JSON.stringify(e)}\n`);
  },
});

if (!result.ok) {
  const frameIndex =
    result.frameIndex != null && result.frameIndex >= 0
      ? result.frameIndex
      : null;
  const frameType = result.frameType ?? null;
  const loc =
    frameIndex != null
      ? ` firstDivergentFrameIndex=${frameIndex} frameType=${frameType}`
      : "";
  process.stderr.write(
    `gym replay parity FAILED — blocks merge:` +
      ` failureClass=${result.failureClass}` +
      (result.turnId ? ` turnId=${result.turnId}` : "") +
      (result.domain ? ` domain=${result.domain}` : "") +
      loc +
      ` — ${result.detail ?? ""}\n`,
  );
  if (result.diff) {
    process.stderr.write(`${result.diff.slice(0, 8000)}\n`);
  }
  process.stdout.write(
    `${JSON.stringify({
      event: "training.gym.replay_parity",
      outcome: "rejected",
      phase: "ci",
      subjectId: result.subjectId,
      deviceId: result.deviceId,
      failureClass: result.failureClass,
      turnId: result.turnId,
      domain: result.domain ?? null,
      frameIndex,
      frameType,
      detail: result.detail,
    })}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({
      event: "training.gym.replay_parity",
      outcome: "ok",
      phase: "ci",
      subjectId: result.subjectId,
      deviceId: result.deviceId,
      turnCount: result.turnCount,
      domainCount: result.domainCount ?? null,
    })}\n`,
  );
}
