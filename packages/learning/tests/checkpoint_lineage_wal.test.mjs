/**
 * Crash-safe checkpoint lineage WAL + atomic rename recovery (C4).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CHECKPOINT_LINEAGE_SCHEMA_VERSION,
  CheckpointLineageContractError,
  FileWalCheckpointLineageRegistry,
  openCheckpointLineageRegistry,
  proveCheckpointLineageWalMicroRun,
  resetCheckpointLineageBackendLog,
  resolveCheckpointLineageBackend,
} from "../dist/index.js";

const CORPUS =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CRITIC =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function genesisRow(overrides = {}) {
  return {
    schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
    runId: "run.wal.genesis",
    subjectId: "subj.wal.01",
    deviceId: "dev.wal.01",
    locality: "on-device",
    checkpointHash: "ckpt:sha256:wal-genesis000001",
    corpusManifestHash: CORPUS,
    baseModelHash: "base:sha256:model0000000001",
    hyperparameters: { lr: 1e-4 },
    criticVersions: [
      {
        rubricId: "rubric.core",
        rubricVersion: "1.0.0",
        contentHash: CRITIC,
      },
    ],
    stage: "SFT",
    evalVerdicts: [],
    recordedAt: "2026-07-16T13:00:00.000Z",
    ...overrides,
  };
}

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "lineage-wal-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("happy path: fs WAL micro-run survives reopen", () => {
  withTempDir((rootDir) => {
    resetCheckpointLineageBackendLog();
    const events = [];
    const proved = proveCheckpointLineageWalMicroRun({
      rootDir,
      subjectId: "subj.wal.happy",
      deviceId: "dev.wal.happy",
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(proved.recovered.kind, "found");
    assert.equal(proved.recovered.row.runId, proved.grpo.runId);
    assert.equal(proved.revision, 2);
    assert.ok(events.some((e) => e.event === "learning.lineage.backend"));
    assert.ok(events.some((e) => e.backend === "fs"));
    assert.equal(
      /utterance|keystroke|rawContent/i.test(JSON.stringify(events)),
      false,
    );
    assert.equal(resolveCheckpointLineageBackend({ MOOLAM_CHECKPOINT_LINEAGE_BACKEND: "fs" }), "fs");
  });
});

test("integration: crash after staged WAL → reopen discards pending", () => {
  withTempDir((rootDir) => {
    const reg = new FileWalCheckpointLineageRegistry({ rootDir });
    const g = reg.appendCommitted({ row: genesisRow() });
    assert.throws(
      () =>
        new FileWalCheckpointLineageRegistry({
          rootDir,
          crashAfter: "after-wal-staged",
        }).stageAppend({
          row: genesisRow({
            runId: "run.wal.partial",
            checkpointHash: "ckpt:sha256:wal-partial00001",
            parentCheckpointHash: g.row.checkpointHash,
            stage: "GRPO",
            recordedAt: "2026-07-16T13:01:00.000Z",
          }),
          expectedRevision: g.revision,
        }),
      (err) =>
        err instanceof CheckpointLineageContractError &&
        err.obligation === "lineage.io",
    );

    const events = [];
    const reopened = new FileWalCheckpointLineageRegistry({
      rootDir,
      onTelemetry: (e) => events.push(e),
    });
    const genesis = reopened.getByRunId({
      subjectId: "subj.wal.01",
      runId: "run.wal.genesis",
      deviceId: "dev.wal.01",
    });
    assert.equal(genesis.kind, "found");
    const partial = reopened.getByRunId({
      subjectId: "subj.wal.01",
      runId: "run.wal.partial",
      deviceId: "dev.wal.01",
    });
    assert.equal(partial.kind, "not_found");
    assert.ok(
      events.some(
        (e) =>
          e.event === "learning.lineage.recover" &&
          e.discardedPending === true &&
          e.walPhase === "staged",
      ),
    );
  });
});

test("integration: crash after committing marker → reopen promotes row", () => {
  withTempDir((rootDir) => {
    const bootstrap = new FileWalCheckpointLineageRegistry({ rootDir });
    const g = bootstrap.appendCommitted({ row: genesisRow() });

    assert.throws(
      () =>
        new FileWalCheckpointLineageRegistry({
          rootDir,
          crashAfter: "after-wal-committing",
        }).appendCommitted({
          row: genesisRow({
            runId: "run.wal.promote",
            checkpointHash: "ckpt:sha256:wal-promote00001",
            parentCheckpointHash: g.row.checkpointHash,
            stage: "GRPO",
            recordedAt: "2026-07-16T13:02:00.000Z",
          }),
          expectedRevision: g.revision,
        }),
      (err) =>
        err instanceof CheckpointLineageContractError &&
        err.obligation === "lineage.io",
    );

    const events = [];
    const reopened = new FileWalCheckpointLineageRegistry({
      rootDir,
      onTelemetry: (e) => events.push(e),
    });
    const found = reopened.getByRunId({
      subjectId: "subj.wal.01",
      runId: "run.wal.promote",
      deviceId: "dev.wal.01",
    });
    assert.equal(found.kind, "found");
    assert.equal(found.row.checkpointHash, "ckpt:sha256:wal-promote00001");
    assert.ok(
      events.some(
        (e) =>
          e.event === "learning.lineage.recover" &&
          e.promotedPending === true &&
          e.walPhase === "committing",
      ),
    );
  });
});

test("edge: crash after committed write before WAL unlink → reopen keeps tip", () => {
  withTempDir((rootDir) => {
    const bootstrap = new FileWalCheckpointLineageRegistry({ rootDir });
    const g = bootstrap.appendCommitted({ row: genesisRow() });

    assert.throws(
      () =>
        new FileWalCheckpointLineageRegistry({
          rootDir,
          crashAfter: "after-committed-before-wal-unlink",
        }).appendCommitted({
          row: genesisRow({
            runId: "run.wal.dur",
            checkpointHash: "ckpt:sha256:wal-durable00001",
            parentCheckpointHash: g.row.checkpointHash,
            stage: "GRPO",
            recordedAt: "2026-07-16T13:03:00.000Z",
          }),
          expectedRevision: g.revision,
        }),
      (err) =>
        err instanceof CheckpointLineageContractError &&
        err.obligation === "lineage.io",
    );

    const reopened = new FileWalCheckpointLineageRegistry({ rootDir });
    const found = reopened.getByRunId({
      subjectId: "subj.wal.01",
      runId: "run.wal.dur",
      deviceId: "dev.wal.01",
    });
    assert.equal(found.kind, "found");
    assert.equal(reopened.revision("subj.wal.01"), 2);
  });
});

test("edge: concurrent writers — stale disk revision rejected", () => {
  withTempDir((rootDir) => {
    const a = new FileWalCheckpointLineageRegistry({ rootDir });
    const g = a.appendCommitted({
      row: genesisRow({ subjectId: "subj.wal.occ" }),
    });

    const stale = new FileWalCheckpointLineageRegistry({ rootDir });
    // Fresh open sees revision 1. First writer advances to 2.
    a.appendCommitted({
      row: genesisRow({
        subjectId: "subj.wal.occ",
        runId: "run.wal.occ.a",
        checkpointHash: "ckpt:sha256:wal-occ-a0000001",
        parentCheckpointHash: g.row.checkpointHash,
        stage: "GRPO",
        recordedAt: "2026-07-16T13:04:00.000Z",
      }),
      expectedRevision: g.revision,
    });

    // Stale handle still holds revision 1 in memory → disk says 2.
    assert.throws(
      () =>
        stale.appendCommitted({
          row: genesisRow({
            subjectId: "subj.wal.occ",
            runId: "run.wal.occ.b",
            checkpointHash: "ckpt:sha256:wal-occ-b0000001",
            parentCheckpointHash: g.row.checkpointHash,
            stage: "GRPO",
            recordedAt: "2026-07-16T13:04:30.000Z",
          }),
          expectedRevision: g.revision,
        }),
      (err) =>
        err instanceof CheckpointLineageContractError &&
        err.obligation === "lineage.stale_revision",
    );
  });
});

test("sovereignty: subject directories do not leak rows across subjects", () => {
  withTempDir((rootDir) => {
    const reg = openCheckpointLineageRegistry({
      backend: "fs",
      rootDir,
    });
    reg.appendCommitted({
      row: genesisRow({ subjectId: "subj.wal.A", runId: "run.A" }),
    });
    reg.appendCommitted({
      row: genesisRow({
        subjectId: "subj.wal.B",
        runId: "run.B",
        checkpointHash: "ckpt:sha256:wal-genesis-b0001",
      }),
    });

    const cross = reg.getByRunId({
      subjectId: "subj.wal.A",
      runId: "run.B",
      deviceId: "dev",
    });
    assert.equal(cross.kind, "not_found");

    const listA = reg.listCommitted({
      subjectId: "subj.wal.A",
      deviceId: "dev",
    });
    assert.equal(listA.length, 1);
    assert.equal(listA[0].subjectId, "subj.wal.A");
  });
});

test("edge: corrupt WAL JSON discarded on recover", () => {
  withTempDir((rootDir) => {
    const reg = new FileWalCheckpointLineageRegistry({ rootDir });
    reg.appendCommitted({ row: genesisRow({ subjectId: "subj.wal.corrupt" }) });

    const walPath = path.join(rootDir, "subj.wal.corrupt", "wal.json");
    writeFileSync(walPath, "{not-json", "utf8");

    const events = [];
    const reopened = new FileWalCheckpointLineageRegistry({
      rootDir,
      onTelemetry: (e) => events.push(e),
    });
    const found = reopened.getByRunId({
      subjectId: "subj.wal.corrupt",
      runId: "run.wal.genesis",
      deviceId: "dev.wal.01",
    });
    assert.equal(found.kind, "found");
    assert.ok(
      events.some(
        (e) =>
          e.event === "learning.lineage.recover" &&
          e.failureClass === "lineage.wal_corrupt",
      ),
    );
    assert.equal(
      (() => {
        try {
          return readFileSync(walPath, "utf8");
        } catch {
          return null;
        }
      })(),
      null,
    );
  });
});
