/**
 * SYNC-06 advisories → sutra.sync.advisory span events.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  ALLOWED_SYNC_ATTR_KEYS,
  KNOWN_SYNC_ADVISORY_CODES,
  SYNC_ADVISORY_EVENT,
  SYNC_ADVISORY_EVENT_LIMIT,
  assertSpanExportPrivacy,
  createSyncInstrumentation,
  initObservability,
  recordSyncAdvisoryEvents,
  shutdownObservability,
} from "@moolam/observability";
import {
  PROTOCOL_VERSION,
  SYNC_ADVISORY_CODES,
  SyncEngine,
  encodeHLC,
} from "../dist/index.js";

const DETAIL_LEAK =
  "shard blob alpha={edge:9} UNKNOWN_CONCEPT_QUARANTINED detail with SECRET_MASTERY_SHARD";
const HLC = encodeHLC(1_700_000_000_000, 3, "edge-device-cccc");

function makeState(subjectId = "subj-adv-a") {
  const device = "edge-device-cccc";
  const t = encodeHLC(1_700_000_000_000, 0, device);
  return {
    protocolVersion: PROTOCOL_VERSION,
    subjectId,
    deviceIds: [device],
    activeConceptId: "math.ratios",
    mode: "exploratory",
    mastery: {
      "math.ratios": {
        conceptId: "math.ratios",
        alpha: { [device]: 1 },
        beta: { [device]: 1 },
        lastExercisedAt: t,
      },
    },
    frictionLog: [],
    profile: {
      ageBand: "child",
      track: "demo",
      language: "en-IN",
      updatedAt: t,
    },
    stateVector: { session: t },
  };
}

function makeRequest(overrides = {}) {
  const state = makeState(overrides.subjectId);
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "edge-device-cccc",
    edgeState: state,
    lastKnownCloudVector: {},
    syncAttemptId: "77777777-7777-4777-8777-777777777777",
    ...overrides,
    edgeState: overrides.edgeState ?? state,
  };
}

test("happy path: converge maps SyncAdvisory codes to sutra.sync.advisory events", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const state = makeState();
  const engine = new SyncEngine(
    {
      postSync: async (req) => ({
        kind: "ok",
        response: {
          protocolVersion: PROTOCOL_VERSION,
          mergedState: req.edgeState,
          compactedSampleTimestamps: [],
          advisories: [
            {
              code: "DUPLICATE_SAMPLE_DROPPED",
              detail: `${DETAIL_LEAK} at ${HLC}`,
            },
            {
              code: "CLOCK_SKEW_CLAMPED",
              detail: `clamped toward ${HLC}`,
            },
          ],
        },
      }),
    },
    {
      syncInstrumentation: createSyncInstrumentation(obs),
      sleep: async () => {},
    },
  );

  const outcome = await engine.synchronize(makeRequest());
  assert.equal(outcome.status, "converged");

  await obs.forceFlush();
  const root = capture
    .getFinishedSpans()
    .find((s) => s.name === "sutra.sync");
  await obs.shutdown();
  await shutdownObservability();

  assert.ok(root);
  const adv = (root.events ?? []).filter((e) => e.name === SYNC_ADVISORY_EVENT);
  assert.equal(adv.length, 2);
  assert.equal(adv[0].attributes["sutra.advisory_code"], "DUPLICATE_SAMPLE_DROPPED");
  assert.equal(adv[1].attributes["sutra.advisory_code"], "CLOCK_SKEW_CLAMPED");
  assert.equal(
    adv[0].attributes["sutra.sync_attempt_id"],
    "77777777-7777-4777-8777-777777777777",
  );
  assert.equal(adv[0].attributes["sutra.hlc_timestamp"], HLC);
  // Event name is fixed — never detail / codes as the span or event name content dump.
  assert.equal(adv[0].name, SYNC_ADVISORY_EVENT);
  assert.doesNotMatch(
    JSON.stringify(adv),
    /SECRET_MASTERY_SHARD|shard blob|alpha=\{/,
  );
  assertSpanExportPrivacy([root], {
    forbiddenSubstrings: ["SECRET_MASTERY_SHARD", "shard blob"],
  });
  for (const ev of adv) {
    for (const key of Object.keys(ev.attributes ?? {})) {
      assert.ok(ALLOWED_SYNC_ATTR_KEYS.includes(key), key);
    }
  }
});

test("edge: unknown advisory codes and empty list produce no events", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const engine = new SyncEngine(
    {
      postSync: async (req) => ({
        kind: "ok",
        response: {
          protocolVersion: PROTOCOL_VERSION,
          mergedState: req.edgeState,
          compactedSampleTimestamps: [],
          advisories: [
            { code: "NOT_A_REAL_CODE", detail: DETAIL_LEAK },
          ],
        },
      }),
    },
    {
      syncInstrumentation: createSyncInstrumentation(obs),
      sleep: async () => {},
    },
  );

  await engine.synchronize(makeRequest());
  await obs.forceFlush();
  const root = capture
    .getFinishedSpans()
    .find((s) => s.name === "sutra.sync");
  await obs.shutdown();

  const adv = (root?.events ?? []).filter((e) => e.name === SYNC_ADVISORY_EVENT);
  assert.equal(adv.length, 0);
});

test("edge: advisory event emission is bounded (NFR)", () => {
  const fakeSpan = {
    isRecording: () => true,
    events: /** @type {any[]} */ ([]),
    addEvent(name, attrs) {
      this.events.push({ name, attributes: attrs });
    },
  };
  const many = Array.from({ length: SYNC_ADVISORY_EVENT_LIMIT + 10 }, () => ({
    code: "STATE_VECTOR_REGRESSION",
    detail: DETAIL_LEAK,
  }));
  const n = recordSyncAdvisoryEvents(
    /** @type {any} */ (fakeSpan),
    {
      subjectId: "s",
      deviceId: "d",
      syncAttemptId: "77777777-7777-4777-8777-777777777777",
    },
    many,
  );
  assert.equal(n, SYNC_ADVISORY_EVENT_LIMIT);
  assert.equal(fakeSpan.events.length, SYNC_ADVISORY_EVENT_LIMIT);
});

