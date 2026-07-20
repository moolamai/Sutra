/**
 * Fleet end-to-end micro-run — G=4 parallel episodes, trajectory export, snapshot isolation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTurnTrajectoryRecord,
  toCanonicalTrajectoryJson,
} from "@moolam/learning";
import {
  FLEET_TELEMETRY_MICRO_GROUP_SIZE,
  FLEET_TELEMETRY_MICRO_SCENARIOS,
  runFleetTelemetryMicroRun,
  type GymTelemetryEvent,
} from "../telemetry.ts";
import type { FleetTelemetry } from "../fleet.ts";

const CKPT = "sha256:epistele003ckpt";
const CKPT_STALE = "sha256:epistele003stale";

const consentOk = {
  optedIn: true as const,
  consentClass: "research" as const,
  recordedAt: "2026-07-16T00:00:00.000Z",
};

test("happy path: G=4 fleet micro-run exports parseable trajectories with lineage", async () => {
  const teleEvents: GymTelemetryEvent[] = [];
  const fleetEvents: FleetTelemetry[] = [];

  const run = await runFleetTelemetryMicroRun({
    policyCheckpointHash: CKPT,
    corpusManifestId: "corpus.gym.telemetry.e2e.v1",
    hyperparametersId: "hp.e2e.1",
    criticVersionId: "critic.e2e.1",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    consent: consentOk,
    locality: "on-device",
    capturedAt: "2026-07-16T13:00:00.000Z",
    concurrencyCap: FLEET_TELEMETRY_MICRO_GROUP_SIZE,
    onTelemetry: (e) => teleEvents.push(e),
    onFleetTelemetry: (e) => fleetEvents.push(e),
  });

  assert.equal(run.ok, true, run.detail);
  assert.equal(run.fleetOk, true);
  assert.equal(run.exportOk, true);
  assert.equal(run.trajectories.length, FLEET_TELEMETRY_MICRO_GROUP_SIZE);
  assert.equal(run.rolloutIds.length, FLEET_TELEMETRY_MICRO_GROUP_SIZE);
  assert.equal(new Set(run.rolloutIds).size, FLEET_TELEMETRY_MICRO_GROUP_SIZE);
  assert.equal(run.seeds.length, FLEET_TELEMETRY_MICRO_GROUP_SIZE);
  assert.equal(run.lineage.baseCheckpointHash, CKPT);
  assert.equal(run.lineage.corpusManifestId, "corpus.gym.telemetry.e2e.v1");

  for (let i = 0; i < run.trajectories.length; i += 1) {
    const record = run.trajectories[i]!;
    assert.equal(record.policyCheckpointHash, CKPT);
    assert.equal(record.rolloutSeed, 40 + i);
    assert.equal(record.subjectId, "anika-k");
    assert.equal(record.locality, "on-device");
    assert.equal(record.schemaVersion, "trajectory.v1");

    const replay = parseTurnTrajectoryRecord(
      JSON.parse(toCanonicalTrajectoryJson(record)),
    );
    assert.equal(replay.ok, true, JSON.stringify(replay));
    if (!replay.ok) return;
    assert.equal(replay.record.policyCheckpointHash, CKPT);
    assert.equal(replay.record.rolloutSeed, 40 + i);
  }

  assert.equal(FLEET_TELEMETRY_MICRO_SCENARIOS.length, 4);
  assert.ok(teleEvents.some((e) => e.op === "queue" && e.outcome === "ok"));
  assert.ok(teleEvents.some((e) => e.op === "batch" && e.outcome === "ok"));
  assert.ok(fleetEvents.some((e) => e.op === "micro_run" && e.outcome === "ok"));

  const blob = JSON.stringify({ teleEvents, trajectories: run.trajectories });
  assert.ok(!blob.includes("delta"));
  assert.ok(!blob.includes("LEARNER_UTTERANCE"));
});

test("edge: consent denied blocks sovereign export after fleet completes", async () => {
  const run = await runFleetTelemetryMicroRun({
    policyCheckpointHash: CKPT,
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    consent: {
      optedIn: false,
      consentClass: "research",
      recordedAt: "2026-07-16T00:00:00.000Z",
    },
    locality: "on-device",
    capturedAt: "2026-07-16T13:00:00.000Z",
  });

  assert.equal(run.ok, false);
  assert.equal(run.fleetOk, true, "fleet episodes complete before export gate");
  assert.equal(run.exportOk, false);
  assert.equal(run.trajectories.length, 0);
  assert.match(run.detail ?? "", /consent_denied/);
});

test("edge: stale-policy checkpoint hash preserved on every trajectory", async () => {
  const run = await runFleetTelemetryMicroRun({
    policyCheckpointHash: CKPT_STALE,
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    consent: consentOk,
    locality: "self-hosted",
    capturedAt: "2026-07-16T13:00:00.000Z",
  });

  assert.equal(run.ok, true, run.detail);
  assert.ok(run.trajectories.every((r) => r.policyCheckpointHash === CKPT_STALE));
  assert.ok(
    run.trajectories.every((r) => r.policyCheckpointHash.toLowerCase() !== "latest"),
  );
  assert.ok(run.trajectories.every((r) => r.locality === "self-hosted"));
});

test("edge: export enqueue returns immediately without blocking fleet path", async () => {
  let writerStarted = false;
  const run = await runFleetTelemetryMicroRun({
    policyCheckpointHash: CKPT,
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    consent: consentOk,
    locality: "on-device",
    capturedAt: "2026-07-16T13:00:00.000Z",
    onTelemetry: (e) => {
      if (e.op === "write") writerStarted = true;
    },
  });

  assert.equal(run.ok, true, run.detail);
  assert.equal(run.exportOk, true);
  assert.equal(writerStarted, false, "per-record writer not injected in micro-run");
});
