/**
 * Champion rollback drill — one-operation byte-identical restore (C5).
 * Run: pnpm --filter sutra-bindings-slm run build && node --experimental-strip-types --test training/delivery/rollback_drill.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_DELTA_MANIFEST_SCHEMA_VERSION,
  AdapterLoadContractError,
  SlmRuntimeAdapterLoader,
  contentAddressAdapterBlob,
} from "../../packages/bindings-slm/dist/adapter_load.js";
import { SlmRuntimeTurnPinningSeam } from "../../packages/bindings-slm/dist/hot_swap.js";
import {
  ADAPTER_ROLLBACK_DRILL_CI_JOB_ID,
  ADAPTER_ROLLBACK_DRILL_TEST_RELPATH,
  ADAPTER_ROLLBACK_GOLDEN_UTTERANCE,
  ChampionRollbackError,
  SlmRuntimeChampionRollback,
  pendingGateFromTurnPinningSeam,
  proveChampionRollbackGoldenDrillMicroRun,
  renderGoldenTurnUnderAdapter,
} from "../../packages/bindings-slm/dist/rollback.js";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

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
      runId: "run.rollback.drill",
      checkpointHash: "ckpt:sha256:rollbacklineage01",
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

test("happy path: retain champion, swap challenger, one-op rollback restores bytes+hash", () => {
  const events = [];
  const subjectId = "subj.rollback.ok";
  const deviceId = "dev.rollback.ok";
  const baseModelHash = "ckpt:sha256:rollbackokbase001";
  const blobA = Buffer.from("champion-adapter-bytes-A");
  const hashA = contentAddressAdapterBlob(blobA);
  const blobB = Buffer.from("challenger-adapter-bytes-B");
  const hashB = contentAddressAdapterBlob(blobB);
  const manifestA = manifestFor({
    subjectId,
    deviceId,
    baseModelHash,
    contentHash: hashA,
  });
  const manifestB = manifestFor({
    subjectId,
    deviceId,
    baseModelHash,
    contentHash: hashB,
  });

  const loader = new SlmRuntimeAdapterLoader({
    subjectId,
    deviceId,
    baseModelHash,
    precisionFormat: "int4",
  });
  loader.loadAdapter({ manifest: manifestA, blobBytes: blobA, loadId: "load.A" });

  const rollback = new SlmRuntimeChampionRollback({
    subjectId,
    deviceId,
    loader,
    onTelemetry: (event) => events.push(event),
  });
  const retained = rollback.retainChampion({ subjectId, manifest: manifestA });
  assert.equal(retained.champion.contentHash, hashA);
  assert.ok(retained.champion.blob.equals(blobA));

  loader.loadAdapter({ manifest: manifestB, blobBytes: blobB, loadId: "load.B" });
  assert.equal(loader.activeContentHash, hashB);

  const restored = rollback.rollback({
    subjectId,
    operationId: "op.rollback.champion.1",
  });
  assert.equal(restored.applied, true);
  if (restored.applied && restored.restoredTo === "champion") {
    assert.equal(restored.oldContentHash, hashB);
    assert.equal(restored.newContentHash, hashA);
    assert.equal(restored.championContentHash, hashA);
    assert.ok(restored.restored.blob.equals(blobA));
    assert.ok(restored.auditId.startsWith("audit:"));
  }
  assert.equal(loader.activeContentHash, hashA);
  assert.ok(loader.activeAdapter.blob.equals(blobA));

  const replay = rollback.rollback({
    subjectId,
    operationId: "op.rollback.champion.1",
  });
  assert.equal(replay.idempotentReplay, true);

  assert.ok(
    events.some(
      (event) =>
        event.event === "bindings.hot_swap.rollback" &&
        event.outcome === "ok" &&
        event.oldContentHash === hashB &&
        event.newContentHash === hashA,
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(
    events.every(
      (event) =>
        !("content" in event) &&
        !("utterance" in event) &&
        !("blob" in event),
    ),
  );
});

test("edge: no champion reverts to base; pending forward swap cancelled; mid-turn queues", () => {
  const events = [];
  const subjectId = "subj.rollback.edge";
  const deviceId = "dev.rollback.edge";
  const baseModelHash = "ckpt:sha256:rollbackedgebase1";
  const blobA = Buffer.from("edge-champion-A");
  const hashA = contentAddressAdapterBlob(blobA);
  const blobB = Buffer.from("edge-challenger-B");
  const hashB = contentAddressAdapterBlob(blobB);
  const blobC = Buffer.from("edge-pending-C");
  const hashC = contentAddressAdapterBlob(blobC);
  const manifestA = manifestFor({
    subjectId,
    deviceId,
    baseModelHash,
    contentHash: hashA,
  });
  const manifestB = manifestFor({
    subjectId,
    deviceId,
    baseModelHash,
    contentHash: hashB,
  });
  const manifestC = manifestFor({
    subjectId,
    deviceId,
    baseModelHash,
    contentHash: hashC,
  });

  // No champion → base only (never undefined / never throws no_prior).
  const baseLoader = new SlmRuntimeAdapterLoader({
    subjectId,
    deviceId,
    baseModelHash,
    precisionFormat: "int4",
  });
  baseLoader.loadAdapter({
    manifest: manifestA,
    blobBytes: blobA,
    loadId: "load.base.A",
  });
  const baseRollback = new SlmRuntimeChampionRollback({
    subjectId,
    deviceId,
    loader: baseLoader,
    onTelemetry: (event) => events.push(event),
  });
  const toBase = baseRollback.rollback({
    subjectId,
    operationId: "op.rollback.base",
  });
  assert.equal(toBase.applied, true);
  assert.equal(toBase.restoredTo, "base");
  assert.equal(baseLoader.activeContentHash, undefined);
  assert.equal(baseLoader.activeAdapter, undefined);

  // Champion + mid-turn pending forward swap → cancel queue, wait for boundary.
  const loader = new SlmRuntimeAdapterLoader({
    subjectId,
    deviceId,
    baseModelHash,
    precisionFormat: "int4",
  });
  loader.loadAdapter({ manifest: manifestA, blobBytes: blobA, loadId: "load.A" });
  const pinning = new SlmRuntimeTurnPinningSeam({
    subjectId,
    deviceId,
    loader,
  });
  const rollback = new SlmRuntimeChampionRollback({
    subjectId,
    deviceId,
    loader,
    pendingGate: pendingGateFromTurnPinningSeam(pinning),
    onTelemetry: (event) => events.push(event),
  });
  rollback.retainChampion({ subjectId, manifest: manifestA });
  loader.loadAdapter({ manifest: manifestB, blobBytes: blobB, loadId: "load.B" });

  pinning.pinAtFirstToken({ subjectId, sessionId: "session.rollback.1" });
  pinning.enqueuePendingSwap({
    subjectId,
    enqueueId: "enqueue.pending.C",
    manifest: manifestC,
    blobBytes: blobC,
  });
  assert.equal(pinning.pendingCount, 1);
  assert.equal(loader.activeContentHash, hashB);

  const queued = rollback.rollback({
    subjectId,
    operationId: "op.rollback.queued",
  });
  assert.equal(queued.applied, false);
  assert.equal(queued.queued, true);
  assert.equal(queued.cancelledPendingCount, 1);
  assert.equal(pinning.pendingCount, 0);
  assert.equal(loader.activeContentHash, hashB);
  assert.ok(
    events.some(
      (event) =>
        event.event === "bindings.hot_swap.rollback_cancel_pending" &&
        event.cancelledPendingCount === 1,
    ),
  );

  // Still pinned — flush refused; pin holds challenger checkpoint.
  assert.throws(
    () =>
      rollback.flushQueuedRollback({
        subjectId,
        operationId: "op.rollback.queued",
      }),
    (error) =>
      error instanceof ChampionRollbackError &&
      error.obligation === "hot_swap.rollback.mid_turn_queued",
  );
  assert.equal(
    pinning.getPinnedCheckpoint({
      subjectId,
      sessionId: "session.rollback.1",
    }).pinnedContentHash,
    hashB,
  );

  pinning.onTerminalBoundary({
    subjectId,
    sessionId: "session.rollback.1",
    reason: "TURN_COMPLETE",
  });
  const flushed = rollback.flushQueuedRollback({
    subjectId,
    operationId: "op.rollback.queued",
  });
  assert.equal(flushed.applied, true);
  assert.equal(flushed.restoredTo, "champion");
  assert.equal(flushed.newContentHash, hashA);
  assert.equal(loader.activeContentHash, hashA);
  assert.ok(loader.activeAdapter.blob.equals(blobA));
});

test("edge: subject isolation and mid-turn immediate load refuse stay typed", () => {
  const subjectId = "subj.rollback.scope";
  const deviceId = "dev.rollback.scope";
  const baseModelHash = "ckpt:sha256:rollbackscope001";
  const blobA = Buffer.from("scope-adapter-A");
  const hashA = contentAddressAdapterBlob(blobA);
  const manifestA = manifestFor({
    subjectId,
    deviceId,
    baseModelHash,
    contentHash: hashA,
  });
  const loader = new SlmRuntimeAdapterLoader({
    subjectId,
    deviceId,
    baseModelHash,
    precisionFormat: "int4",
  });
  loader.loadAdapter({ manifest: manifestA, blobBytes: blobA });
  const rollback = new SlmRuntimeChampionRollback({
    subjectId,
    deviceId,
    loader,
  });
  rollback.retainChampion({ subjectId, manifest: manifestA });

  assert.throws(
    () =>
      rollback.rollback({
        subjectId: "subj.other",
        operationId: "op.cross",
      }),
    (error) =>
      error instanceof ChampionRollbackError &&
      error.obligation === "hot_swap.rollback.subject_scope",
  );

  loader.beginTurn("session.scope.1");
  const blobB = Buffer.from("scope-adapter-B");
  const hashB = contentAddressAdapterBlob(blobB);
  assert.throws(
    () =>
      loader.loadAdapter({
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
});

test("golden drill: challenger changes output; rollback restores baseline byte-identically", () => {
  const events = [];
  const proved = proveChampionRollbackGoldenDrillMicroRun({
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.behaviourChanged, true);
  assert.equal(proved.byteMatchAfterRollback, true);
  assert.equal(proved.baselineOutputHash, proved.restoredOutputHash);
  assert.notEqual(proved.challengerOutputHash, proved.baselineOutputHash);
  assert.equal(proved.cancelledPendingCount, 1);
  assert.ok(proved.refused.includes("adapter.load.base_mismatch"));
  assert.ok(proved.refused.includes("hot_swap.rollback.subject_scope"));
  assert.equal(proved.ciJobId, ADAPTER_ROLLBACK_DRILL_CI_JOB_ID);
  assert.equal(proved.testRelPath, ADAPTER_ROLLBACK_DRILL_TEST_RELPATH);

  const baseline = renderGoldenTurnUnderAdapter({
    utterance: ADAPTER_ROLLBACK_GOLDEN_UTTERANCE,
    adapterContentHash: proved.championContentHash,
  });
  const challenger = renderGoldenTurnUnderAdapter({
    utterance: ADAPTER_ROLLBACK_GOLDEN_UTTERANCE,
    adapterContentHash: proved.challengerContentHash,
  });
  assert.equal(baseline.outputHash, proved.baselineOutputHash);
  assert.equal(challenger.outputHash, proved.challengerOutputHash);
  assert.notEqual(baseline.text, challenger.text);

  assert.ok(
    events.some(
      (event) =>
        event.event === "bindings.hot_swap.rollback_cancel_pending" &&
        event.cancelledPendingCount === 1,
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.event === "bindings.hot_swap.rollback" &&
        event.outcome === "ok" &&
        event.newContentHash === proved.championContentHash,
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(
    events.every(
      (event) =>
        !("content" in event) &&
        !("utterance" in event) &&
        !("blob" in event) &&
        !("text" in event),
    ),
  );
});

test("ci: adapter-rollback-drill job runs golden drill suite", () => {
  const yml = readFileSync(
    path.join(REPO_ROOT, ".github/workflows/ci.yml"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.match(yml, new RegExp(`^  ${ADAPTER_ROLLBACK_DRILL_CI_JOB_ID}:`, "m"));
  const header = `  ${ADAPTER_ROLLBACK_DRILL_CI_JOB_ID}:\n`;
  const start = yml.indexOf(header);
  assert.ok(start >= 0);
  const fromJob = yml.slice(start);
  const next = fromJob.slice(header.length).search(/\n  [a-z0-9-]+:\n/);
  const block =
    next === -1 ? fromJob : fromJob.slice(0, header.length + next);
  assert.match(block, /Rollback drill \(champion baseline/);
  assert.match(block, /@moolam\/bindings-slm|sutra-bindings-slm/);
  assert.match(block, /run build|turbo run build --filter=@moolam\/bindings-slm/);
  assert.match(block, /experimental-strip-types/);
  assert.match(
    block,
    new RegExp(ADAPTER_ROLLBACK_DRILL_TEST_RELPATH.replace(/\./g, "\\.")),
  );
  assert.match(block, /pnpm install --frozen-lockfile/);
  assert.match(block, /node-version:\s*22/);
});
