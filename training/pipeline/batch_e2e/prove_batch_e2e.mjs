/**
 * CI prove: synthetic consented fixtures → collect → training window → candidate;
 * below-threshold fixture → skip verdict (no candidate).
 *
 * Usage:
 *   node training/pipeline/batch_e2e/prove_batch_e2e.mjs
 *   pnpm --filter @moolam/training-pipeline batch:prove
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OfflineBatchContractError,
  proveOfflineBatchModeE2E,
} from "../../../packages/learning/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

export async function main() {
  try {
    const workDir = mkdtempSync(path.join(tmpdir(), "batch-e2e-prove-"));
    const proved = proveOfflineBatchModeE2E({
      fixturesRoot: FIXTURES,
      workDir,
      onTelemetry: (e) => {
        process.stdout.write(`${JSON.stringify(e)}\n`);
      },
    });

    process.stdout.write(
      `${JSON.stringify({
        event: "training.batch.e2e.prove",
        outcome: "ok",
        subjectId: "batch.e2e",
        deviceId: "ci.batch.e2e",
        setId: proved.manifest.setId,
        readyEnqueued: proved.ready.collect.enqueued,
        readyVerdict: proved.ready.train.verdict,
        readyCandidateId:
          proved.ready.train.verdict === "candidate"
            ? proved.ready.train.candidate.candidateId
            : undefined,
        readyLineageRevision:
          proved.ready.train.verdict === "candidate"
            ? proved.ready.train.lineageRevision
            : undefined,
        belowThresholdCollect: proved.belowThreshold.collect.verdict,
        belowThresholdTrain: proved.belowThreshold.train.verdict,
        belowThresholdSkipReason: proved.belowThreshold.train.skipReason,
      })}\n`,
    );
    process.exit(0);
  } catch (err) {
    if (err instanceof OfflineBatchContractError) {
      process.stderr.write(
        `BATCH E2E PROVE FAIL obligation=${err.obligation}` +
          (err.failingSlice ? ` slice=${err.failingSlice}` : "") +
          `\n${err.message}\n`,
      );
      if (err.diff) process.stderr.write(`DIFF\n${err.diff}\n`);
      process.exit(1);
    }
    process.stderr.write(
      `BATCH E2E PROVE FAIL ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  void main();
}
