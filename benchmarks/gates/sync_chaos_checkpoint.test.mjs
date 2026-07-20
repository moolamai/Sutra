/**
 * Sync chaos — corrupt LangGraph checkpoint → clean start + advisory.
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADVISORY_CORRUPT_RESET,
  checkpointRedisKey,
  checkpointThreadId,
  createCorruptCheckpointHarness,
  runCorruptCheckpointDrill,
  formatSyncChaosGateReport,
} from "../_shared/sync_chaos_probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRILL = path.join(__dirname, "../chaos/sync_chaos.mjs");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.sync_chaos.checkpoint.test", ...event })}\n`,
  );
}

test("happy path: corrupt blob → clean start + CHECKPOINT_CORRUPT_RESET, no crash-loop", async () => {
  const result = await runCorruptCheckpointDrill({
    subjectId: "subj-ckpt-happy",
    sessionId: "sess-happy",
    deviceId: "edge-ckpt-happy",
  });
  assert.equal(result.ok, true, result.failureClass);
  assert.equal(result.drill, "corrupt_checkpoint");
  assert.equal(result.crashed, false);
  assert.equal(result.turn1.startClean, true);
  assert.ok(result.advisories.includes(ADVISORY_CORRUPT_RESET));
  assert.deepEqual(result.turn1.effects, [
    "assess_friction",
    "remediate_prereq",
    "generate_guidance",
  ]);
  assert.ok(result.harness.deleted.includes(result.key));
  assert.ok(result.turn2.effects.includes("generate_guidance"));
  assert.match(formatSyncChaosGateReport(result), /PASS/);
  log({
    outcome: "ok",
    case: "corrupt-clean-start",
    subjectId: result.subjectId,
  });
});

test("edge: corrupt mid-checkpoint does not duplicate side effects on resume", async () => {
  const harness = createCorruptCheckpointHarness();
  const subjectId = "subj-ckpt-nodup";
  const sessionId = "sess-nodup";
  const result = await runCorruptCheckpointDrill({
    harness,
    subjectId,
    sessionId,
  });
  assert.equal(result.ok, true, result.failureClass);
  const gen = (result.turn1.effects ?? []).filter(
    (e) => e === "generate_guidance",
  ).length;
  assert.equal(gen, 1);
  assert.ok(
    harness.events.some((e) => e.kind === "corrupt_reset"),
  );
  assert.ok(
    harness.events.some((e) => e.kind === "clean_start"),
  );
  // Must not have resumed the truncated mid-effects chain.
  assert.ok(!harness.events.some((e) => e.kind === "resume"));
  log({
    outcome: "ok",
    case: "no-duplicate-effects",
    subjectId,
  });
});

test("edge: validation_failed for bad subject; sticky corrupt never crash-loops", () => {
  assert.throws(
    () => checkpointRedisKey("", "thread"),
    (err) => err.failureClass === "validation_failed",
  );
  assert.throws(
    () => checkpointThreadId(""),
    (err) => err.failureClass === "validation_failed",
  );

  const harness = createCorruptCheckpointHarness();
  const subjectId = "subj-ckpt-sticky";
  const sessionId = "sess-sticky";
  // Repeatedly inject corrupt + turn — must stay non-throwing.
  for (let i = 0; i < 5; i++) {
    harness.injectCorrupt(subjectId, sessionId);
    const turn = harness.runTurn({ subjectId, sessionId });
    assert.equal(turn.crashLoop, false);
    assert.ok(turn.effects.includes("generate_guidance"));
  }
  assert.ok(
    harness.advisories.filter((a) => a === ADVISORY_CORRUPT_RESET).length >= 5,
  );
  log({ outcome: "ok", case: "no-crash-loop", subjectId: null });
});

test("sovereignty: checkpoint keys namespaced by subjectId; no utterance in drill", async () => {
  const a = await runCorruptCheckpointDrill({
    subjectId: "subj-ckpt-a",
    sessionId: "sess-a",
  });
  const b = await runCorruptCheckpointDrill({
    subjectId: "subj-ckpt-b",
    sessionId: "sess-b",
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.key, b.key);
  assert.match(a.key, /^sutra:v1:router_ckpt:subj-ckpt-a:/);
  assert.match(b.key, /^sutra:v1:router_ckpt:subj-ckpt-b:/);

  const blob = JSON.stringify({
    key: a.key,
    advisory: a.advisories,
    effects: a.turn1.effects,
  });
  assert.ok(!blob.includes("utterance"));
  assert.ok(!blob.includes("keystroke"));

  const src = readFileSync(DRILL, "utf8");
  assert.match(
    src,
    /corrupt_checkpoint|runCorruptCheckpointDrill|runComposeCorruptCheckpointDrill/,
  );
  assert.doesNotMatch(src, /test-only backdoor|BYPASS/i);
  log({ outcome: "ok", case: "subject-isolation", subjectId: null });
});
