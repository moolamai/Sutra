/**
 * sync_convergence.bench — NFR-03 compose sync path (1k pending samples).
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PENDING_SAMPLES,
  NFR03_BUDGET_P95_MS,
  buildEdgeStateWithPendingSamples,
  createInProcessSyncTransport,
  measureSyncConvergenceMs,
} from "../_shared/sync_convergence_probe.mjs";
import { evaluateP95Gate } from "./check.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THRESHOLDS = path.join(__dirname, "thresholds.json");
const BENCH = path.join(__dirname, "../load/sync_convergence.bench.mjs");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.sync_convergence.test", ...event })}\n`,
  );
}

test("happy path: 1k pending samples converge in-process under NFR-03 budget", async () => {
  const transport = createInProcessSyncTransport();
  const { elapsedMs, outcome, sampleCount } = await measureSyncConvergenceMs(
    transport,
    { subjectId: "subj-nfr03-happy", deviceId: "edge-happy" },
  );
  assert.equal(outcome.status, "converged");
  assert.equal(sampleCount, PENDING_SAMPLES);
  assert.ok(elapsedMs < NFR03_BUDGET_P95_MS);
  log({
    outcome: "ok",
    case: "happy-converge",
    subjectId: "subj-nfr03-happy",
    elapsedMs,
  });
});

test("edge: seeded slowdown trips NFR-03 10s gate; headroom on fast path", async () => {
  const doc = JSON.parse(readFileSync(THRESHOLDS, "utf8"));
  const entry = doc.benches.sync_convergence;
  assert.ok(entry, "thresholds.json must map sync_convergence → NFR-03");
  assert.equal(entry.nfrId, "NFR-03");
  assert.equal(entry.nfrBudgetP95Ms, 10_000);
  assert.equal(entry.p95Ms, 10_000);
  assert.equal(entry.benchFile, "load/sync_convergence.bench.mjs");

  const breach = evaluateP95Gate({
    benchId: "sync_convergence",
    measuredP95: 10_500,
    budgetP95: entry.p95Ms,
    nfrId: entry.nfrId,
    subjectId: null,
    deviceId: "test-sync-slow",
  });
  assert.equal(breach.ok, false);
  assert.equal(breach.failureClass, "p95_breach");

  const fast = await measureSyncConvergenceMs(createInProcessSyncTransport(), {
    subjectId: "subj-nfr03-fast",
  });
  const ok = evaluateP95Gate({
    benchId: "sync_convergence",
    measuredP95: fast.elapsedMs,
    budgetP95: entry.p95Ms,
    nfrId: entry.nfrId,
    subjectId: "subj-nfr03-fast",
    deviceId: "edge-fast",
  });
  assert.equal(ok.ok, true);
  assert.ok((ok.headroomPercent ?? 0) > 0);
  log({ outcome: "ok", case: "nfr03-threshold", subjectId: null });
});

test("edge: validation_failed for invalid subject/device; bench uses public transport", () => {
  assert.throws(
    () => buildEdgeStateWithPendingSamples("bad", "", 10),
    (err) => err.failureClass === "validation_failed",
  );
  const src = readFileSync(BENCH, "utf8");
  assert.match(src, /createHttpSyncTransport|\/v1\/sync/);
  assert.doesNotMatch(src, /test-only backdoor|BYPASS/i);
  log({ outcome: "ok", case: "validation", subjectId: null });
});

test("sovereignty: edge state scoped by subjectId; friction log has no utterance field", () => {
  const a = buildEdgeStateWithPendingSamples("edge-a", "subj-a", 4);
  const b = buildEdgeStateWithPendingSamples("edge-b", "subj-b", 4);
  assert.equal(a.subjectId, "subj-a");
  assert.equal(b.subjectId, "subj-b");
  assert.equal(a.frictionLog.length, 4);
  assert.ok(a.frictionLog.every((s) => !("utterance" in s) && !("text" in s)));
  log({ outcome: "ok", case: "subject-isolation", subjectId: null });
});
