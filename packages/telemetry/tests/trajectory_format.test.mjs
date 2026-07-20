/**
 * Turn trajectory v1 schema — stages, tool calls, hashes, privacy gate.
 * Run: pnpm --filter @moolam/telemetry test (after build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRAJECTORY_FORBIDDEN_CONTENT_KEYS,
  TRAJECTORY_FORMAT_VERSION,
  assertTrajectorySchemaPrivacy,
  assertTurnTrajectoryExportConsent,
  emitTrajectoryObservability,
  enqueueTurnTrajectoryWrite,
  parseTurnTrajectoryV1,
  toTurnTrajectoryJsonSchema,
  trajectoryFormatJsonSchemaWithPrivacyGate,
  turnTrajectoryV1Schema,
} from "../dist/index.js";
import {
  TRAINING_EXPORT_CONSENT_SCOPE,
  TRAINING_EXPORT_SCHEMA_OBLIGATION,
  TRAINING_EXPORT_VERSION,
  NoExportableTrajectoriesError,
  createTrainingExportLineV1,
  exportTrajectories,
  parseFinetuneJob,
  parseTrainingExportLineV1,
  toTrainingExportV1JsonSchema,
  trainingExportError,
} from "../dist/export_pipeline.js";
import { runExportTrajectoriesCli } from "../bin/export-trajectories.mjs";
import { PROTOCOL_VERSION, encodeHLC } from "@moolam/sync-protocol";

function hlc(ms, logical, device = "edge-dev1") {
  return encodeHLC(ms, logical, device);
}

function validRecord(overrides = {}) {
  return {
    trajectoryFormatVersion: TRAJECTORY_FORMAT_VERSION,
    turnId: "turn-1",
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    sessionId: "sess-1",
    capturedAt: hlc(1_700_000_000_100, 2),
    locality: "on-device",
    consentRecordId: "consent-traj-001",
    stages: [
      { stage: "perceive", status: "ok", chunkIndex: 0 },
      { stage: "reason", status: "ok", chunkIndex: 0 },
      { stage: "act", status: "ok", chunkIndex: 0, opCode: "tool.invoke" },
    ],
    toolCalls: [
      {
        callId: "call-1",
        toolName: "lookup_concept",
        argsHash: "sha256:argsdeadbeef",
        argsByteLength: 48,
        status: "ok",
        resultHash: "sha256:resultdeadbeef",
        resultByteLength: 32,
      },
    ],
    outcomes: { status: "completed", terminalStage: "act" },
    modelId: "slm-edge-v1",
    promptHash: "sha256:prompthash001",
    responseHash: "sha256:responsehash001",
    promptByteLength: 256,
    responseByteLength: 128,
    ...overrides,
  };
}

test("happy path: schema round-trip with stages and toolCalls", () => {
  const parsed = parseTurnTrajectoryV1(validRecord());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.record.trajectoryFormatVersion, "trajectory.v1");
  assert.equal(parsed.record.stages.length, 3);
  assert.equal(parsed.record.toolCalls.length, 1);
  assert.equal(parsed.record.toolCalls[0].argsHash.startsWith("sha256:"), true);
  assert.equal(parsed.record.modelId, "slm-edge-v1");
  assert.equal(typeof parsed.record.promptHash, "string");
  assert.equal(typeof parsed.record.responseHash, "string");

  const again = turnTrajectoryV1Schema.parse(
    JSON.parse(JSON.stringify(parsed.record)),
  );
  assert.deepEqual(again, parsed.record);

  emitTrajectoryObservability({
    event: "telemetry.trajectory",
    outcome: "ok",
    subjectId: parsed.record.subjectId,
    deviceId: parsed.record.deviceId,
    stageCount: parsed.record.stages.length,
    toolCallCount: parsed.record.toolCalls.length,
  });
});

test("privacy: JSON Schema properties exclude forbidden content keys", () => {
  const { schema, privacy } = trajectoryFormatJsonSchemaWithPrivacyGate();
  assert.equal(privacy.ok, true);
  assert.equal(schema.title, "TurnTrajectoryV1");
  assert.equal(schema["x-trajectory-format-version"], TRAJECTORY_FORMAT_VERSION);
  assert.equal(schema["x-protocol-version"], PROTOCOL_VERSION);

  const required = /** @type {string[]} */ (schema.required ?? []);
  for (const field of [
    "trajectoryFormatVersion",
    "turnId",
    "subjectId",
    "stages",
    "toolCalls",
    "outcomes",
    "modelId",
    "promptHash",
    "responseHash",
    "consentRecordId",
  ]) {
    assert.ok(required.includes(field), `missing required ${field}`);
  }

  const props = /** @type {Record<string, unknown>} */ (schema.properties ?? {});
  for (const key of TRAJECTORY_FORBIDDEN_CONTENT_KEYS) {
    assert.ok(!(key in props), `forbidden key leaked into schema: ${key}`);
  }

  const poisoned = {
    ...schema,
    properties: { ...props, keystrokes: { type: "string" } },
  };
  const denied = assertTrajectorySchemaPrivacy(poisoned);
  assert.equal(denied.ok, false);
  assert.equal(denied.failureClass, "keystroke_forbidden");
});

