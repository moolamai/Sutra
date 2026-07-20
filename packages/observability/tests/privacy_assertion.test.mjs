/**
 * Privacy assertion helpers + synthetic span edges.
 * Run: pnpm --filter @moolam/observability test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InProcessEventBus } from "@moolam/runtime";
import {
  assertSpanExportPrivacy,
  assertTurnAttrKeysAllowed,
  createTurnInstrumentation,
  findRawContentLeaks,
  initObservability,
  publishToolBusEvent,
  shutdownObservability,
} from "../dist/index.js";

const UTTERANCE = "GOLDEN_UTTER_QX7_LEARNER_SAID_THIS";
const MEMORY = "GOLDEN_MEM_PASSAGE_YZ9_PRIVATE_RECALL";
const KEYSTROKE = "typewriter_seq_shift+a_ctrl+v_PIN_448812";
const TOOL_ARGS = '{"query":"GOLDEN_TOOL_ARGS_JSON_SECRET"}';

const PROBES = {
  forbiddenSubstrings: [UTTERANCE, MEMORY, KEYSTROKE, TOOL_ARGS],
  forbiddenPatterns: [/PIN_\d{6}/, /GOLDEN_TOOL_ARGS/],
};

test("happy path: instrumented stages + tool bus events stay metadata-only", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
    serviceName: "privacy-assertion",
  });
  const bus = new InProcessEventBus();
  const instr = createTurnInstrumentation(obs, { eventBus: bus });

  await instr.withTurn(
    { subjectId: "subj-priv", sessionId: "sess-priv", deviceId: "dev-1" },
    async (stages) => {
      await stages.run("perceive", async () => UTTERANCE);
      await stages.run("recall", async () => MEMORY);
      await stages.run("respond", async () => {
        // Host publishes tool outcomes with hashed tool ids only.
        publishToolBusEvent(bus, "tool.invoked", {
          subjectId: "subj-priv",
          sessionId: "sess-priv",
          toolId: "search_corpus",
        });
        // Raw payload injection must be scrubbed by sanitizeBusPayload path —
        // publishToolBusEvent never accepts args/content.
        publishToolBusEvent(bus, "tool.result", {
          subjectId: "subj-priv",
          sessionId: "sess-priv",
          toolId: "search_corpus",
          status: "ok",
          durationMs: 3,
        });
        bus.publish({
          type: "tool.result",
          at: new Date().toISOString(),
          payload: {
            subjectId: "subj-priv",
            sessionId: "sess-priv",
            utterance: UTTERANCE,
            args: TOOL_ARGS,
            content: MEMORY,
            status: "ok",
          },
        });
        return KEYSTROKE;
      });
    },
  );

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  instr.dispose();
  await obs.shutdown();
  await shutdownObservability();

  assert.ok(spans.some((s) => s.name === "sutra.turn"));
  assertSpanExportPrivacy(spans, PROBES);
  assertTurnAttrKeysAllowed(spans);
});

test("edge: findRawContentLeaks detects implanted attribute leakage", () => {
  /** Synthetic finished span mimicking a buggy enrichment (negative proof). */
  const fakeSpan = {
    name: "sutra.turn.reason",
    attributes: { "sutra.op_code": UTTERANCE },
    events: [
      {
        name: "tool.result",
        attributes: { "sutra.status": KEYSTROKE },
      },
    ],
    status: { code: 0, message: "" },
  };
  const leaks = findRawContentLeaks(/** @type {any} */ ([fakeSpan]), {
    forbiddenSubstrings: [UTTERANCE, KEYSTROKE],
  });
  assert.ok(leaks.length >= 2);
  assert.ok(leaks.some((l) => l.matched === UTTERANCE));
  assert.ok(leaks.some((l) => l.matched === KEYSTROKE));
  assert.throws(
    () =>
      assertSpanExportPrivacy(/** @type {any} */ ([fakeSpan]), {
        forbiddenSubstrings: [UTTERANCE],
      }),
    /span privacy violation/,
  );
});

test("edge: mid-turn failure status message never embeds raw learner text", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const instr = createTurnInstrumentation(obs);

  await assert.rejects(
    () =>
      instr.withTurn({ subjectId: "s-err", sessionId: "sess-err" }, async (stages) => {
        await stages.run("retrieve", async () => {
          throw new Error(`boom containing ${UTTERANCE} and ${KEYSTROKE}`);
        });
      }),
    /boom containing/,
  );

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  instr.dispose();
  await obs.shutdown();

  assertSpanExportPrivacy(spans, PROBES);
  const root = spans.find((s) => s.name === "sutra.turn");
  assert.ok(root);
  assert.equal(root.status.code, 2);
  assert.match(String(root.status.message ?? ""), /stage_failed:retrieve/);
});

test("sovereignty: concurrent subjects keep probes out of peer spans", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const instr = createTurnInstrumentation(obs);
  const secretA = "SUBJECT_A_ONLY_SECRET_TOK_11";
  const secretB = "SUBJECT_B_ONLY_SECRET_TOK_22";

  await Promise.all([
    instr.withTurn({ subjectId: "subj-a", sessionId: "sa" }, async (stages) => {
      await stages.run("recall", async () => secretA);
    }),
    instr.withTurn({ subjectId: "subj-b", sessionId: "sb" }, async (stages) => {
      await stages.run("recall", async () => secretB);
    }),
  ]);

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  instr.dispose();
  await obs.shutdown();

  assertSpanExportPrivacy(spans, {
    forbiddenSubstrings: [secretA, secretB],
  });
  const roots = spans.filter((s) => s.name === "sutra.turn");
  assert.equal(roots.length, 2);
  assert.notEqual(
    roots[0].spanContext().traceId,
    roots[1].spanContext().traceId,
  );
});
