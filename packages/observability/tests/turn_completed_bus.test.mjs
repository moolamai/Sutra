/**
 * PublishTurnCompleted + span enrichment privacy.
 * Run: pnpm --filter @moolam/observability test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InProcessEventBus } from "@moolam/runtime";
import {
  createTurnInstrumentation,
  createValidatingEventBus,
  findRawContentLeaks,
  hashOpCode,
  initObservability,
  parseCatalogEvent,
  publishTurnCompleted,
  shutdownObservability,
  TURN_COMPLETED,
} from "../dist/index.js";

test("happy path: publishTurnCompleted is catalog-valid metadata-only", () => {
  const bus = createValidatingEventBus({ mode: "throw" });
  const seen = [];
  bus.subscribe(TURN_COMPLETED, (e) => seen.push(e));

  publishTurnCompleted(bus, {
    subjectId: "subj-tc",
    sessionId: "sess-tc",
    deviceId: "dev-tc",
    conceptId: "math.ratios",
    latencyMs: 12.5,
    servedLocally: true,
    turnId: "opaque-turn-1",
  });

  assert.equal(seen.length, 1);
  const parsed = parseCatalogEvent(seen[0]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.event.payload.turnIdHash, hashOpCode("opaque-turn-1"));
  assert.doesNotMatch(JSON.stringify(seen[0]), /opaque-turn-1/);
});

test("edge: turn.completed enriches active turn span without learner content", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const bus = new InProcessEventBus();
  const instr = createTurnInstrumentation(obs, { eventBus: bus });

  await instr.withTurn(
    { subjectId: "subj-span", sessionId: "sess-span", deviceId: "dev-span" },
    async (stages) => {
      await stages.run("respond", async () => {
        publishTurnCompleted(bus, {
          subjectId: "subj-span",
          sessionId: "sess-span",
          deviceId: "dev-span",
          conceptId: "sd.hash",
          latencyMs: 9,
          servedLocally: true,
          turnId: "turn-for-span",
        });
        return "ok";
      });
    },
  );

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  const leaks = findRawContentLeaks(spans, {
    forbiddenSubstrings: ["turn-for-span", "utterance", "SECRET"],
  });
  assert.equal(leaks.length, 0);

  const respond = spans.find((s) => s.name === "sutra.turn.respond");
  assert.ok(respond);
  const names = (respond.events ?? []).map((e) => e.name);
  assert.ok(names.includes(TURN_COMPLETED));

  instr.dispose();
  await obs.shutdown();
  await shutdownObservability();
});

test("edge: raw reply/utterance keys rejected by validating bus", () => {
  const bus = createValidatingEventBus({ mode: "throw" });
  assert.throws(
    () =>
      bus.publish({
        type: TURN_COMPLETED,
        at: new Date().toISOString(),
        payload: {
          subjectId: "s",
          conceptId: "c",
          latencyMs: 1,
          servedLocally: true,
          turnIdHash: "a1b2c3d4e5f67890",
          utterance: "leak",
        },
      }),
    /forbidden|schema|catalog/i,
  );
});
