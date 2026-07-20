/**
 * Concurrent-load hot-swap integration: overlapping turns across subjects.
 * Subject B may swap mid-flight while subject A completes; no turn mixes
 * checkpoints. Run via: pnpm --filter sutra-bindings-slm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION,
  AdapterLoadContractError,
  SlmRuntimeAdapterLoader,
  contentAddressAdapterBlob,
} from "../dist/adapter_load.js";
import {
  HotSwapTurnPinError,
  SlmRuntimeTurnPinningSeam,
} from "../dist/hot_swap.js";
import {
  SessionCheckpointContractError,
  SessionCheckpointController,
} from "../../runtime-harness/dist/session_checkpoint.js";

function manifestFor(input) {
  return {
    schemaVersion: ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION,
    contentHash: input.contentHash,
    baseModelHash: input.baseModelHash,
    precisionFormat: input.precisionFormat ?? "int4",
    loraRank: 16,
    loraAlpha: 32,
    lineageRef: {
      schemaVersion: "checkpoint.lineage.v1",
      runId: "run.concurrent.load",
      checkpointHash: "ckpt:sha256:concurrentload001",
      corpusManifestHash:
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      criticVersions: [
        {
          rubricId: "core.format",
          rubricVersion: "1.0.0",
          contentHash:
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        },
      ],
    },
    adapterBlobRef: `cas://${input.contentHash}`,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    locality: "on-device",
  };
}

function subjectStack(input) {
  const events = [];
  const loader = new SlmRuntimeAdapterLoader({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    baseModelHash: input.baseModelHash,
    precisionFormat: "int4",
  });
  loader.loadAdapter({
    manifest: manifestFor({
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      baseModelHash: input.baseModelHash,
      contentHash: input.initialHash,
    }),
    blobBytes: input.initialBlob,
  });
  const binding = new SlmRuntimeTurnPinningSeam({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    loader,
    onTelemetry: (event) => events.push(event),
  });
  const harness = new SessionCheckpointController({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    binding,
    onTelemetry: (event) => events.push(event),
  });
  return { loader, binding, harness, events };
}

function assertNoContentLeak(events) {
  assert.ok(
    events.every(
      (event) =>
        !("content" in event) &&
        !("utterance" in event) &&
        !("blob" in event) &&
        !("text" in event),
    ),
  );
}

test("concurrent load: swap subject B mid-flight while subject A completes — no checkpoint mix", () => {
  const baseModelHash = "ckpt:sha256:concurrentabase01";
  const blobA0 = Buffer.from("subject-A-adapter-v0");
  const hashA0 = contentAddressAdapterBlob(blobA0);
  const blobB0 = Buffer.from("subject-B-adapter-v0");
  const hashB0 = contentAddressAdapterBlob(blobB0);
  const blobB1 = Buffer.from("subject-B-adapter-v1");
  const hashB1 = contentAddressAdapterBlob(blobB1);
  const blobB2 = Buffer.from("subject-B-adapter-v2-latest");
  const hashB2 = contentAddressAdapterBlob(blobB2);

  const subjectA = subjectStack({
    subjectId: "subj.concurrent.A",
    deviceId: "dev.concurrent.A",
    baseModelHash,
    initialBlob: blobA0,
    initialHash: hashA0,
  });
  const subjectB = subjectStack({
    subjectId: "subj.concurrent.B",
    deviceId: "dev.concurrent.B",
    baseModelHash,
    initialBlob: blobB0,
    initialHash: hashB0,
  });

  // Overlapping in-flight turns across subjects.
  const pinA = subjectA.harness.onFirstToken({
    subjectId: "subj.concurrent.A",
    sessionId: "session.A.1",
    observedAt: "2026-07-17T12:00:00.000Z",
  });
  const pinB = subjectB.harness.onFirstToken({
    subjectId: "subj.concurrent.B",
    sessionId: "session.B.1",
    observedAt: "2026-07-17T12:00:00.100Z",
  });
  assert.equal(pinA.checkpoint.pinnedContentHash, hashA0);
  assert.equal(pinB.checkpoint.pinnedContentHash, hashB0);

  // Mid-flight for B: FIFO queue of two deltas; latest must win at boundary.
  subjectB.binding.enqueuePendingSwap({
    subjectId: "subj.concurrent.B",
    enqueueId: "enqueue.B.v1",
    manifest: manifestFor({
      subjectId: "subj.concurrent.B",
      deviceId: "dev.concurrent.B",
      baseModelHash,
      contentHash: hashB1,
    }),
    blobBytes: blobB1,
  });
  subjectB.binding.enqueuePendingSwap({
    subjectId: "subj.concurrent.B",
    enqueueId: "enqueue.B.v2",
    manifest: manifestFor({
      subjectId: "subj.concurrent.B",
      deviceId: "dev.concurrent.B",
      baseModelHash,
      contentHash: hashB2,
    }),
    blobBytes: blobB2,
  });
  assert.equal(subjectB.binding.pendingCount, 2);
  assert.equal(subjectB.loader.activeContentHash, hashB0);
  assert.equal(subjectA.loader.activeContentHash, hashA0);

  // Immediate mid-turn load refused; pins stay frozen.
  assert.throws(
    () =>
      subjectB.binding.loadAdapter({
        subjectId: "subj.concurrent.B",
        manifest: manifestFor({
          subjectId: "subj.concurrent.B",
          deviceId: "dev.concurrent.B",
          baseModelHash,
          contentHash: hashB2,
        }),
        blobBytes: blobB2,
      }),
    (error) =>
      error instanceof AdapterLoadContractError &&
      error.obligation === "adapter.load.mid_turn_refuse",
  );

  // Subject A completes under its original checkpoint while B is still mid-turn.
  const completeA = subjectA.harness.onTurnComplete({
    subjectId: "subj.concurrent.A",
    sessionId: "session.A.1",
  });
  assert.equal(completeA.applied, false);
  assert.equal(subjectA.loader.activeContentHash, hashA0);
  assert.equal(
    subjectB.harness.getCheckpoint({
      subjectId: "subj.concurrent.B",
      sessionId: "session.B.1",
    }).pinnedContentHash,
    hashB0,
  );
  assert.equal(subjectB.loader.activeContentHash, hashB0);

  // Idempotent first-token replay cannot repin B to a newer active hash.
  const replayB = subjectB.harness.onFirstToken({
    subjectId: "subj.concurrent.B",
    sessionId: "session.B.1",
    observedAt: "2026-07-17T12:00:05.000Z",
  });
  assert.equal(replayB.idempotentReplay, true);
  assert.equal(replayB.checkpoint.pinnedContentHash, hashB0);

  // Correction-loop style terminal: HARNESS_ERROR applies latest pending for B only.
  const completeB = subjectB.harness.onHarnessError({
    subjectId: "subj.concurrent.B",
    sessionId: "session.B.1",
  });
  assert.equal(completeB.applied, true);
  assert.equal(completeB.oldContentHash, hashB0);
  assert.equal(completeB.newContentHash, hashB2);
  assert.equal(completeB.discardedPendingCount, 1);
  assert.equal(subjectB.loader.activeContentHash, hashB2);
  assert.equal(subjectA.loader.activeContentHash, hashA0);
  assert.equal(subjectB.binding.pendingCount, 0);

  // Rollback restores B's prior adapter byte-identically; A untouched.
  const rolled = subjectB.loader.rollback();
  assert.equal(rolled.applied.contentHash, hashB0);
  assert.ok(rolled.applied.blob.equals(blobB0));
  assert.equal(subjectA.loader.activeContentHash, hashA0);

  assert.ok(
    subjectB.events.some(
      (event) =>
        event.event === "bindings.hot_swap.boundary_swap" &&
        event.outcome === "ok" &&
        event.oldContentHash === hashB0 &&
        event.newContentHash === hashB2 &&
        event.subjectId === "subj.concurrent.B",
    ),
  );
  assert.ok(
    subjectA.events.every(
      (event) =>
        event.subjectId === "subj.concurrent.A" &&
        event.event !== "bindings.hot_swap.boundary_swap",
    ),
  );
  assertNoContentLeak([...subjectA.events, ...subjectB.events]);
});

test("concurrent load edge: same-subject multi-session gate + base mismatch loud-fail", () => {
  const events = [];
  const subjectId = "subj.concurrent.same";
  const deviceId = "dev.concurrent.same";
  const baseModelHash = "ckpt:sha256:concurrentsame001";
  const blobA = Buffer.from("same-subject-A");
  const hashA = contentAddressAdapterBlob(blobA);
  const blobB = Buffer.from("same-subject-B");
  const hashB = contentAddressAdapterBlob(blobB);

  const loader = new SlmRuntimeAdapterLoader({
    subjectId,
    deviceId,
    baseModelHash,
    precisionFormat: "int4",
  });
  loader.loadAdapter({
    manifest: manifestFor({
      subjectId,
      deviceId,
      baseModelHash,
      contentHash: hashA,
    }),
    blobBytes: blobA,
  });
  const binding = new SlmRuntimeTurnPinningSeam({
    subjectId,
    deviceId,
    loader,
    onTelemetry: (event) => events.push(event),
  });
  const harness = new SessionCheckpointController({
    subjectId,
    deviceId,
    binding,
    onTelemetry: (event) => events.push(event),
  });

  harness.onFirstToken({ subjectId, sessionId: "session.same.1" });
  harness.onFirstToken({ subjectId, sessionId: "session.same.2" });

  binding.enqueuePendingSwap({
    subjectId,
    enqueueId: "enqueue.same.B",
    manifest: manifestFor({
      subjectId,
      deviceId,
      baseModelHash,
      contentHash: hashB,
    }),
    blobBytes: blobB,
  });

  const first = harness.onTurnComplete({
    subjectId,
    sessionId: "session.same.1",
  });
  assert.equal(first.applied, false);
  assert.equal(first.waitingOnActiveSessions, 1);
  assert.equal(loader.activeContentHash, hashA);
  assert.equal(
    harness.getCheckpoint({ subjectId, sessionId: "session.same.2" })
      .pinnedContentHash,
    hashA,
  );

  const second = harness.onTurnComplete({
    subjectId,
    sessionId: "session.same.2",
  });
  assert.equal(second.applied, true);
  assert.equal(second.newContentHash, hashB);
  assert.equal(loader.activeContentHash, hashB);

  assert.throws(
    () =>
      binding.loadAdapter({
        subjectId,
        manifest: manifestFor({
          subjectId,
          deviceId,
          baseModelHash: "ckpt:sha256:wrongbase00000001",
          contentHash: contentAddressAdapterBlob(Buffer.from("mismatch")),
        }),
        blobBytes: Buffer.from("mismatch"),
      }),
    (error) =>
      error instanceof AdapterLoadContractError &&
      error.obligation === "adapter.load.base_mismatch",
  );
  assert.equal(loader.activeContentHash, hashB);

  assert.ok(
    events.some(
      (event) =>
        event.event === "bindings.hot_swap.boundary_wait" &&
        event.activeSessionCount === 1,
    ),
  );
  assertNoContentLeak(events);
});

test("concurrent load sovereignty: cross-subject pin and enqueue are typed defects", () => {
  const subjectId = "subj.concurrent.scope";
  const deviceId = "dev.concurrent.scope";
  const baseModelHash = "ckpt:sha256:concurrentscope01";
  const blob = Buffer.from("scope-adapter");
  const contentHash = contentAddressAdapterBlob(blob);
  const { binding, harness } = subjectStack({
    subjectId,
    deviceId,
    baseModelHash,
    initialBlob: blob,
    initialHash: contentHash,
  });

  assert.throws(
    () =>
      harness.onFirstToken({
        subjectId: "subj.other",
        sessionId: "session.scope.1",
      }),
    (error) =>
      error instanceof SessionCheckpointContractError &&
      error.obligation === "session_checkpoint.subject_scope",
  );
  assert.throws(
    () =>
      binding.enqueuePendingSwap({
        subjectId: "subj.other",
        enqueueId: "enqueue.scope.other",
        manifest: manifestFor({
          subjectId: "subj.other",
          deviceId,
          baseModelHash,
          contentHash,
        }),
        blobBytes: blob,
      }),
    (error) =>
      error instanceof HotSwapTurnPinError &&
      error.obligation === "hot_swap.pin.subject_scope",
  );
});
