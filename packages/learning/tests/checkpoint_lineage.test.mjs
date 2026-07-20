/**
 * Append-only checkpoint lineage schema + parent-hash chain (C4).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKPOINT_LINEAGE_SCHEMA_RELPATH,
  CHECKPOINT_LINEAGE_SCHEMA_VERSION,
  CheckpointLineageContractError,
  InMemoryCheckpointLineageRegistry,
  assertParentHashChainRule,
  checkpointLineageJsonSchema,
  openCheckpointLineageRegistry,
  parseCheckpointLineageRow,
  proveCheckpointLineageSchemaMicroRun,
  resetCheckpointLineageBackendLog,
  resolveCheckpointLineageBackend,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const CORPUS =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CRITIC =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function genesisRow(overrides = {}) {
  return {
    schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
    runId: "run.lineage.genesis",
    subjectId: "subj.lineage.01",
    deviceId: "dev.lineage.01",
    locality: "on-device",
    checkpointHash: "ckpt:sha256:genesis00000001",
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
    recordedAt: "2026-07-16T12:00:00.000Z",
    ...overrides,
  };
}

test("happy path: schema parse + parent-hash chain micro-run", () => {
  resetCheckpointLineageBackendLog();
  const events = [];
  const proved = proveCheckpointLineageSchemaMicroRun({
    subjectId: "subj.lineage.happy",
    deviceId: "dev.lineage.happy",
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(proved.genesis.stage, "SFT");
  assert.equal(proved.genesis.parentCheckpointHash, undefined);
  assert.equal(proved.grpo.stage, "GRPO");
  assert.equal(proved.grpo.parentCheckpointHash, proved.genesis.checkpointHash);
  assert.equal(proved.revision, 2);
  assert.ok(events.some((e) => e.event === "learning.lineage.backend"));
  assert.ok(events.some((e) => e.event === "learning.lineage.commit"));
  assert.equal(/utterance|keystroke|rawContent/i.test(JSON.stringify(events)), false);

  const parsed = parseCheckpointLineageRow(proved.grpo);
  assert.equal(parsed.ok, true);
});

test("integration: stage → kill → restart recovers only committed rows", () => {
  const reg = new InMemoryCheckpointLineageRegistry();
  const events = [];
  const g = reg.appendCommitted({
    row: genesisRow(),
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(g.committed, true);

  reg.stageAppend({
    row: genesisRow({
      runId: "run.lineage.partial",
      checkpointHash: "ckpt:sha256:partial0000001",
      parentCheckpointHash: g.row.checkpointHash,
      stage: "GRPO",
      recordedAt: "2026-07-16T12:01:00.000Z",
    }),
    expectedRevision: g.revision,
  });

  // Kill before commit — restart discards pending WAL.
  const recovered = reg.simulateRestart();
  const found = recovered.getByRunId({
    subjectId: "subj.lineage.01",
    runId: "run.lineage.genesis",
    deviceId: "dev.lineage.01",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(found.kind, "found");
  const missing = recovered.getByRunId({
    subjectId: "subj.lineage.01",
    runId: "run.lineage.partial",
    deviceId: "dev.lineage.01",
  });
  assert.equal(missing.kind, "not_found");
  assert.equal(recovered.revision("subj.lineage.01"), 1);
});

test("edge: stale revision rejected (optimistic concurrency)", () => {
  const reg = openCheckpointLineageRegistry({ backend: "memory" });
  const g = reg.appendCommitted({ row: genesisRow({ subjectId: "subj.occ" }) });
  assert.throws(
    () =>
      reg.appendCommitted({
        row: genesisRow({
          subjectId: "subj.occ",
          runId: "run.lineage.grpo.stale",
          checkpointHash: "ckpt:sha256:grpo-stale000001",
          parentCheckpointHash: g.row.checkpointHash,
          stage: "GRPO",
        }),
        expectedRevision: 0,
      }),
    (err) =>
      err instanceof CheckpointLineageContractError &&
      err.obligation === "lineage.stale_revision",
  );
});

test("edge: empty vs not_found are distinct", () => {
  const reg = openCheckpointLineageRegistry({ backend: "memory" });
  const empty = reg.getByRunId({
    subjectId: "subj.never.written",
    runId: "run.x",
    deviceId: "dev",
  });
  assert.equal(empty.kind, "empty");

  reg.appendCommitted({
    row: genesisRow({ subjectId: "subj.has.rows", runId: "run.only" }),
  });
  const missing = reg.getByRunId({
    subjectId: "subj.has.rows",
    runId: "run.missing",
    deviceId: "dev",
  });
  assert.equal(missing.kind, "not_found");
});

test("edge: non-genesis without parentCheckpointHash rejected", () => {
  const reg = openCheckpointLineageRegistry({ backend: "memory" });
  const g = reg.appendCommitted({
    row: genesisRow({ subjectId: "subj.parent.req" }),
  });
  assert.throws(
    () =>
      reg.appendCommitted({
        row: genesisRow({
          subjectId: "subj.parent.req",
          runId: "run.no.parent",
          checkpointHash: "ckpt:sha256:noparent0000001",
          stage: "GRPO",
        }),
        expectedRevision: g.revision,
      }),
    (err) =>
      err instanceof CheckpointLineageContractError &&
      err.obligation === "lineage.parent_required",
  );
});

test("edge: genesis must not carry parentCheckpointHash", () => {
  assert.throws(
    () =>
      assertParentHashChainRule(
        {
          ...genesisRow({ parentCheckpointHash: "ckpt:sha256:bogusparent01" }),
        },
        { isGenesis: true },
      ),
    (err) =>
      err instanceof CheckpointLineageContractError &&
      err.obligation === "lineage.parent_forbidden",
  );
});

test("sovereignty: subject-scoped reads do not leak other subjects", () => {
  const reg = openCheckpointLineageRegistry({ backend: "memory" });
  reg.appendCommitted({
    row: genesisRow({ subjectId: "subj.A", runId: "run.A" }),
  });
  reg.appendCommitted({
    row: genesisRow({
      subjectId: "subj.B",
      runId: "run.B",
      checkpointHash: "ckpt:sha256:genesis-b000001",
    }),
  });

  const cross = reg.getByRunId({
    subjectId: "subj.A",
    runId: "run.B",
    deviceId: "dev",
  });
  assert.equal(cross.kind, "not_found");

  const listA = reg.listCommitted({ subjectId: "subj.A", deviceId: "dev" });
  assert.equal(listA.length, 1);
  assert.equal(listA[0].subjectId, "subj.A");
});

test("idempotent replay of the same committed runId", () => {
  const reg = openCheckpointLineageRegistry({ backend: "memory" });
  const row = genesisRow({ subjectId: "subj.idem" });
  const first = reg.appendCommitted({ row });
  const again = reg.appendCommitted({
    row,
    expectedRevision: first.revision,
  });
  assert.equal(again.idempotentReplay, true);
  assert.equal(again.revision, first.revision);
});

test("committed JSON schema artifact matches exporter", () => {
  const onDisk = JSON.parse(
    readFileSync(path.join(REPO_ROOT, CHECKPOINT_LINEAGE_SCHEMA_RELPATH), "utf8"),
  );
  const generated = checkpointLineageJsonSchema();
  assert.equal(onDisk.schemaVersion, CHECKPOINT_LINEAGE_SCHEMA_VERSION);
  assert.deepEqual(onDisk.required, generated.required);
  assert.deepEqual(onDisk.properties.stage, generated.properties.stage);
  assert.equal(resolveCheckpointLineageBackend({}), "memory");
});

test("reject floating latest checkpoint hash", () => {
  const bad = parseCheckpointLineageRow(
    genesisRow({ checkpointHash: "latest" }),
  );
  assert.equal(bad.ok, false);
});