test("edge: raw keystrokes / tool args rejected", () => {
  const withKeystrokes = parseTurnTrajectoryV1(
    validRecord({ keystrokes: "typed-secret" }),
  );
  assert.equal(withKeystrokes.ok, false);
  assert.equal(withKeystrokes.failureClass, "keystroke_forbidden");

  const withArgs = parseTurnTrajectoryV1(
    validRecord({
      toolCalls: [
        {
          callId: "call-1",
          toolName: "lookup_concept",
          argsHash: "sha256:x",
          status: "ok",
          arguments: { secret: "regulated" },
        },
      ],
    }),
  );
  assert.equal(withArgs.ok, false);
  assert.equal(withArgs.failureClass, "keystroke_forbidden");
});

test("edge: long turn chunked by stage still parses under stage cap", () => {
  const stages = [];
  for (let i = 0; i < 6; i++) {
    stages.push({
      stage: i % 3 === 0 ? "perceive" : i % 3 === 1 ? "reason" : "act",
      status: "ok",
      chunkIndex: Math.floor(i / 3),
    });
  }
  const parsed = parseTurnTrajectoryV1(validRecord({ stages }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.record.stages.length, 6);
});

test("edge: consent gate denies export without opt-in", () => {
  const parsed = parseTurnTrajectoryV1(validRecord());
  assert.equal(parsed.ok, true);

  const denied = assertTurnTrajectoryExportConsent(parsed.record, () => null);
  assert.equal(denied.ok, false);
  assert.equal(denied.failureClass, "consent_missing");

  const inactive = assertTurnTrajectoryExportConsent(parsed.record, () => ({
    consentRecordId: "consent-traj-001",
    subjectId: "learner-a",
    optedIn: false,
    active: true,
  }));
  assert.equal(inactive.ok, false);
  assert.equal(inactive.failureClass, "consent_denied");

  const allowed = assertTurnTrajectoryExportConsent(parsed.record, () => ({
    consentRecordId: "consent-traj-001",
    subjectId: "learner-a",
    optedIn: true,
    active: true,
  }));
  assert.equal(allowed.ok, true);
});

test("sovereignty: cross-subject consent is a defect", () => {
  const parsed = parseTurnTrajectoryV1(validRecord());
  assert.equal(parsed.ok, true);
  const gate = assertTurnTrajectoryExportConsent(parsed.record, () => ({
    consentRecordId: "consent-traj-001",
    subjectId: "learner-b",
    optedIn: true,
    active: true,
  }));
  assert.equal(gate.ok, false);
  assert.equal(gate.failureClass, "cross_subject");
});

test("edge: async write queues without blocking the turn", async () => {
  const parsed = parseTurnTrajectoryV1(validRecord());
  assert.equal(parsed.ok, true);

  let writerDone = false;
  const events = [];
  const queued = enqueueTurnTrajectoryWrite(
    parsed.record,
    async () => {
      await new Promise((r) => setTimeout(r, 30));
      writerDone = true;
    },
    { onTelemetry: (e) => events.push(e) },
  );
  assert.equal(queued.queued, true);
  assert.equal(writerDone, false, "turn must continue before durable write finishes");
  assert.equal(events[0]?.outcome, "queued");

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(writerDone, true);
  assert.ok(events.some((e) => e.outcome === "ok"));
  assert.ok(events.every((e) => !("prompt" in e) && !("keystrokes" in e)));
});

test("edge: missing consentRecordId rejected at parse", () => {
  const { consentRecordId: _drop, ...rest } = validRecord();
  const parsed = parseTurnTrajectoryV1(rest);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.failureClass, "consent_missing");
});

