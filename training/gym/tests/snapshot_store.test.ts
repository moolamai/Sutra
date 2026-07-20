/**
 * GymEnv.reset clones cognitive snapshot via repository.
 * Fleet assigns unique store per rollout — concurrent episodes cannot cross-read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GymEnv,
} from "../env.ts";
import {
  InMemorySnapshotStore,
  IsolatedRolloutSnapshotStore,
  allocateGymRolloutSnapshotStore,
  discardGymSnapshotAtTerminal,
  genesisCognitiveSnapshot,
  proveGymNoOrphanStoresAfterBurst,
  proveGymRolloutStoreIsolation,
} from "../snapshot_store.ts";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

test("happy path: reset clones snapshot for subject episode", () => {
  const events: object[] = [];
  const store = new InMemorySnapshotStore({ deviceId: "dev-gym-snap" });
  const env = new GymEnv({
    subjectId: "anika-k",
    deviceId: "dev-gym-snap",
    snapshotStore: store,
    onTelemetry: (e) => events.push(e),
  });

  const reset = env.reset("thought-answer-basic", 7);
  assert.equal(reset.ok, true, JSON.stringify(reset));
  if (!reset.ok) return;

  const snap = env.getRolloutSnapshot();
  assert.ok(snap);
  assert.equal(snap!.subjectId, "anika-k");
  assert.equal(snap!.episodeId, reset.episodeId);
  assert.ok(Array.isArray(snap!.memory.frictionLog));
  assert.ok(snap!.mastery);
  assert.ok(snap!.knowledge);

  const got = store.get({
    subjectId: "anika-k",
    deviceId: "dev-gym-snap",
    episodeId: reset.episodeId,
  });
  assert.equal(got.ok, true);
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: template is deep-cloned — mutating rollout does not mutate template", () => {
  const template = genesisCognitiveSnapshot({
    subjectId: "anika-k",
    deviceId: "dev-gym-snap",
    episodeId: "ep.template",
  });
  template.knowledge.connectorIds.push("pack.teacher");

  const env = new GymEnv({
    subjectId: "anika-k",
    deviceId: "dev-gym-snap",
    snapshotStore: new InMemorySnapshotStore(),
    snapshotTemplate: template,
  });
  assert.equal(env.reset("thought-answer-basic", 3).ok, true);
  const snap = env.getRolloutSnapshot()!;
  snap.knowledge.connectorIds.push("mutated");
  assert.deepEqual(template.knowledge.connectorIds, ["pack.teacher"]);
});

test("sovereignty: cross-subject template rejected at reset", () => {
  const template = genesisCognitiveSnapshot({
    subjectId: "subj.other",
    deviceId: "dev",
    episodeId: "ep.t",
  });
  const env = new GymEnv({
    subjectId: "anika-k",
    deviceId: "dev-gym-snap",
    snapshotStore: new InMemorySnapshotStore(),
    snapshotTemplate: template,
  });
  const reset = env.reset("thought-answer-basic", 1);
  assert.equal(reset.ok, false);
  if (reset.ok) return;
  assert.equal(reset.failureClass, "cross_subject");
});

test("happy path: fleet allocates unique stores; concurrent rollouts cannot cross-read", () => {
  const proved = proveGymRolloutStoreIsolation({
    subjectId: "anika-k",
    deviceId: "dev-gym-iso",
  });
  assert.equal(proved.ok, true, proved.detail);

  const a = allocateGymRolloutSnapshotStore({ deviceId: "dev-gym-iso" });
  const b = allocateGymRolloutSnapshotStore({ deviceId: "dev-gym-iso" });
  assert.ok(a.rolloutId);
  assert.ok(b.rolloutId);
  assert.notEqual(a.rolloutId, b.rolloutId);
});

test("edge: isolated store rejects foreign episode (cross_rollout)", () => {
  const store = new IsolatedRolloutSnapshotStore({ deviceId: "dev-gym-iso" });
  const env = new GymEnv({
    subjectId: "anika-k",
    deviceId: "dev-gym-iso",
    snapshotStore: store,
  });
  const reset = env.reset("thought-answer-basic", 2);
  assert.equal(reset.ok, true);
  if (!reset.ok) return;

  const cross = store.get({
    subjectId: "anika-k",
    deviceId: "dev-gym-iso",
    episodeId: "ep.foreign",
  });
  assert.equal(cross.ok, false);
  if (cross.ok) return;
  assert.equal(cross.failureClass, "cross_rollout");
});

test("happy path: terminal discards snapshot without consent", async () => {
  const store = new InMemorySnapshotStore({ deviceId: "dev-gym-td" });
  const env = new GymEnv({
    subjectId: "anika-k",
    deviceId: "dev-gym-td",
    snapshotStore: store,
  });
  const reset = env.reset("thought-answer-basic", 11);
  assert.equal(reset.ok, true);
  if (!reset.ok) return;
  assert.ok(env.getRolloutSnapshot());

  const stepped = await env.step({ path: "golden_replay" });
  assert.equal(stepped.ok, true);
  if (!stepped.ok) return;
  assert.equal(stepped.terminal, true);
  assert.equal(env.getRolloutSnapshot(), null);

  const got = store.get({
    subjectId: "anika-k",
    deviceId: "dev-gym-td",
    episodeId: reset.episodeId,
  });
  assert.equal(got.ok, false);
  if (got.ok) return;
  assert.equal(got.failureClass, "not_found");
});

test("edge: consented export retains snapshot after terminal", async () => {
  const store = new InMemorySnapshotStore({ deviceId: "dev-gym-ret" });
  const env = new GymEnv({
    subjectId: "anika-k",
    deviceId: "dev-gym-ret",
    snapshotStore: store,
    trajectoryConsent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-16T00:00:00.000Z",
    },
  });
  const reset = env.reset("thought-answer-basic", 12);
  assert.equal(reset.ok, true);
  if (!reset.ok) return;

  const stepped = await env.step({ path: "golden_replay" });
  assert.equal(stepped.ok, true);
  if (!stepped.ok) return;
  assert.equal(stepped.terminal, true);
  assert.ok(env.getRolloutSnapshot());

  const got = store.get({
    subjectId: "anika-k",
    deviceId: "dev-gym-ret",
    episodeId: reset.episodeId,
  });
  assert.equal(got.ok, true);
});

test("happy path: gym burst leaves no orphan fleet stores", () => {
  const proved = proveGymNoOrphanStoresAfterBurst({
    subjectId: "anika-k",
    deviceId: "dev-gym-burst",
  });
  assert.equal(proved.ok, true, proved.detail);
});

test("edge: discardGymSnapshotAtTerminal is idempotent", () => {
  const store = allocateGymRolloutSnapshotStore({ deviceId: "dev-gym-idemp" });
  assert.equal(
    store.cloneAtReset({
      subjectId: "anika-k",
      deviceId: "dev-gym-idemp",
      episodeId: "ep.idemp",
    }).ok,
    true,
  );
  const first = discardGymSnapshotAtTerminal({
    store,
    subjectId: "anika-k",
    deviceId: "dev-gym-idemp",
    episodeId: "ep.idemp",
    consent: null,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.discarded, true);

  const second = discardGymSnapshotAtTerminal({
    store,
    subjectId: "anika-k",
    deviceId: "dev-gym-idemp",
    episodeId: "ep.idemp",
    consent: null,
    releaseFleet: false,
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.discarded, true);
  assert.equal(second.alreadyDiscarded, true);
});
