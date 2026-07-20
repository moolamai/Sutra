/**
 * agent_turn.bench — NFR-06 perceive→reflect composition overhead.
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_TURN_CONCURRENCY_CAP,
  createAgentTurnCore,
  createZeroSleepBindings,
  runAgentTurn,
} from "../_shared/agent_turn_probe.mjs";
import { evaluateP95Gate } from "./check.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THRESHOLDS = path.join(__dirname, "thresholds.json");
const AGENT_BENCH = path.join(__dirname, "../agent_turn.bench.mjs");
const PROBE = path.join(__dirname, "../_shared/agent_turn_probe.mjs");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.agent_turn.test", ...event })}\n`,
  );
}

test("happy path: perceive→reflect turn returns reply; zero sleep calls", async () => {
  const pack = createAgentTurnCore({ subjectId: "bench-subject" });
  const out = await runAgentTurn({
    subjectId: "bench-subject",
    sessionId: "sess-happy",
    utterance: "benchmark utterance",
    corePack: pack,
  });
  assert.equal(out.subjectId, "bench-subject");
  assert.equal(out.outcome, "ok");
  assert.equal(out.stagesHint, "perceive-through-reflect");
  assert.equal(typeof out.reply, "string");
  assert.ok(out.reply.length > 0);
  assert.equal(pack.getSleepCalls(), 0);
  log({ outcome: "ok", case: "perceive-reflect", subjectId: out.subjectId });
});

test("edge: sleeping mock surface is never used; bench source has no sleep/delay", () => {
  const bindings = createZeroSleepBindings({ subjectId: "s" }).bindings;
  assert.equal(typeof bindings.model.generate, "function");
  assert.throws(() => bindings.model.sleep(), /zero-sleep|forbidden/i);

  const benchSrc = readFileSync(AGENT_BENCH, "utf8");
  const probeSrc = readFileSync(PROBE, "utf8");
  assert.doesNotMatch(benchSrc, /setTimeout|Atomics\.wait|Busy.?sleep/i);
  assert.match(probeSrc, /zero-sleep|zero sleep/i);
  assert.match(benchSrc, /runAgentTurn|perceive/);
  log({ outcome: "ok", case: "zero-sleep-mocks", subjectId: null });
});

test("edge: missing subjectId validates; concurrent same-subject turns stay bounded", async () => {
  await assert.rejects(
    () => runAgentTurn({ utterance: "x" }),
    (err) => err.failureClass === "validation_failed",
  );

  const pack = createAgentTurnCore({ subjectId: "subj-concurrent" });
  const n = Math.min(AGENT_TURN_CONCURRENCY_CAP, 3);
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      runAgentTurn({
        subjectId: "subj-concurrent",
        sessionId: `sess-c-${i}`,
        utterance: "benchmark utterance",
        corePack: pack,
      }),
    ),
  );
  assert.equal(results.length, n);
  assert.ok(results.every((r) => r.subjectId === "subj-concurrent" && r.outcome === "ok"));
  log({ outcome: "ok", case: "concurrent-bounded", subjectId: "subj-concurrent" });
});

test("edge: seeded slowdown trips NFR-06 agent_turn ceiling; headroom printed", () => {
  const doc = JSON.parse(readFileSync(THRESHOLDS, "utf8"));
  const entry = doc.benches.agent_turn;
  assert.ok(entry, "thresholds.json must map agent_turn → NFR-06");
  assert.equal(entry.nfrId, "NFR-06");
  assert.equal(entry.p95Ms, 10);
  assert.equal(entry.benchFile, "agent_turn.bench.mjs");

  const breach = evaluateP95Gate({
    benchId: "agent_turn",
    measuredP95: 42,
    budgetP95: entry.p95Ms,
    nfrId: entry.nfrId,
    subjectId: null,
    deviceId: "test-agent-turn-slow",
  });
  assert.equal(breach.ok, false);
  assert.equal(breach.failureClass, "p95_breach");
  assert.ok(breach.headroomPercent < 0);

  const ok = evaluateP95Gate({
    benchId: "agent_turn",
    measuredP95: 0.5,
    budgetP95: entry.p95Ms,
    nfrId: entry.nfrId,
    subjectId: null,
    deviceId: "test-agent-turn-ok",
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.headroomPercent > 0);
  log({ outcome: "ok", case: "nfr06-threshold", subjectId: null });
});

test("sovereignty: subject isolation on memory recall; telemetry omits utterance bodies", async () => {
  const pack = createAgentTurnCore({ subjectId: "subj-a" });
  await assert.rejects(
    () =>
      pack.bindings.memory.recall({
        subjectId: "subj-b",
        query: "secret learner essay",
        limit: 1,
      }),
    (err) => err.failureClass === "subject_isolation",
  );

  const out = await runAgentTurn({
    subjectId: "subj-a",
    sessionId: "sess-sov",
    utterance: "secret learner essay should not leak",
    corePack: pack,
  });
  const blob = JSON.stringify(out);
  assert.doesNotMatch(blob, /secret learner essay/);
  assert.equal(out.subjectId, "subj-a");
  log({ outcome: "ok", case: "subject-isolation", subjectId: null });
});

test("edge: idempotent replay of identical turn stays ok (no double-apply errors)", async () => {
  const pack = createAgentTurnCore({ subjectId: "subj-replay" });
  const req = {
    subjectId: "subj-replay",
    sessionId: "sess-replay",
    utterance: "benchmark utterance",
    corePack: pack,
  };
  const first = await runAgentTurn(req);
  const second = await runAgentTurn(req);
  assert.equal(first.outcome, "ok");
  assert.equal(second.outcome, "ok");
  assert.equal(first.subjectId, second.subjectId);
  log({ outcome: "ok", case: "idempotent-replay", subjectId: "subj-replay" });
});
