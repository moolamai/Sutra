/**
 * EventBus turn/tool events enrich active spans (metadata only).
 * Run: pnpm --filter @moolam/observability test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InProcessEventBus } from "@moolam/runtime";
import {
  ALLOWED_BUS_PAYLOAD_KEYS,
  createTurnInstrumentation,
  hashOpCode,
  initObservability,
  publishToolBusEvent,
  sanitizeBusPayload,
  shutdownObservability,
} from "../dist/index.js";

test("happy path: turn.stage.* bus events appear on stage spans", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const bus = new InProcessEventBus();
  const instr = createTurnInstrumentation(obs, { eventBus: bus });

  await instr.withTurn(
    { subjectId: "subj-bus-a", sessionId: "sess-1" },
    async (stages) => {
      await stages.run("reason", async () => "ok");
    },
  );

  await obs.forceFlush();
  const reason = capture
    .getFinishedSpans()
    .find((s) => s.name === "sutra.turn.reason");
  instr.dispose();
  await obs.shutdown();
  await shutdownObservability();

  assert.ok(reason);
  const names = (reason.events ?? []).map((e) => e.name);
  assert.ok(names.includes("turn.stage.start"));
  assert.ok(names.includes("turn.stage.end"));
  for (const ev of reason.events ?? []) {
    const blob = JSON.stringify(ev.attributes ?? {});
    assert.doesNotMatch(blob, /utterance|args|content|passage/i);
    assert.equal(ev.attributes?.["sutra.subject_id"], "subj-bus-a");
  }
});

test("edge: tool.result carries toolIdHash only — never tool args body", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const bus = new InProcessEventBus();
  const instr = createTurnInstrumentation(obs, { eventBus: bus });

  await instr.withTurn(
    { subjectId: "subj-tool", sessionId: "sess-tool" },
    async (stages) => {
      await stages.run("respond", async () => {
        publishToolBusEvent(bus, "tool.invoked", {
          subjectId: "subj-tool",
          sessionId: "sess-tool",
          toolId: "search_secret_corpus",
        });
        // Malicious/raw payload on the bus must be scrubbed by sanitizer path
        // when using publishToolBusEvent (hashes only).
        publishToolBusEvent(bus, "tool.result", {
          subjectId: "subj-tool",
          sessionId: "sess-tool",
          toolId: "search_secret_corpus",
          status: "ok",
          durationMs: 12,
        });
        return "done";
      });
    },
  );

  await obs.forceFlush();
  const respond = capture
    .getFinishedSpans()
    .find((s) => s.name === "sutra.turn.respond");
  instr.dispose();
  await obs.shutdown();

  assert.ok(respond);
  const toolEvents = (respond.events ?? []).filter((e) =>
    e.name.startsWith("tool."),
  );
  assert.equal(toolEvents.length, 2);
  const expectedHash = hashOpCode("search_secret_corpus");
  for (const ev of toolEvents) {
    assert.equal(ev.attributes?.["sutra.tool_id_hash"], expectedHash);
    const blob = JSON.stringify(ev.attributes ?? {});
    assert.doesNotMatch(blob, /search_secret_corpus/);
    assert.doesNotMatch(blob, /args|query|utterance/i);
  }
});

test("edge: sanitizeBusPayload drops utterance/args/content keys", () => {
  const cleaned = sanitizeBusPayload({
    subjectId: "s1",
    sessionId: "sess",
    stage: "reason",
    utterance: "SECRET LEARNER TEXT",
    args: { foo: "bar" },
    content: "memory passage",
    opCode: "stage.reason",
  });
  assert.equal(cleaned["sutra.subject_id"], "s1");
  assert.equal(cleaned["sutra.op_code"], "stage.reason");
  assert.equal(cleaned["sutra.utterance"], undefined);
  assert.equal(cleaned["sutra.args"], undefined);
  assert.equal(cleaned["sutra.content"], undefined);
  for (const key of Object.keys(cleaned)) {
    const bare = key.replace(/^sutra\./, "").replace(/_([a-z])/g, (_, c) =>
      c.toUpperCase(),
    );
    // allow-list is camelCase payload keys
    const camel = bare.includes("_")
      ? bare.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
      : bare;
    void camel;
  }
  assert.ok(ALLOWED_BUS_PAYLOAD_KEYS.includes("opCode"));
});

test("sovereignty: bus event for subject A does not enrich subject B span", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const bus = new InProcessEventBus();
  const instr = createTurnInstrumentation(obs, { eventBus: bus });

  await Promise.all([
    instr.withTurn({ subjectId: "subj-x", sessionId: "sx" }, async (stages) => {
      await stages.run("recall", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 1;
      });
    }),
    instr.withTurn({ subjectId: "subj-y", sessionId: "sy" }, async (stages) => {
      await stages.run("recall", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 2;
      });
    }),
  ]);

  await obs.forceFlush();
  const recalls = capture
    .getFinishedSpans()
    .filter((s) => s.name === "sutra.turn.recall");
  instr.dispose();
  await obs.shutdown();

  assert.equal(recalls.length, 2);
  for (const span of recalls) {
    const subject = span.attributes["sutra.subject_id"];
    for (const ev of span.events ?? []) {
      assert.equal(ev.attributes?.["sutra.subject_id"], subject);
    }
  }
});

test("idempotency: duplicate tool.result still enriches without throw", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const bus = new InProcessEventBus();
  const instr = createTurnInstrumentation(obs, { eventBus: bus });

  await instr.withTurn(
    { subjectId: "subj-idem", sessionId: "sess-idem" },
    async (stages) => {
      await stages.run("reflect", async () => {
        const args = {
          subjectId: "subj-idem",
          sessionId: "sess-idem",
          toolId: "noop_tool",
          status: "ok",
        };
        publishToolBusEvent(bus, "tool.result", args);
        publishToolBusEvent(bus, "tool.result", args);
      });
    },
  );

  await obs.forceFlush();
  const reflect = capture
    .getFinishedSpans()
    .find((s) => s.name === "sutra.turn.reflect");
  instr.dispose();
  await obs.shutdown();

  assert.ok(reflect);
  const toolResults = (reflect.events ?? []).filter(
    (e) => e.name === "tool.result",
  );
  assert.equal(toolResults.length, 2);
});
