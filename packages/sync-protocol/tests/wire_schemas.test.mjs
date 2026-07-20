/**
 * Wire-boundary Zod schemas — barrel export + round-trip / edge-case coverage.
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  WIRE_BOUNDARY_SCHEMAS,
  frictionSampleSchema,
  conceptMasterySchema,
  cognitiveStateSchema,
  syncRequestSchema,
  syncResponseSchema,
  syncAdvisorySchema,
  agentTurnRequestSchema,
  agentTurnResponseSchema,
} from "../dist/index.js";

const hlc = (ms, logical, device) =>
  `${String(ms).padStart(15, "0")}:${String(logical).padStart(6, "0")}:${device}`;

const VALID_FRICTION = {
  conceptId: "math.ratios",
  hesitationMs: 1200,
  inputVelocity: 3.2,
  revisionCount: 0,
  assistanceRequested: false,
  outcome: "correct",
  capturedAt: hlc(1_000_000, 1, "edge-aaaa"),
};

const VALID_STATE = {
  protocolVersion: PROTOCOL_VERSION,
  subjectId: "anika-k",
  deviceIds: ["edge-aaaa"],
  activeConceptId: "math.ratios",
  mode: "exploratory",
  mastery: {
    "math.ratios": {
      conceptId: "math.ratios",
      alpha: { "edge-aaaa": 3 },
      beta: { "edge-aaaa": 1 },
      lastExercisedAt: hlc(1_000_000, 0, "edge-aaaa"),
    },
  },
  frictionLog: [VALID_FRICTION],
  profile: {
    ageBand: "child",
    track: "cbse-class-7-maths",
    language: "hi-IN",
    updatedAt: hlc(1_000_000, 2, "edge-aaaa"),
  },
  stateVector: { session: hlc(1_000_000, 3, "edge-aaaa") },
};

const VALID_SYNC_REQUEST = {
  protocolVersion: PROTOCOL_VERSION,
  deviceId: "edge-aaaa",
  edgeState: VALID_STATE,
  lastKnownCloudVector: {},
  syncAttemptId: "550e8400-e29b-41d4-a716-446655440000",
};

const VALID_SYNC_RESPONSE = {
  protocolVersion: PROTOCOL_VERSION,
  mergedState: VALID_STATE,
  compactedSampleTimestamps: [VALID_FRICTION.capturedAt],
  advisories: [{ code: "CLOCK_SKEW_CLAMPED", detail: "clamped remote physical" }],
};

const VALID_AGENT_TURN_REQUEST = {
  protocolVersion: PROTOCOL_VERSION,
  subjectId: "anika-k",
  sessionId: "sess-1",
  utterance: "what is a ratio?",
  friction: VALID_FRICTION,
};

const VALID_AGENT_TURN_RESPONSE = {
  protocolVersion: PROTOCOL_VERSION,
  reply: "A ratio compares two quantities.",
  nextConceptId: "math.ratios.simplify",
  mode: "guided",
  routingRationale: "novice friction on core concept",
  masteryEstimate: 0.42,
};

const REQUIRED_WIRE_SCHEMAS = [
  "frictionSampleSchema",
  "conceptMasterySchema",
  "cognitiveStateSchema",
  "syncRequestSchema",
  "syncResponseSchema",
  "syncAdvisorySchema",
  "agentTurnRequestSchema",
  "agentTurnResponseSchema",
];

test("package barrel exports every wire-boundary Zod schema", () => {
  for (const name of REQUIRED_WIRE_SCHEMAS) {
    assert.equal(typeof WIRE_BOUNDARY_SCHEMAS[name]?.safeParse, "function", name);
  }
  assert.equal(typeof syncResponseSchema.safeParse, "function");
  assert.equal(typeof syncAdvisorySchema.safeParse, "function");
  assert.equal(typeof agentTurnRequestSchema.safeParse, "function");
  assert.equal(typeof agentTurnResponseSchema.safeParse, "function");
  assert.equal(typeof frictionSampleSchema.safeParse, "function");
  assert.equal(typeof conceptMasterySchema.safeParse, "function");
  assert.equal(typeof cognitiveStateSchema.safeParse, "function");
  assert.equal(typeof syncRequestSchema.safeParse, "function");
});

test("valid fixtures round-trip every wire envelope schema", () => {
  assert.equal(frictionSampleSchema.parse(VALID_FRICTION).conceptId, "math.ratios");
  assert.equal(cognitiveStateSchema.parse(VALID_STATE).subjectId, "anika-k");
  assert.equal(syncRequestSchema.parse(VALID_SYNC_REQUEST).deviceId, "edge-aaaa");
  assert.equal(syncResponseSchema.parse(VALID_SYNC_RESPONSE).advisories[0].code, "CLOCK_SKEW_CLAMPED");
  assert.equal(syncAdvisorySchema.parse(VALID_SYNC_RESPONSE.advisories[0]).code, "CLOCK_SKEW_CLAMPED");
  assert.equal(agentTurnRequestSchema.parse(VALID_AGENT_TURN_REQUEST).subjectId, "anika-k");
  assert.equal(agentTurnResponseSchema.parse(VALID_AGENT_TURN_RESPONSE).masteryEstimate, 0.42);
});

test("rejects invalid mutations with typed Zod issues (named obligation)", () => {
  const badAttempt = syncRequestSchema.safeParse({
    ...VALID_SYNC_REQUEST,
    syncAttemptId: "not-a-uuid",
  });
  assert.equal(badAttempt.success, false);
  assert.ok(badAttempt.error.issues.some((i) => i.path.includes("syncAttemptId")));

  const badAdvisory = syncAdvisorySchema.safeParse({
    code: "NOT_A_REAL_CODE",
    detail: "x",
  });
  assert.equal(badAdvisory.success, false);
  assert.ok(badAdvisory.error.issues.some((i) => i.path.includes("code")));

  const badMastery = agentTurnResponseSchema.safeParse({
    ...VALID_AGENT_TURN_RESPONSE,
    masteryEstimate: 1.5,
  });
  assert.equal(badMastery.success, false);
  assert.ok(badMastery.error.issues.some((i) => i.path.includes("masteryEstimate")));

  const badHlc = syncResponseSchema.safeParse({
    ...VALID_SYNC_RESPONSE,
    compactedSampleTimestamps: ["not-an-hlc"],
  });
  assert.equal(badHlc.success, false);
  assert.ok(
    badHlc.error.issues.some(
      (i) => i.path.includes("compactedSampleTimestamps") || String(i.message).includes("HLC"),
    ),
  );
});

test("unknown keys are stripped at the wire boundary (never passthrough)", () => {
  const parsed = agentTurnRequestSchema.parse({
    ...VALID_AGENT_TURN_REQUEST,
    leakedLearnerName: "should-not-survive",
  });
  assert.equal(Object.hasOwn(parsed, "leakedLearnerName"), false);

  const response = syncResponseSchema.parse({
    ...VALID_SYNC_RESPONSE,
    internalDebugBlob: { raw: "secret" },
  });
  assert.equal(Object.hasOwn(response, "internalDebugBlob"), false);
});

test("subject isolation: empty subjectId is rejected (cross-subject gap)", () => {
  const emptySubject = agentTurnRequestSchema.safeParse({
    ...VALID_AGENT_TURN_REQUEST,
    subjectId: "",
  });
  assert.equal(emptySubject.success, false);
  assert.ok(emptySubject.error.issues.some((i) => i.path.includes("subjectId")));

  const emptyStateSubject = cognitiveStateSchema.safeParse({
    ...VALID_STATE,
    subjectId: "",
  });
  assert.equal(emptyStateSubject.success, false);
  assert.ok(emptyStateSubject.error.issues.some((i) => i.path.includes("subjectId")));
});

test("optional vs nullable: activeConceptId null accepted; omitted mode rejected", () => {
  const withNull = cognitiveStateSchema.safeParse({
    ...VALID_STATE,
    activeConceptId: null,
  });
  assert.equal(withNull.success, true);
  assert.equal(withNull.data.activeConceptId, null);

  const { mode: _drop, ...withoutMode } = VALID_STATE;
  const missingMode = cognitiveStateSchema.safeParse(withoutMode);
  assert.equal(missingMode.success, false);
  assert.ok(missingMode.error.issues.some((i) => i.path.includes("mode")));
});
