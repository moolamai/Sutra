/**
 * SFT warmstart on C1 corpus manifests (C4).
 * Run: pnpm --filter @moolam/training-corpus test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SftWarmstartContractError,
  assertCorpusManifestHashFresh,
  proveSftWarmstartMicroRun,
  resetSftWarmstartCache,
  runSftWarmstart,
} from "../dist/sft_warmstart.js";
import {
  canonicalManifestSha256 as hashManifest,
  parseCorpusManifest as parseManifest,
} from "../dist/build.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
  __dirname,
  "..",
  "fixtures",
  "mix_policy",
  "ok-repair-curriculum.json",
);
const BASE = "ckpt:sha256:sftbase0123456789abcd";

test("happy path: micro-run SFT warmstart emits anchored checkpoint with corpus hash", () => {
  resetSftWarmstartCache();
  const events = [];
  const proved = proveSftWarmstartMicroRun({
    subjectId: "subj.sft.01",
    deviceId: "dev.sft.01",
    baseCheckpointHash: BASE,
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.checkpoint.sftWarmstartCompleted, true);
  assert.equal(proved.checkpoint.baseCheckpointHash, BASE);
  assert.match(proved.corpusManifestHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(proved.checkpoint.corpusManifestHash, proved.corpusManifestHash);
  assert.ok(proved.accepted.length >= 1);
  assert.ok(Number.isFinite(proved.supervisedLoss));
  assert.ok(events.some((e) => e.event === "training.sft_warmstart.anchor"));
  assert.ok(events.every((e) => !("content" in e) && !("text" in e) && !("utterance" in e)));
});

test("edge: RET-tagged examples blocked; unparseable frames excluded", () => {
  resetSftWarmstartCache();
  const golden = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const parsed = parseManifest(golden);
  assert.equal(parsed.ok, true);
  const manifest = parsed.value;
  const lane = manifest.laneCodes[0];

  const result = runSftWarmstart({
    manifest,
    baseCheckpointHash: BASE,
    subjectId: "subj.sft.01",
    deviceId: "dev.sft.01",
    examples: [
      {
        exampleId: "ex.ok",
        subjectId: "subj.sft.01",
        deviceId: "dev.sft.01",
        shardId: "shard.1",
        docId: "d1",
        knowledgeMode: "UND",
        laneCode: lane,
        contentHash:
          "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        frames: [
          { type: "SESSION_START", protocolVersion: "sutra.streaming-turn.v1" },
          { type: "ANSWER_DELTA" },
          { type: "TURN_COMPLETE" },
        ],
      },
      {
        exampleId: "ex.ret",
        subjectId: "subj.sft.01",
        deviceId: "dev.sft.01",
        shardId: "shard.ret",
        docId: "d-ret",
        knowledgeMode: "RET",
        laneCode: lane,
        contentHash:
          "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        frames: [
          { type: "SESSION_START", protocolVersion: "sutra.streaming-turn.v1" },
          { type: "TURN_COMPLETE" },
        ],
      },
      {
        exampleId: "ex.bad-grammar",
        subjectId: "subj.sft.01",
        deviceId: "dev.sft.01",
        shardId: "shard.2",
        docId: "d2",
        knowledgeMode: "UND",
        laneCode: lane,
        contentHash:
          "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        frames: [{ type: "ANSWER_DELTA" }],
      },
    ],
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].exampleId, "ex.ok");
  assert.ok(result.dropped.some((d) => d.reason === "sft.ret_policy"));
  assert.ok(result.dropped.some((d) => d.reason === "sft.grammar_filter"));
});

test("edge: corpus manifest hash drift refuses until SFT re-run", () => {
  resetSftWarmstartCache();
  const golden = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const parsed = parseManifest(golden);
  assert.equal(parsed.ok, true);
  const hash = hashManifest(parsed.value);

  assert.throws(
    () =>
      assertCorpusManifestHashFresh(parsed.value, "sha256:" + "0".repeat(64), {
        subjectId: "subj.sft.01",
      }),
    (err) =>
      err instanceof SftWarmstartContractError &&
      err.obligation === "sft.manifest_drift",
  );

  assert.equal(assertCorpusManifestHashFresh(parsed.value, hash), hash);
});

test("sovereignty: cross-subject examples refused", () => {
  resetSftWarmstartCache();
  assert.throws(
    () =>
      proveSftWarmstartMicroRun({
        subjectId: "subj.sft.01",
        deviceId: "dev.sft.01",
        baseCheckpointHash: BASE,
        examples: [
          {
            exampleId: "ex.x",
            subjectId: "subj.other",
            deviceId: "dev.sft.01",
            shardId: "shard.1",
            docId: "d1",
            knowledgeMode: "UND",
            laneCode: "pack.teacher.cbse-slice",
            contentHash:
              "sha256:4444444444444444444444444444444444444444444444444444444444444444",
            frames: [
              { type: "SESSION_START", protocolVersion: "sutra.streaming-turn.v1" },
              { type: "TURN_COMPLETE" },
            ],
          },
        ],
      }),
    (err) =>
      err instanceof SftWarmstartContractError &&
      err.obligation === "sft.subject_scope",
  );
});

test("idempotent: runId replay returns same anchored checkpoint", () => {
  resetSftWarmstartCache();
  const events = [];
  const a = proveSftWarmstartMicroRun({
    subjectId: "subj.sft.idem",
    deviceId: "dev.sft.01",
    baseCheckpointHash: BASE,
    onTelemetry: (e) => events.push(e),
  });
  const b = proveSftWarmstartMicroRun({
    subjectId: "subj.sft.idem",
    deviceId: "dev.sft.01",
    baseCheckpointHash: BASE,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(a.checkpoint.checkpointHash, b.checkpoint.checkpointHash);
  assert.equal(b.idempotentReplay, true);
  assert.ok(events.some((e) => e.idempotentReplay === true));
});
