/**
 * Emit seeded entropy snapshot as a single JSON line (stdout).
 * Used by cross-process reproducibility checks — metadata only.
 *
 * Usage:
 *   node --experimental-strip-types scripts/emit-seeded-entropy.mjs \
 *     <seed> <subjectId> <deviceId> [scenarioId]
 */
import {
  createHarnessDeterminismContext,
  PROVE_RETRIEVAL_CANDIDATES,
  snapshotSeededEntropy,
} from "../determinism.ts";

const seed = Number(process.argv[2]);
const subjectId = String(process.argv[3] ?? "");
const deviceId = String(process.argv[4] ?? "");
const scenarioId = process.argv[5];

const injected = createHarnessDeterminismContext({
  seed,
  subjectId,
  deviceId,
  ...(scenarioId !== undefined && scenarioId !== ""
    ? { scenarioId }
    : {}),
});

if (!injected.ok) {
  process.stderr.write(
    JSON.stringify({
      ok: false,
      failureClass: injected.failureClass,
      detail: injected.detail,
    }) + "\n",
  );
  process.exit(2);
}

const snap = snapshotSeededEntropy({
  context: injected.context,
  candidates: PROVE_RETRIEVAL_CANDIDATES,
});

if (!snap.ok) {
  process.stderr.write(
    JSON.stringify({
      ok: false,
      failureClass: snap.failureClass,
      detail: snap.detail,
    }) + "\n",
  );
  process.exit(3);
}

process.stdout.write(JSON.stringify({ ok: true, snapshot: snap.snapshot }) + "\n");