test("edge: idempotent duplicate advisory list still emits without throw", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const instr = createSyncInstrumentation(obs);
  const advisories = [
    { code: "UNKNOWN_CONCEPT_QUARANTINED", detail: DETAIL_LEAK },
  ];
  await instr.withSync(
    {
      subjectId: "subj-idem",
      deviceId: "edge-device-cccc",
      syncAttemptId: "88888888-8888-4888-8888-888888888888",
    },
    async (series) => {
      await series.runAttempt(1, async () => null);
      series.recordAdvisories(advisories);
      series.recordAdvisories(advisories); // replay / duplicate respond
      series.complete({ outcome: "converged", attempts: 1 });
    },
  );
  await obs.forceFlush();
  const root = capture
    .getFinishedSpans()
    .find((s) => s.name === "sutra.sync");
  await obs.shutdown();
  const adv = (root?.events ?? []).filter((e) => e.name === SYNC_ADVISORY_EVENT);
  assert.equal(adv.length, 2);
  assert.doesNotMatch(JSON.stringify(adv), /SECRET_MASTERY/);
});

test("sovereignty: advisory events are scoped to the emitting subject's ids", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const instr = createSyncInstrumentation(obs);

  await Promise.all([
    instr.withSync(
      {
        subjectId: "subj-x",
        deviceId: "dev-x",
        syncAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      async (series) => {
        series.recordAdvisories([
          { code: "CLOCK_SKEW_CLAMPED", detail: "x" },
        ]);
        series.complete({ outcome: "converged", attempts: 1 });
      },
    ),
    instr.withSync(
      {
        subjectId: "subj-y",
        deviceId: "dev-y",
        syncAttemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
      async (series) => {
        series.recordAdvisories([
          { code: "DUPLICATE_SAMPLE_DROPPED", detail: "y" },
        ]);
        series.complete({ outcome: "converged", attempts: 1 });
      },
    ),
  ]);

  await obs.forceFlush();
  const roots = capture
    .getFinishedSpans()
    .filter((s) => s.name === "sutra.sync");
  await obs.shutdown();

  assert.equal(roots.length, 2);
  for (const root of roots) {
    const subject = root.attributes["sutra.subject_id"];
    for (const ev of root.events ?? []) {
      if (ev.name !== SYNC_ADVISORY_EVENT) continue;
      assert.equal(ev.attributes["sutra.subject_id"], subject);
    }
  }
  assert.deepEqual([...SYNC_ADVISORY_CODES], [...KNOWN_SYNC_ADVISORY_CODES]);
});
