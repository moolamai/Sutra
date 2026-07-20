/**
 * Offline pack retrieve prove (CK-09.2) under B1 egress recorder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  proveOfflinePackRetrieve,
} from "../dist/index.js";

const SECRET = "LEARNER_QUERY_MUST_NOT_LEAK_OFFLINE";

test("happy path: offline pack retrieve passes CK-09.2 with network denied / zero egress", async () => {
  const events = [];
  const proof = await proveOfflinePackRetrieve({
    subjectId: "subj.pack.offline.ok",
    deviceId: "dev-pack-offline",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proof.ok, true, JSON.stringify(proof.failures));
  assert.equal(proof.localityOk, true);
  assert.equal(proof.ck092Ok, true);
  assert.equal(proof.citationsResolvable, true);
  assert.equal(proof.egressAttemptCount, 0);
  assert.equal(proof.locality, "bundled-offline");
  assert.ok(proof.passageCount >= 1);
  assert.ok(proof.asOf);
  assert.ok(events.some((e) => e.outcome === "pass"));
  assert.ok(events.some((e) => e.outcome === "subject_isolation_ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("sovereignty: offline prove telemetry is subject-scoped", async () => {
  const events = [];
  await proveOfflinePackRetrieve({
    subjectId: "subj.pack.offline.iso-a",
    deviceId: "dev-a",
    onTelemetry: (e) => events.push(e),
  });
  await proveOfflinePackRetrieve({
    subjectId: "subj.pack.offline.iso-b",
    deviceId: "dev-b",
    onTelemetry: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.subjectId === "subj.pack.offline.iso-a"));
  assert.ok(events.some((e) => e.subjectId === "subj.pack.offline.iso-b"));
  assert.ok(
    events
      .filter((e) => e.subjectId === "subj.pack.offline.iso-a")
      .every((e) => e.deviceId === "dev-a" || e.event === "bindings_knowledge.pack_loader"),
  );
});

test("idempotency: replaying offline prove stays green", async () => {
  const a = await proveOfflinePackRetrieve({
    subjectId: "subj.pack.offline.idem",
    deviceId: "dev-idem",
  });
  const b = await proveOfflinePackRetrieve({
    subjectId: "subj.pack.offline.idem",
    deviceId: "dev-idem",
  });
  assert.equal(a.ok, true, JSON.stringify(a.failures));
  assert.equal(b.ok, true, JSON.stringify(b.failures));
  assert.equal(a.egressAttemptCount, 0);
  assert.equal(b.egressAttemptCount, 0);
  assert.equal(a.ck092Ok, b.ck092Ok);
});

