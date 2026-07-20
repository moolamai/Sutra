/**
 * baseline:record — capture committed regression reference.
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { BASELINE_UPDATE_NOTE } from "../_shared/bench.mjs";
import { recordBaselineCapture } from "./record_baseline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_JSON = path.join(__dirname, "../package.json");
import { loadAllCi } from "../../scripts/ci-workflow-test-helpers.mjs";
const README = path.join(__dirname, "../README.md");
const THRESHOLDS = path.join(__dirname, "thresholds.json");
const BENCH_DIR = path.resolve(__dirname, "..");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.baseline.record.test", ...event })}\n`,
  );
}

test("happy path: record dry-run builds baseline with update note after green absolute gate", async () => {
  const result = await recordBaselineCapture({
    thresholdsPath: THRESHOLDS,
    benchmarksDir: BENCH_DIR,
    dryRun: true,
    deviceId: "test-record",
    executeBench: async (benchId) => ({
      ok: true,
      benchId,
      measuredP95: {
        core_loop: 0.04,
        crdt_merge: 5,
        memory_retrieval: 40,
        sync_roundtrip: 4,
        router: 0.05,
        agent_turn: 0.06,
        sync_convergence: 35,
        py_sync_merge: 2,
        py_agent_runtime: 3,
      }[benchId],
      samples: [],
    }),
  });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.dryRun, true);
  assert.equal(result.document.note, BASELINE_UPDATE_NOTE);
  assert.equal(result.document.deviceId, "test-record");
  assert.equal(result.document.benches.core_loop.nfrId, "NFR-06");
  assert.equal(result.document.benches.core_loop.p95Ms, 0.04);
  log({ outcome: "ok", case: "dry-run-record", subjectId: null });
});

test("edge: refuses to record when absolute gate is red", async () => {
  const result = await recordBaselineCapture({
    thresholdsPath: THRESHOLDS,
    benchmarksDir: BENCH_DIR,
    dryRun: true,
    deviceId: "test-refuse",
    executeBench: async (benchId) => ({
      ok: true,
      benchId,
      measuredP95: benchId === "core_loop" ? 99 : 1,
      samples: [],
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /refuse|red/i);
  log({ outcome: "rejected", case: "refuse-red-tree", subjectId: null });
});

test("edge: write path persists file; CI never rewrites baseline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "baseline-rec-"));
  const outPath = path.join(root, "baseline.json");
  try {
    const result = await recordBaselineCapture({
      thresholdsPath: THRESHOLDS,
      benchmarksDir: BENCH_DIR,
      outPath,
      dryRun: false,
      deviceId: "test-write",
      executeBench: async (benchId) => ({
        ok: true,
        benchId,
        measuredP95: {
          core_loop: 0.05,
          crdt_merge: 6,
          memory_retrieval: 45,
          sync_roundtrip: 5,
          router: 0.06,
          agent_turn: 0.07,
          sync_convergence: 38,
          py_sync_merge: 2.5,
          py_agent_runtime: 3.5,
        }[benchId],
        samples: [],
      }),
    });
    assert.equal(result.ok, true, result.detail);
    const written = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(written.schemaVersion, "bench-baseline.v1");
    assert.ok(written.note.includes("never auto-rewrites"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.match(pkg.scripts["baseline:record"], /record_baseline\.mjs/);
  const ci = loadAllCi();
  assert.match(ci, /never rewrites/i);
  // Comment may mention baseline:record as the offline refresh path;
  // CI must not execute that script as a job step.
  assert.doesNotMatch(ci, /run:\s*[^\n]*baseline:record/);
  assert.match(ci, /ci:gate/);
  const readme = readFileSync(README, "utf8");
  assert.match(readme, /Updating `gates\/baseline\.json`/);
  assert.match(readme, /baseline:record/);
  log({ outcome: "ok", case: "write-and-docs", subjectId: null });
});
