/**
 * Unit tests for recordSyncAdvisoryEvents.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_SYNC_ADVISORY_CODES,
  SYNC_ADVISORY_EVENT,
  recordSyncAdvisoryEvents,
} from "../dist/index.js";

function fakeSpan() {
  return {
    isRecording: () => true,
    events: /** @type {any[]} */ ([]),
    addEvent(name, attrs) {
      this.events.push({ name, attributes: attrs });
    },
  };
}

test("happy path: known codes become sutra.sync.advisory events", () => {
  const span = fakeSpan();
  const n = recordSyncAdvisoryEvents(
    /** @type {any} */ (span),
    {
      subjectId: "s1",
      deviceId: "d1",
      syncAttemptId: "11111111-1111-4111-8111-111111111111",
    },
    KNOWN_SYNC_ADVISORY_CODES.map((code) => ({
      code,
      detail: `noise with 000001700000000:000001:dev-aaaa and shard`,
    })),
  );
  assert.equal(n, 5);
  assert.equal(span.events.length, 5);
  assert.ok(span.events.every((e) => e.name === SYNC_ADVISORY_EVENT));
  assert.doesNotMatch(JSON.stringify(span.events), /noise|shard/);
  assert.equal(
    span.events[0].attributes["sutra.hlc_timestamp"],
    "000001700000000:000001:dev-aaaa",
  );
});

test("edge: detail-only / unknown codes never become event names", () => {
  const span = fakeSpan();
  recordSyncAdvisoryEvents(
    /** @type {any} */ (span),
    {
      subjectId: "s1",
      deviceId: "d1",
      syncAttemptId: "11111111-1111-4111-8111-111111111111",
    },
    [
      { code: "BOGUS", detail: "CLOCK_SKEW_CLAMPED should not be a span name" },
      { code: "  ", detail: "empty" },
    ],
  );
  assert.equal(span.events.length, 0);
  assert.ok(!span.events.some((e) => /CLOCK_SKEW|BOGUS|empty/.test(e.name)));
});
