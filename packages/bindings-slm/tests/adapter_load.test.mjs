/**
 * Adapter load loud-fail gate + SlmRuntime apply seam (C5 delta format).
 * Run via: pnpm --filter sutra-bindings-slm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION,
  ADAPTER_LOAD_SEAM_VERSION,
  AdapterLoadContractError,
  SlmRuntimeAdapterLoader,
  contentAddressAdapterBlob,
  proveAdapterLoadApplyMicroRun,
  proveAdapterLoadVerifyMicroRun,
  verifyAdapterDeltaForLoad,
  verifyPackedAdapterDelta,
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
      runId: "run.load.test",
      checkpointHash: "ckpt:sha256:lineagetest00001",
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

test("happy path: content-addressed blob verifies against runtime pins", () => {
  const events = [];
  const subjectId = "subj.adapter.load.ok";
  const deviceId = "dev.adapter.load.ok";
  const baseModelHash = "ckpt:sha256:loadokbase000001";
  const blob = new TextEncoder().encode("ok-delta-bytes");
  const contentHash = contentAddressAdapterBlob(blob);

  const result = verifyAdapterDeltaForLoad({
    manifest: manifestFor({
      subjectId,
      deviceId,
      baseModelHash,
      contentHash,
    }),
    blobBytes: blob,
    runtime: {
      subjectId,
      deviceId,
      baseModelHash,
      precisionFormat: "int4",
    },
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(result.ok, true);
  assert.equal(result.seamVersion, ADAPTER_LOAD_SEAM_VERSION);
  assert.equal(result.contentHash, contentHash);
  assert.equal(result.baseModelHash, baseModelHash);
  assert.ok(
    events.some(
      (e) => e.event === "bindings.adapter.load_verify" && e.outcome === "ok",
    ),
  );
  assert.ok(events.every((e) => !("content" in e) && !("utterance" in e)));
});

test("edge: base / precision / checksum mismatch and subject isolation refuse loudly", () => {
  const proved = proveAdapterLoadVerifyMicroRun();
  assert.equal(proved.ok, true);
  assert.equal(proved.verified.ok, true);
  assert.ok(proved.refused.includes("adapter.load.base_mismatch"));
  assert.ok(proved.refused.includes("adapter.load.precision_mismatch"));
  assert.ok(proved.refused.includes("adapter.load.content_hash_mismatch"));
  assert.ok(proved.refused.includes("adapter.load.subject_scope"));
  assert.ok(proved.refused.includes("adapter.load.lineage_incomplete"));

  assert.throws(
    () => contentAddressAdapterBlob(new Uint8Array(0)),
    (err) =>
      err instanceof AdapterLoadContractError &&
      err.obligation === "adapter.load.truncated",
  );
});

test("happy path: verifyPackedAdapterDelta accepts content-addressed pack pair", () => {
  const subjectId = "subj.adapter.pack.verify";
  const deviceId = "dev.adapter.pack.verify";
  const baseModelHash = "ckpt:sha256:packverifybase01";
  const blob = new TextEncoder().encode("packed-delta-bytes");
  const contentHash = contentAddressAdapterBlob(blob);
  const verified = verifyPackedAdapterDelta({
    packed: {
      manifest: {
        ...manifestFor({
          subjectId,
          deviceId,
          baseModelHash,
          contentHash,
        }),
        precisionFormat: "fp16",
        locality: "self-hosted",
      },
      blob,
    },
    runtime: {
      subjectId,
      deviceId,
      baseModelHash,
      precisionFormat: "fp16",
    },
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.contentHash, contentHash);
});

test("happy path: SlmRuntimeAdapterLoader applies verified adapter", () => {
  const events = [];
  const subjectId = "subj.adapter.apply.ok";
  const deviceId = "dev.adapter.apply.ok";
  const baseModelHash = "ckpt:sha256:applyokbase00001";
  const blob = new TextEncoder().encode("apply-ok-delta");
  const contentHash = contentAddressAdapterBlob(blob);

  const loader = new SlmRuntimeAdapterLoader({
    subjectId,
    deviceId,
    baseModelHash,
    precisionFormat: "int4",
    onTelemetry: (e) => events.push(e),
  });

  const result = loader.loadAdapter({
    manifest: manifestFor({
      subjectId,
      deviceId,
      baseModelHash,
      contentHash,
    }),
    blobBytes: blob,
    loadId: "load.ok.1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.idempotentReplay, false);
  assert.equal(result.applied.contentHash, contentHash);
  assert.equal(loader.activeContentHash, contentHash);
  assert.ok(
    events.some(
      (e) => e.event === "bindings.adapter.load_apply" && e.outcome === "ok",
    ),
  );
});

test("edge: mid-turn refuse, corrupt/mismatch leave active untouched, rollback byte-identical", () => {
  const events = [];
  const proved = proveAdapterLoadApplyMicroRun({
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.applied.ok, true);
  assert.equal(
    proved.activeUntouchedAfterCorrupt,
    proved.applied.applied.contentHash,
  );
  assert.equal(
    proved.afterRollback.applied.contentHash,
    proved.applied.applied.contentHash,
  );
  assert.ok(
    proved.afterRollback.applied.blob.equals(proved.applied.applied.blob),
  );
  assert.ok(proved.refused.includes("adapter.load.mid_turn_refuse"));
  assert.ok(proved.refused.includes("adapter.load.base_mismatch"));
  assert.ok(proved.refused.includes("adapter.load.content_hash_mismatch"));
  assert.ok(proved.refused.includes("adapter.load.subject_scope"));
  assert.ok(
    events.some(
      (e) => e.event === "bindings.adapter.load_rollback" && e.outcome === "ok",
    ),
  );
  assert.ok(events.every((e) => !("content" in e) && !("utterance" in e)));
});

test("edge: unloaded runtime refuses apply with typed error", () => {
  const loader = new SlmRuntimeAdapterLoader({
    subjectId: "subj.adapter.unloaded",
    deviceId: "dev.adapter.unloaded",
    baseModelHash: "ckpt:sha256:unloadedbase0001",
    precisionFormat: "int4",
    runtimeLoaded: false,
  });
  const blob = new TextEncoder().encode("never-applied");
  const contentHash = contentAddressAdapterBlob(blob);
  assert.throws(
    () =>
      loader.loadAdapter({
        manifest: manifestFor({
          subjectId: "subj.adapter.unloaded",
          deviceId: "dev.adapter.unloaded",
          baseModelHash: "ckpt:sha256:unloadedbase0001",
          contentHash,
        }),
        blobBytes: blob,
      }),
    (err) =>
      err instanceof AdapterLoadContractError &&
      err.obligation === "adapter.load.runtime_unloaded",
  );
  assert.equal(loader.activeContentHash, undefined);
});

test("turn pin: first token captures active adapter; duplicate token stays pinned", () => {
  const bindingEvents = [];
  const harnessEvents = [];
  const subjectId = "subj.turn.pin.ok";
  const deviceId = "dev.turn.pin.ok";
  const baseModelHash = "ckpt:sha256:turnpinbase0001";
  const blob = Buffer.from("turn-pin-adapter-A");
  const contentHash = contentAddressAdapterBlob(blob);
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
      contentHash,
    }),
    blobBytes: blob,
  });

  const binding = new SlmRuntimeTurnPinningSeam({
    subjectId,
    deviceId,
    loader,
    onTelemetry: (event) => bindingEvents.push(event),
  });
  const harness = new SessionCheckpointController({
    subjectId,
    deviceId,
    binding,
    onTelemetry: (event) => harnessEvents.push(event),
  });

  const first = harness.onFirstToken({
    subjectId,
    sessionId: "session.turn.pin.1",
    observedAt: "2026-07-17T00:00:00.000Z",
  });
  const replay = harness.onFirstToken({
    subjectId,
    sessionId: "session.turn.pin.1",
    observedAt: "2026-07-17T00:00:01.000Z",
  });

  assert.equal(first.checkpoint.pinnedContentHash, contentHash);
  assert.equal(first.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.checkpoint.pinnedContentHash, contentHash);
  assert.equal(replay.checkpoint.pinnedAt, first.checkpoint.pinnedAt);
  assert.equal(
    harness.getCheckpoint({
      subjectId,
      sessionId: "session.turn.pin.1",
    }).pinnedContentHash,
    contentHash,
  );
  assert.ok(
    bindingEvents.some(
      (event) =>
        event.event === "bindings.hot_swap.turn_pin" &&
        event.pinnedContentHash === contentHash,
    ),
  );
  assert.ok(
    harnessEvents.some(
      (event) =>
        event.event === "harness.session_checkpoint.pin" &&
        event.pinnedContentHash === contentHash,
    ),
  );
  assert.ok(
    [...bindingEvents, ...harnessEvents].every(
      (event) =>
        !("content" in event) &&
        !("utterance" in event) &&
        !("blob" in event),
    ),
  );
});

test("turn pin edge: mid-turn load refused; concurrent sessions remain isolated", () => {
  const events = [];
  const subjectId = "subj.turn.pin.edge";
  const deviceId = "dev.turn.pin.edge";
  const baseModelHash = "ckpt:sha256:turnpinedge0001";
  const blobA = Buffer.from("turn-pin-edge-A");
  const hashA = contentAddressAdapterBlob(blobA);
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
  });

  harness.onFirstToken({ subjectId, sessionId: "session.concurrent.1" });
  harness.onFirstToken({ subjectId, sessionId: "session.concurrent.2" });

  const blobB = Buffer.from("turn-pin-edge-B");
  const hashB = contentAddressAdapterBlob(blobB);
  assert.throws(
    () =>
      binding.loadAdapter({
        subjectId,
        manifest: manifestFor({
          subjectId,
          deviceId,
          baseModelHash,
          contentHash: hashB,
        }),
        blobBytes: blobB,
      }),
    (error) =>
      error instanceof AdapterLoadContractError &&
      error.obligation === "adapter.load.mid_turn_refuse",
  );
  assert.equal(loader.activeContentHash, hashA);
  assert.equal(
    harness.getCheckpoint({
      subjectId,
      sessionId: "session.concurrent.1",
    }).pinnedContentHash,
    hashA,
  );
  assert.equal(
    harness.getCheckpoint({
      subjectId,
      sessionId: "session.concurrent.2",
    }).pinnedContentHash,
    hashA,
  );
  assert.ok(
    events.some(
      (event) =>
        event.event === "bindings.hot_swap.load_refuse" &&
        event.failureClass === "adapter.load.mid_turn_refuse",
    ),
  );
});

test("turn pin edge: cross-subject access and empty session fail typed", () => {
  const subjectId = "subj.turn.pin.scope";
  const deviceId = "dev.turn.pin.scope";
  const baseModelHash = "ckpt:sha256:turnpinscope001";
  const blob = Buffer.from("turn-pin-scope-A");
  const contentHash = contentAddressAdapterBlob(blob);
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
      contentHash,
    }),
    blobBytes: blob,
  });
  const binding = new SlmRuntimeTurnPinningSeam({
    subjectId,
    deviceId,
    loader,
  });
  const harness = new SessionCheckpointController({
    subjectId,
    deviceId,
    binding,
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
    () => binding.pinAtFirstToken({ subjectId, sessionId: "" }),
    (error) =>
      error instanceof HotSwapTurnPinError &&
      error.obligation === "hot_swap.pin.session_required",
  );
});

test("boundary swap happy path: TURN_COMPLETE applies pending delta with old/new hashes", () => {
  const bindingEvents = [];
  const harnessEvents = [];
  const subjectId = "subj.boundary.swap.ok";
  const deviceId = "dev.boundary.swap.ok";
  const baseModelHash = "ckpt:sha256:boundaryokbase01";
  const blobA = Buffer.from("boundary-swap-A");
  const hashA = contentAddressAdapterBlob(blobA);
  const blobB = Buffer.from("boundary-swap-B");
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
    onTelemetry: (event) => bindingEvents.push(event),
  });
  const harness = new SessionCheckpointController({
    subjectId,
    deviceId,
    binding,
    onTelemetry: (event) => harnessEvents.push(event),
  });

  harness.onFirstToken({
    subjectId,
    sessionId: "session.boundary.1",
    observedAt: "2026-07-17T01:00:00.000Z",
  });
  const queued = binding.enqueuePendingSwap({
    subjectId,
    enqueueId: "enqueue.boundary.B",
    manifest: manifestFor({
      subjectId,
      deviceId,
      baseModelHash,
      contentHash: hashB,
    }),
    blobBytes: blobB,
  });
  assert.equal(queued.appliedImmediately, false);
  assert.equal(queued.pendingCount, 1);
  assert.equal(loader.activeContentHash, hashA);

  const boundary = harness.onTurnComplete({
    subjectId,
    sessionId: "session.boundary.1",
  });
  assert.equal(boundary.applied, true);
  assert.equal(boundary.oldContentHash, hashA);
  assert.equal(boundary.newContentHash, hashB);
  assert.equal(loader.activeContentHash, hashB);
  assert.ok(
    bindingEvents.some(
      (event) =>
        event.event === "bindings.hot_swap.boundary_swap" &&
        event.outcome === "ok" &&
        event.oldContentHash === hashA &&
        event.newContentHash === hashB,
    ),
  );
  assert.ok(
    harnessEvents.some(
      (event) =>
        event.event === "harness.session_checkpoint.boundary" &&
        event.applied === true &&
        event.oldContentHash === hashA &&
        event.newContentHash === hashB,
    ),
  );
});

test("boundary swap edge: mid-turn queue waits; latest pending wins; multi-session gate", () => {
  const events = [];
  const subjectId = "subj.boundary.swap.edge";
  const deviceId = "dev.boundary.swap.edge";
  const baseModelHash = "ckpt:sha256:boundaryedge0001";
  const blobA = Buffer.from("boundary-edge-A");
  const hashA = contentAddressAdapterBlob(blobA);
  const blobB = Buffer.from("boundary-edge-B");
  const hashB = contentAddressAdapterBlob(blobB);
  const blobC = Buffer.from("boundary-edge-C");
  const hashC = contentAddressAdapterBlob(blobC);
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
  });

  harness.onFirstToken({ subjectId, sessionId: "session.edge.1" });
  harness.onFirstToken({ subjectId, sessionId: "session.edge.2" });

  // Correction-loop style: swap request mid-turn queues; immediate load refused.
  binding.enqueuePendingSwap({
    subjectId,
    enqueueId: "enqueue.edge.B",
    manifest: manifestFor({
      subjectId,
      deviceId,
      baseModelHash,
      contentHash: hashB,
    }),
    blobBytes: blobB,
  });
  binding.enqueuePendingSwap({
    subjectId,
    enqueueId: "enqueue.edge.C",
    manifest: manifestFor({
      subjectId,
      deviceId,
      baseModelHash,
      contentHash: hashC,
    }),
    blobBytes: blobC,
  });
  assert.equal(binding.pendingCount, 2);
  assert.throws(
    () =>
      binding.loadAdapter({
        subjectId,
        manifest: manifestFor({
          subjectId,
          deviceId,
          baseModelHash,
          contentHash: hashC,
        }),
        blobBytes: blobC,
      }),
    (error) =>
      error instanceof AdapterLoadContractError &&
      error.obligation === "adapter.load.mid_turn_refuse",
  );
  assert.equal(loader.activeContentHash, hashA);
  assert.equal(
    harness.getCheckpoint({ subjectId, sessionId: "session.edge.1" })
      .pinnedContentHash,
    hashA,
  );

  const firstComplete = harness.onTurnComplete({
    subjectId,
    sessionId: "session.edge.1",
  });
  assert.equal(firstComplete.applied, false);
  assert.equal(firstComplete.waitingOnActiveSessions, 1);
  assert.equal(loader.activeContentHash, hashA);
  assert.ok(
    events.some(
      (event) =>
        event.event === "bindings.hot_swap.boundary_wait" &&
        event.activeSessionCount === 1,
    ),
  );

  const secondComplete = harness.onHarnessError({
    subjectId,
    sessionId: "session.edge.2",
  });
  assert.equal(secondComplete.applied, true);
  assert.equal(secondComplete.oldContentHash, hashA);
  assert.equal(secondComplete.newContentHash, hashC);
  assert.equal(secondComplete.discardedPendingCount, 1);
  assert.equal(loader.activeContentHash, hashC);
  assert.equal(binding.pendingCount, 0);

  assert.throws(
    () =>
      binding.enqueuePendingSwap({
        subjectId: "subj.other",
        manifest: manifestFor({
          subjectId: "subj.other",
          deviceId,
          baseModelHash,
          contentHash: hashB,
        }),
        blobBytes: blobB,
      }),
    (error) =>
      error instanceof HotSwapTurnPinError &&
      error.obligation === "hot_swap.pin.subject_scope",
  );

  const replay = harness.onTurnComplete({
    subjectId,
    sessionId: "session.edge.2",
  });
  assert.equal(replay.applied, false);
  assert.equal(replay.idle, true);
});
