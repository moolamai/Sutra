/**
 * Snapshot store repository — clone at reset, empty vs not-found, optimistic concurrency.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemorySnapshotStore,
  IsolatedRolloutSnapshotStore,
  SnapshotStoreFleet,
  allocatePerRolloutSnapshotStore,
  assertNoCrossRolloutRead,
  assertNoOrphanStoresAfterBurst,
  createSnapshotStoreFromEnv,
  genesisCognitiveSnapshot,
  isSnapshotEmpty,
  resetSnapshotBackendLogLatch,
  teardownAndReleaseRolloutStore,
} from "../dist/index.js";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

test("happy path: cloneAtReset deep-clones memory/mastery/knowledge", () => {
  const events = [];
  const store = new InMemorySnapshotStore({ deviceId: "dev-snap-unit" });
  const template = genesisCognitiveSnapshot({
    subjectId: "subj.snap.a",
    deviceId: "dev-snap-unit",
    episodeId: "ep.template",
  });
  template.memory.frictionLog.push({
    conceptId: "c1",
    hesitationMs: 100,
    inputVelocity: 1,
    revisionCount: 0,
    assistanceRequested: false,
    outcome: "correct",
    capturedAt: "000000000000001:000001:dev-snap-unit",
  });
  template.mastery.c1 = {
    conceptId: "c1",
    alpha: { "dev-snap-unit": 1 },
    beta: { "dev-snap-unit": 0 },
    lastExercisedAt: "000000000000001:000001:dev-snap-unit",
  };
  template.knowledge.connectorIds.push("pack.teacher");
  template.knowledge.orderedIds.push("pack.teacher");

  const cloned = store.cloneAtReset({
    subjectId: "subj.snap.a",
    deviceId: "dev-snap-unit",
    episodeId: "ep.rollout.1",
    template,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(cloned.ok, true);
  if (!cloned.ok) return;

  // Mutating clone must not mutate template (deep clone).
  cloned.snapshot.mastery.c1.alpha["dev-snap-unit"] = 99;
  cloned.snapshot.knowledge.connectorIds.push("leaked");
  assert.equal(template.mastery.c1.alpha["dev-snap-unit"], 1);
  assert.deepEqual(template.knowledge.connectorIds, ["pack.teacher"]);
  assert.equal(cloned.snapshot.episodeId, "ep.rollout.1");
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: empty vs not_found are distinct", () => {
  const store = new InMemorySnapshotStore();
  const missing = store.get({
    subjectId: "subj.snap.a",
    deviceId: "dev",
    episodeId: "ep.missing",
  });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.failureClass, "not_found");

  const cloned = store.cloneAtReset({
    subjectId: "subj.snap.a",
    deviceId: "dev",
    episodeId: "ep.empty",
  });
  assert.equal(cloned.ok, true);
  if (!cloned.ok) return;
  assert.equal(isSnapshotEmpty(cloned.snapshot), true);

  const got = store.get({
    subjectId: "subj.snap.a",
    deviceId: "dev",
    episodeId: "ep.empty",
  });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.empty, true);
});

test("edge: stale state-vector put is rejected (no last-write-wins)", () => {
  const store = new InMemorySnapshotStore();
  const cloned = store.cloneAtReset({
    subjectId: "subj.snap.a",
    deviceId: "dev",
    episodeId: "ep.occ",
  });
  assert.equal(cloned.ok, true);
  if (!cloned.ok) return;

  const next = {
    ...cloned.snapshot,
    stateVector: { session: "000000000000002:000002:dev" },
    mastery: {
      c9: {
        conceptId: "c9",
        alpha: { dev: 1 },
        beta: { dev: 0 },
        lastExercisedAt: "000000000000002:000002:dev",
      },
    },
  };
  const stale = store.put({
    subjectId: "subj.snap.a",
    deviceId: "dev",
    episodeId: "ep.occ",
    snapshot: next,
    expectedStateVector: { session: "stale-vector" },
  });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.failureClass, "stale_state_vector");

  const ok = store.put({
    subjectId: "subj.snap.a",
    deviceId: "dev",
    episodeId: "ep.occ",
    snapshot: next,
    expectedStateVector: cloned.snapshot.stateVector,
  });
  assert.equal(ok.ok, true);
});

test("sovereignty: cross-subject template clone rejected", () => {
  const store = new InMemorySnapshotStore();
  const template = genesisCognitiveSnapshot({
    subjectId: "subj.a",
    deviceId: "dev",
    episodeId: "ep.t",
  });
  const cross = store.cloneAtReset({
    subjectId: "subj.b",
    deviceId: "dev",
    episodeId: "ep.x",
    template,
  });
  assert.equal(cross.ok, false);
  if (cross.ok) return;
  assert.equal(cross.failureClass, "cross_subject");
});

test("integration: write → new store instance (restart) → read committed state", () => {
  const dir = mkdtempSync(join(tmpdir(), "gym-snap-"));
  try {
    const storeA = new InMemorySnapshotStore({ durableDir: dir });
    const cloned = storeA.cloneAtReset({
      subjectId: "subj.durable",
      deviceId: "dev",
      episodeId: "ep.durable",
    });
    assert.equal(cloned.ok, true);
    if (!cloned.ok) return;
    const updated = {
      ...cloned.snapshot,
      knowledge: { connectorIds: ["pack.x"], orderedIds: ["pack.x"] },
      stateVector: { session: "000000000000003:000003:dev" },
    };
    const put = storeA.put({
      subjectId: "subj.durable",
      deviceId: "dev",
      episodeId: "ep.durable",
      snapshot: updated,
      expectedStateVector: cloned.snapshot.stateVector,
    });
    assert.equal(put.ok, true);

    // Simulate process restart: new store instance on same durable dir.
    const storeB = new InMemorySnapshotStore({ durableDir: dir });
    const got = storeB.get({
      subjectId: "subj.durable",
      deviceId: "dev",
      episodeId: "ep.durable",
    });
    assert.equal(got.ok, true);
    if (!got.ok) return;
    assert.equal(got.empty, false);
    assert.deepEqual(got.snapshot.knowledge.connectorIds, ["pack.x"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("factory: memory backend selected from env; postgres unavailable", () => {
  resetSnapshotBackendLogLatch();
  const store = createSnapshotStoreFromEnv({
    env: { GYM_SNAPSHOT_BACKEND: "memory" },
    deviceId: "dev-factory",
  });
  assert.equal(store.backendId, "memory");
  assert.ok(store.rolloutId);
  assert.throws(
    () =>
      createSnapshotStoreFromEnv({
        env: { GYM_SNAPSHOT_BACKEND: "postgres" },
        deviceId: "dev-factory",
      }),
    /postgres is not available/,
  );
});

test("happy path: fleet assigns unique stores; concurrent rollouts cannot cross-read", () => {
  const events = [];
  const a = allocatePerRolloutSnapshotStore({
    deviceId: "dev-fleet",
    onTelemetry: (e) => events.push(e),
  });
  const b = allocatePerRolloutSnapshotStore({ deviceId: "dev-fleet" });
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.notEqual(a.rolloutId, b.rolloutId);

  const proved = assertNoCrossRolloutRead({
    storeA: a.store,
    storeB: b.store,
    subjectId: "subj.iso",
    deviceId: "dev-fleet",
    episodeA: "ep.a",
    episodeB: "ep.b",
  });
  assert.equal(proved.ok, true, proved.detail);
  assert.ok(
    events.some(
      (e) => e.op === "allocate" && e.outcome === "ok" && e.rolloutId,
    ),
  );
});

test("edge: isolated store rejects cross-episode access (cross_rollout)", () => {
  const store = new IsolatedRolloutSnapshotStore({ deviceId: "dev-iso" });
  assert.equal(
    store.cloneAtReset({
      subjectId: "subj.iso",
      deviceId: "dev-iso",
      episodeId: "ep.1",
    }).ok,
    true,
  );
  const cross = store.get({
    subjectId: "subj.iso",
    deviceId: "dev-iso",
    episodeId: "ep.2",
  });
  assert.equal(cross.ok, false);
  if (cross.ok) return;
  assert.equal(cross.failureClass, "cross_rollout");

  // Idempotent re-clone same episode
  const again = store.cloneAtReset({
    subjectId: "subj.iso",
    deviceId: "dev-iso",
    episodeId: "ep.1",
  });
  assert.equal(again.ok, true);
});

test("edge: fleet limit enforced", () => {
  const fleet = new SnapshotStoreFleet({ limit: 2 });
  assert.equal(fleet.allocateRolloutStore({ deviceId: "d" }).ok, true);
  assert.equal(fleet.allocateRolloutStore({ deviceId: "d" }).ok, true);
  const over = fleet.allocateRolloutStore({ deviceId: "d" });
  assert.equal(over.ok, false);
  if (over.ok) return;
  assert.equal(over.failureClass, "fleet_limit");
});

test("happy path: terminal teardown discards without consent", () => {
  const events = [];
  const store = new InMemorySnapshotStore({ deviceId: "dev-teardown" });
  assert.equal(
    store.cloneAtReset({
      subjectId: "subj.td",
      deviceId: "dev-teardown",
      episodeId: "ep.td",
    }).ok,
    true,
  );
  const torn = store.teardownAtTerminal({
    subjectId: "subj.td",
    deviceId: "dev-teardown",
    episodeId: "ep.td",
    consent: null,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(torn.ok, true);
  if (!torn.ok) return;
  assert.equal(torn.discarded, true);
  assert.equal(torn.retained, false);

  const got = store.get({
    subjectId: "subj.td",
    deviceId: "dev-teardown",
    episodeId: "ep.td",
  });
  assert.equal(got.ok, false);
  if (got.ok) return;
  assert.equal(got.failureClass, "not_found");

  // Idempotent second teardown
  const again = store.teardownAtTerminal({
    subjectId: "subj.td",
    deviceId: "dev-teardown",
    episodeId: "ep.td",
    consent: null,
  });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.discarded, true);
  assert.equal(again.alreadyDiscarded, true);
  assert.ok(events.some((e) => e.op === "teardown" && e.retained === false));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: opted-in consent retains snapshot for export", () => {
  const store = new InMemorySnapshotStore({ deviceId: "dev-retain" });
  assert.equal(
    store.cloneAtReset({
      subjectId: "subj.retain",
      deviceId: "dev-retain",
      episodeId: "ep.retain",
    }).ok,
    true,
  );
  const torn = store.teardownAtTerminal({
    subjectId: "subj.retain",
    deviceId: "dev-retain",
    episodeId: "ep.retain",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-16T00:00:00.000Z",
    },
  });
  assert.equal(torn.ok, true);
  if (!torn.ok) return;
  assert.equal(torn.discarded, false);
  assert.equal(torn.retained, true);

  const got = store.get({
    subjectId: "subj.retain",
    deviceId: "dev-retain",
    episodeId: "ep.retain",
  });
  assert.equal(got.ok, true);
});

test("edge: durable discard survives restart (slot gone)", () => {
  const dir = mkdtempSync(join(tmpdir(), "snap-discard-"));
  try {
    const storeA = new InMemorySnapshotStore({
      durableDir: dir,
      deviceId: "dev",
    });
    assert.equal(
      storeA.cloneAtReset({
        subjectId: "subj.d",
        deviceId: "dev",
        episodeId: "ep.d",
      }).ok,
      true,
    );
    assert.equal(
      storeA.teardownAtTerminal({
        subjectId: "subj.d",
        deviceId: "dev",
        episodeId: "ep.d",
        consent: null,
      }).ok,
      true,
    );
    const storeB = new InMemorySnapshotStore({ durableDir: dir });
    const got = storeB.get({
      subjectId: "subj.d",
      deviceId: "dev",
      episodeId: "ep.d",
    });
    assert.equal(got.ok, false);
    if (got.ok) return;
    assert.equal(got.failureClass, "not_found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("happy path: fleet burst teardown leaves no orphan stores", () => {
  const proved = assertNoOrphanStoresAfterBurst({
    subjectId: "subj.burst",
    deviceId: "dev-burst",
    burstSize: 8,
  });
  assert.equal(proved.ok, true, proved.detail);
  assert.equal(proved.activeCount, 0);
});

test("sovereignty: teardown refuses cross-subject on isolated store", () => {
  const store = new IsolatedRolloutSnapshotStore({ deviceId: "dev-x" });
  assert.equal(
    store.cloneAtReset({
      subjectId: "subj.a",
      deviceId: "dev-x",
      episodeId: "ep.x",
    }).ok,
    true,
  );
  const cross = store.teardownAtTerminal({
    subjectId: "subj.b",
    deviceId: "dev-x",
    episodeId: "ep.x",
    consent: null,
  });
  assert.equal(cross.ok, false);
  if (cross.ok) return;
  assert.equal(cross.failureClass, "cross_subject");
});

test("edge: teardownAndRelease frees fleet slot", () => {
  const fleet = new SnapshotStoreFleet({ limit: 4 });
  const allocated = fleet.allocateRolloutStore({ deviceId: "dev-rel" });
  assert.equal(allocated.ok, true);
  if (!allocated.ok) return;
  assert.equal(
    allocated.store.cloneAtReset({
      subjectId: "subj.rel",
      deviceId: "dev-rel",
      episodeId: "ep.rel",
    }).ok,
    true,
  );
  const torn = teardownAndReleaseRolloutStore({
    store: allocated.store,
    subjectId: "subj.rel",
    deviceId: "dev-rel",
    episodeId: "ep.rel",
    fleet,
    consent: null,
  });
  assert.equal(torn.ok, true);
  assert.equal(torn.released, true);
  assert.equal(fleet.activeCount, 0);
  assert.equal(fleet.allocatedCount, 0);
});
