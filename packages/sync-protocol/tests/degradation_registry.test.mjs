/**
 * DegradationMode enum + DegradationRegistry.lookup Zod schema.
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/degradation_registry.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as contracts from "../../contracts/dist/index.js";
import { DEGRADATION_MODES } from "../../contracts/dist/index.js";
import {
  DEFAULT_DEGRADATION_REGISTRY,
  assertStaleReadPayload,
  createDegradationRegistry,
  degradationRegistryDocumentSchema,
  freshnessMarkerSchema,
} from "../dist/index.js";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: default registry parses; every mode is registered", () => {
  const doc = degradationRegistryDocumentSchema.parse(DEFAULT_DEGRADATION_REGISTRY);
  assert.equal(doc.version, "1.0.0");
  for (const mode of DEGRADATION_MODES) {
    assert.equal(doc.modes[mode].mode, mode);
    assert.equal(doc.modes[mode].allowsFabrication, false);
    assert.equal(doc.modes[mode].allowsSilentWriteRetry, false);
  }
  assert.deepEqual([...DEGRADATION_MODES], [...contracts.DEGRADATION_MODES]);
  emit({
    event: "degradation.registry",
    outcome: "ok",
    kind: "parse",
    subjectId: "anika-k",
    modeCount: DEGRADATION_MODES.length,
  });
});

test("happy path: lookup(surface, operation) returns documented behavior", () => {
  const registry = createDegradationRegistry();
  const storageRead = registry.lookup("storage", "read", {
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
  assert.equal(storageRead.outcome, "accepted");
  assert.equal(storageRead.behavior.mode, "STALE_READ");
  assert.equal(storageRead.behavior.requiresFreshnessMarker, true);
  assert.equal(storageRead.behavior.readPolicy, "stale-with-marker");

  const storageWrite = registry.lookup("storage", "write", {
    subjectId: "anika-k",
  });
  assert.equal(storageWrite.behavior.mode, "HARD_STOP_WRITE");
  assert.equal(storageWrite.behavior.writePolicy, "hard-stop-rollback");
  assert.equal(storageWrite.behavior.allowsSilentWriteRetry, false);

  const modelRead = registry.lookup("model", "read", { subjectId: "anika-k" });
  assert.equal(modelRead.behavior.mode, "QUEUE_AND_WARN");
  assert.equal(modelRead.behavior.signalCode, "DEGRADE_QUEUE_AND_WARN");

  emit({
    event: "degradation.registry",
    outcome: "ok",
    kind: "lookup",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    surface: "storage",
    operation: "read",
    signalCode: storageRead.behavior.signalCode,
  });
});

test("edge: forced-down storage read requires freshnessMarker; fabrication rejected", () => {
  const registry = createDegradationRegistry();
  const behavior = registry.lookup("storage", "read", {
    subjectId: "anika-k",
  }).behavior;
  assert.equal(behavior.mode, "STALE_READ");

  const ok = assertStaleReadPayload(
    {
      value: { conceptId: "math.ratios" },
      freshnessMarker: {
        capturedAt: "000001700000000:000001:edge-aaaa",
        source: "last-known-good",
      },
    },
    { subjectId: "anika-k" },
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.marker.source, "last-known-good");

  const fabricated = assertStaleReadPayload(
    {
      fabricated: true,
      freshnessMarker: {
        capturedAt: "2026-07-15T10:00:00.000Z",
        source: "local-cache",
      },
    },
    { subjectId: "anika-k" },
  );
  assert.equal(fabricated.ok, false);
  assert.equal(fabricated.failureClass, "fabrication_forbidden");

  const missing = assertStaleReadPayload({ value: {} }, { subjectId: "anika-k" });
  assert.equal(missing.failureClass, "missing_freshness_marker");
});

test("edge: write hard-stop forbids silent retry; registry document is read-only", () => {
  const registry = createDegradationRegistry();
  const write = registry.lookup("sync", "write", { subjectId: "anika-k" });
  assert.equal(write.outcome, "accepted");
  assert.equal(write.behavior.mode, "HARD_STOP_WRITE");
  assert.equal(write.behavior.allowsSilentWriteRetry, false);
  assert.equal(write.behavior.writePolicy, "hard-stop-rollback");

  assert.throws(() => {
    /** @type {any} */ (registry.document).bindings.push({
      surface: "storage",
      operation: "read",
      mode: "QUEUE_AND_WARN",
    });
  });

  // Partial failure / idempotent replay: same lookup is deterministic.
  const again = registry.lookup("sync", "write", { subjectId: "anika-k" });
  assert.deepEqual(again.behavior, write.behavior);
});

test("subject isolation: empty subjectId rejected; signals never carry content keys", () => {
  const registry = createDegradationRegistry();
  const unscoped = registry.lookup("storage", "read", { subjectId: "" });
  assert.equal(unscoped.outcome, "rejected");
  assert.equal(unscoped.failureClass, "missing_subject");

  const accepted = registry.lookup("storage", "read", {
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
  const serialized = JSON.stringify(accepted);
  assert.doesNotMatch(serialized, /utterance|prompt|arguments/i);
  assert.equal(accepted.subjectId, "anika-k");

  emit({
    event: "degradation.registry",
    outcome: "rejected",
    failureClass: "missing_subject",
    subjectId: null,
  });
});

test("scalability: bounded registry parse stays within budget", () => {
  const started = performance.now();
  for (let i = 0; i < 256; i++) {
    createDegradationRegistry(DEFAULT_DEGRADATION_REGISTRY);
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 100, `parse loop took ${elapsed}ms; budget is 100ms`);

  const marker = freshnessMarkerSchema.parse({
    capturedAt: "2026-07-15T10:00:00.000Z",
    source: "local-cache",
  });
  assert.equal(marker.source, "local-cache");
});

test("edge: schema rejects mode mismatch and write-retry permission", () => {
  const badMode = degradationRegistryDocumentSchema.safeParse({
    ...DEFAULT_DEGRADATION_REGISTRY,
    modes: {
      ...DEFAULT_DEGRADATION_REGISTRY.modes,
      STALE_READ: {
        ...DEFAULT_DEGRADATION_REGISTRY.modes.STALE_READ,
        mode: "HARD_STOP_WRITE",
      },
    },
  });
  assert.equal(badMode.success, false);

  const silentRetry = degradationRegistryDocumentSchema.safeParse({
    ...DEFAULT_DEGRADATION_REGISTRY,
    modes: {
      ...DEFAULT_DEGRADATION_REGISTRY.modes,
      HARD_STOP_WRITE: {
        ...DEFAULT_DEGRADATION_REGISTRY.modes.HARD_STOP_WRITE,
        allowsSilentWriteRetry: true,
      },
    },
  });
  assert.equal(silentRetry.success, false);
});
