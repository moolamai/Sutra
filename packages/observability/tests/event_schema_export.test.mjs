/**
 * Event schema export map integrity (observability side).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CATALOG_EVENT_TYPES,
  CATALOG_WORKED_EXAMPLES,
  EVENT_SCHEMA_DOT_TYPE,
  EVENT_SCHEMA_EXPORT_MAP,
  EVENT_SCHEMA_TYPE_NAMES,
  FORBIDDEN_CATALOG_PAYLOAD_KEYS,
  eventSyncAdvisorySchema,
  eventTurnStageStartSchema,
  parseCatalogEvent,
} from "../dist/index.js";

test("happy path: export map covers every catalog type exactly once", () => {
  assert.equal(EVENT_SCHEMA_TYPE_NAMES.length, CATALOG_EVENT_TYPES.length);
  assert.equal(
    Object.keys(EVENT_SCHEMA_EXPORT_MAP).length,
    CATALOG_EVENT_TYPES.length,
  );
  const dots = Object.values(EVENT_SCHEMA_DOT_TYPE).sort();
  assert.deepEqual(dots, [...CATALOG_EVENT_TYPES].sort());
  for (const title of EVENT_SCHEMA_TYPE_NAMES) {
    assert.ok(EVENT_SCHEMA_EXPORT_MAP[title], title);
    assert.ok(EVENT_SCHEMA_DOT_TYPE[title], title);
  }
});

test("edge: envelope schemas accept worked examples and reject learner keys", () => {
  const start = CATALOG_WORKED_EXAMPLES["turn.stage.start"];
  assert.equal(eventTurnStageStartSchema.safeParse(start).success, true);
  assert.equal(parseCatalogEvent(start).ok, true);

  const bad = {
    type: "sync.advisory",
    at: "2026-07-15T10:00:00.000Z",
    payload: {
      ...CATALOG_WORKED_EXAMPLES["sync.advisory"].payload,
      detail: "skew text must not be schema-valid",
    },
  };
  assert.equal(eventSyncAdvisorySchema.safeParse(bad).success, false);
  assert.ok(FORBIDDEN_CATALOG_PAYLOAD_KEYS.includes("detail"));
  assert.ok(FORBIDDEN_CATALOG_PAYLOAD_KEYS.includes("utterance"));
});
