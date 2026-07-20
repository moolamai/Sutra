/**
 * Shared wire-parity golden fixture — parses with Zod (TS side of SYNC-01).
 * Fixture: fixtures/wire-parity/golden-envelopes.json
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  cognitiveStateSchema,
  frictionSampleSchema,
  syncRequestSchema,
  syncResponseSchema,
  agentTurnRequestSchema,
  agentTurnResponseSchema,
} from "../dist/index.js";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/wire-parity/golden-envelopes.json",
);

const golden = JSON.parse(readFileSync(fixturePath, "utf8"));

test("shared golden fixture parses identically on the Zod side", () => {
  const state = cognitiveStateSchema.parse(golden.cognitiveState);
  const friction = frictionSampleSchema.parse(golden.friction);
  const syncReq = syncRequestSchema.parse({
    ...golden.syncRequest,
    edgeState: golden.cognitiveState,
  });
  const syncRes = syncResponseSchema.parse({
    ...golden.syncResponse,
    mergedState: golden.cognitiveState,
  });
  const turnReq = agentTurnRequestSchema.parse({
    ...golden.agentTurnRequest,
    friction: golden.friction,
  });
  const turnRes = agentTurnResponseSchema.parse(golden.agentTurnResponse);

  assert.equal(state.subjectId, "anika-k");
  assert.equal(friction.outcome, "correct");
  assert.equal(syncReq.syncAttemptId, "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(syncRes.advisories[0].code, "CLOCK_SKEW_CLAMPED");
  assert.equal(turnReq.subjectId, state.subjectId);
  assert.equal(turnRes.masteryEstimate, 0.42);
});