test("scalability: JSON Schema helper is bounded and deterministic", () => {
  const a = toTurnTrajectoryJsonSchema(PROTOCOL_VERSION);
  const b = toTurnTrajectoryJsonSchema(PROTOCOL_VERSION);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(
    Object.keys(/** @type {object} */ (a.properties ?? {})).length < 64,
  );
});

function exportConsent(overrides = {}) {
  return {
    consentRecordId: "consent-export-001",
    subjectId: "learner-a",
    scope: TRAINING_EXPORT_CONSENT_SCOPE,
    optedIn: true,
    active: true,
    ...overrides,
  };
}

test("training export: consented trajectory round-trips as metadata-only SFT JSONL", () => {
  const events = [];
  const created = createTrainingExportLineV1(
    validRecord(),
    exportConsent(),
    { onTelemetry: (event) => events.push(event) },
  );
  assert.equal(created.ok, true);
  assert.equal(created.value.trainingExportVersion, TRAINING_EXPORT_VERSION);
  assert.equal(created.value.kind, "sft");
  assert.equal(created.value.subjectId, "learner-a");
  assert.equal(created.value.sourceConsentRecordId, "consent-traj-001");
  assert.equal(created.value.exportConsentRecordId, "consent-export-001");
  assert.deepEqual(created.value.input, {
    contentHash: "sha256:prompthash001",
    byteLength: 256,
  });
  assert.deepEqual(created.value.output, {
    contentHash: "sha256:responsehash001",
    byteLength: 128,
  });

  const jsonlLine = JSON.stringify(created.value);
  assert.ok(!jsonlLine.includes("\n"), "one record must serialize to one JSONL line");
  assert.doesNotMatch(
    jsonlLine,
    /"prompt"|"reply"|"content"|"messages"|"keystrokes"/i,
  );
  const parsed = parseTrainingExportLineV1(JSON.parse(jsonlLine));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, created.value);
  assert.deepEqual(
    createTrainingExportLineV1(validRecord(), exportConsent()).value,
    created.value,
    "replay must map deterministically",
  );
  assert.deepEqual(events, [
    {
      event: "telemetry.training_export.contract",
      operation: "line",
      outcome: "accepted",
      subjectId: "learner-a",
      deviceId: "edge-dev1",
    },
  ]);
});

test("training export: committed schema matches helper and defines FinetuneJob", () => {
  const committed = JSON.parse(
    readFileSync(
      new URL("../schemas/training-export-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const generated = toTrainingExportV1JsonSchema();
  assert.deepEqual(committed, generated);
  assert.equal(committed.title, "TrainingExportLineV1");
  assert.equal(committed["x-content-policy"], "hashes-only");
  assert.deepEqual(committed.definitions.FinetuneJob.required, [
    "jobId",
    "adapterType",
    "baseModelId",
    "datasetUri",
  ]);
  for (const forbidden of [
    "prompt",
    "reply",
    "messages",
    "keystrokes",
    "arguments",
  ]) {
    assert.ok(!(forbidden in committed.properties));
  }
});

test("training export: FinetuneJob validates handoff only — no trainer lifecycle", () => {
  const parsed = parseFinetuneJob({
    jobId: "job-lora-001",
    adapterType: "lora",
    baseModelId: "base-model-v1",
    datasetUri: "file:///sovereign/export/training.jsonl",
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, {
    jobId: "job-lora-001",
    adapterType: "lora",
    baseModelId: "base-model-v1",
    datasetUri: "file:///sovereign/export/training.jsonl",
  });

  const extraLifecycle = parseFinetuneJob({
    ...parsed.value,
    status: "running",
  });
  assert.equal(extraLifecycle.ok, false);
  assert.equal(extraLifecycle.failureClass, "validation");
  const error = trainingExportError(extraLifecycle);
  assert.equal(error.name, "TrainingExportContractError");
  assert.equal(error.obligationId, TRAINING_EXPORT_SCHEMA_OBLIGATION);
});

test("training export consent gate rejects absent, inactive, wrong scope, and cross-subject", () => {
  const absent = createTrainingExportLineV1(validRecord(), null);
  assert.equal(absent.ok, false);
  assert.equal(absent.failureClass, "consent_missing");

  const inactive = createTrainingExportLineV1(
    validRecord(),
    exportConsent({ active: false }),
  );
  assert.equal(inactive.ok, false);
  assert.equal(inactive.failureClass, "consent_denied");

  const wrongScope = createTrainingExportLineV1(
    validRecord(),
    exportConsent({ scope: "trajectory" }),
  );
  assert.equal(wrongScope.ok, false);
  assert.equal(wrongScope.failureClass, "consent_scope_invalid");

  const cross = createTrainingExportLineV1(
    validRecord(),
    exportConsent({ subjectId: "learner-b" }),
  );
  assert.equal(cross.ok, false);
  assert.equal(cross.failureClass, "cross_subject");
});

test("training export rejects raw content and bounded-list overflow observably", () => {
  const base = createTrainingExportLineV1(validRecord(), exportConsent());
  assert.equal(base.ok, true);
  const events = [];
  const raw = parseTrainingExportLineV1(
    { ...base.value, prompt: "SECRET_TRAINING_BODY" },
    { onTelemetry: (event) => events.push(event) },
  );
  assert.equal(raw.ok, false);
  assert.equal(raw.failureClass, "raw_content_forbidden");

  const tooManyStages = createTrainingExportLineV1(
    validRecord({
      stages: Array.from({ length: 33 }, (_, i) => ({
        stage: "reason",
        status: "ok",
        chunkIndex: i,
      })),
    }),
    exportConsent(),
  );
  assert.equal(tooManyStages.ok, false);
  assert.equal(tooManyStages.failureClass, "limit");
  assert.doesNotMatch(JSON.stringify(events), /SECRET_TRAINING_BODY/);
  assert.deepEqual(events[0], {
    event: "telemetry.training_export.contract",
    operation: "line",
    outcome: "rejected",
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    failureClass: "raw_content_forbidden",
  });
});

test("exportTrajectories filters mixed consent, sorts a snapshot, and deduplicates replay", async () => {
  const first = validRecord({
    turnId: "turn-1",
    capturedAt: hlc(1_700_000_000_100, 2),
  });
  const second = validRecord({
    turnId: "turn-2",
    capturedAt: hlc(1_700_000_000_200, 0),
  });
  const events = [];
  let written = "";
  const result = await exportTrajectories({
    subjectId: "learner-a",
    readTrajectories: async (subjectId, limit) => {
      assert.equal(subjectId, "learner-a");
      assert.equal(limit, 16);
      return [second, first, first];
    },
    resolveConsent: (trajectory) =>
      trajectory.turnId === "turn-1"
        ? exportConsent()
        : exportConsent({ scope: "trajectory" }),
    writeJsonl: async (jsonl) => {
      written = jsonl;
    },
    limit: 16,
    onTelemetry: (event) => events.push(event),
  });

  assert.deepEqual(result, {
    subjectId: "learner-a",
    readCount: 3,
    exportedCount: 1,
    filteredCount: 2,
  });
  const rows = written.trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turnId, "turn-1");
  assert.equal(rows[0].exportConsentScope, TRAINING_EXPORT_CONSENT_SCOPE);
  assert.ok(
    events.some(
      (event) =>
        event.outcome === "filtered" &&
        event.failureClass === "consent_scope_invalid",
    ),
  );
  assert.equal(events.at(-1)?.outcome, "completed");
  assert.doesNotMatch(JSON.stringify(events), /promptHash|responseHash|keystrokes/);
});

test("exportTrajectories rejects cross-subject reads and surfaces bounded timeout/write failures", async () => {
  const events = [];
  await assert.rejects(
    exportTrajectories({
      subjectId: "learner-a",
      readTrajectories: () => [
        validRecord({ subjectId: "learner-b", turnId: "foreign-turn" }),
      ],
      resolveConsent: () => exportConsent(),
      writeJsonl: () => undefined,
      onTelemetry: (event) => events.push(event),
    }),
    (error) =>
      error.name === "TrainingExportContractError" &&
      error.failureClass === "cross_subject",
  );
  assert.ok(
    events.some(
      (event) =>
        event.outcome === "rejected" &&
        event.failureClass === "cross_subject",
    ),
  );

  await assert.rejects(
    exportTrajectories({
      subjectId: "learner-a",
      readTrajectories: () => new Promise(() => undefined),
      resolveConsent: () => exportConsent(),
      writeJsonl: () => undefined,
      timeoutMs: 10,
    }),
    (error) => error.failureClass === "timeout",
  );

  await assert.rejects(
    exportTrajectories({
      subjectId: "learner-a",
      readTrajectories: () => [validRecord()],
      resolveConsent: () => exportConsent(),
      writeJsonl: () => {
        throw new Error("synthetic sink failure");
      },
    }),
    (error) => error.failureClass === "write_failed",
  );
});

test("exportTrajectories emits typed NoExportableTrajectories without invoking its sink", async () => {
  let wrote = false;
  await assert.rejects(
    exportTrajectories({
      subjectId: "learner-a",
      readTrajectories: () => [validRecord()],
      resolveConsent: () => exportConsent({ active: false }),
      writeJsonl: () => {
        wrote = true;
      },
    }),
    (error) =>
      error instanceof NoExportableTrajectoriesError &&
      error.failureClass === "no_exportable_trajectories",
  );
  assert.equal(wrote, false);
});

test("exportTrajectories CLI reads local sovereign fixtures and atomically writes schema-valid JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moolam-export-"));
  const storePath = join(directory, "trajectories.jsonl");
  const consentPath = join(directory, "consent.json");
  const outputPath = join(directory, "training.jsonl");
  try {
    await writeFile(
      storePath,
      [
        JSON.stringify(
          validRecord({
            turnId: "turn-2",
            capturedAt: hlc(1_700_000_000_200, 0),
          }),
        ),
        JSON.stringify(
          validRecord({
            turnId: "foreign-turn",
            subjectId: "learner-b",
            capturedAt: hlc(1_700_000_000_300, 0, "edge-dev2"),
          }),
        ),
        JSON.stringify(validRecord()),
      ].join("\n"),
      "utf8",
    );
    await writeFile(outputPath, "do-not-replace-with-empty-export\n", "utf8");
    await writeFile(
      consentPath,
      JSON.stringify([
        exportConsent({ consentRecordId: "consent-denied", active: false }),
        exportConsent({
          consentRecordId: "consent-wrong-scope",
          scope: "trajectory",
        }),
      ]),
      "utf8",
    );

    await assert.rejects(
      runExportTrajectoriesCli([
        "--store",
        storePath,
        "--consent",
        consentPath,
        "--subject",
        "learner-a",
        "--out",
        outputPath,
      ]),
      (error) => error instanceof NoExportableTrajectoriesError,
    );
    assert.equal(
      await readFile(outputPath, "utf8"),
      "do-not-replace-with-empty-export\n",
    );

    await writeFile(
      consentPath,
      JSON.stringify([
        exportConsent({ consentRecordId: "consent-active" }),
        exportConsent({ consentRecordId: "consent-denied", optedIn: false }),
      ]),
      "utf8",
    );
    const result = await runExportTrajectoriesCli([
      "--store",
      storePath,
      "--consent",
      consentPath,
      "--subject",
      "learner-a",
      "--out",
      outputPath,
      "--limit",
      "8",
    ]);
    assert.equal(result.exportedCount, 2);
    const rows = (await readFile(outputPath, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      rows.map((row) => row.turnId),
      ["turn-1", "turn-2"],
    );
    assert.ok(rows.every((row) => parseTrainingExportLineV1(row).ok));
    assert.ok(rows.every((row) => row.subjectId === "learner-a"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
