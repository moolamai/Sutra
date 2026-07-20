/**
 * Frame-sequence identity for anti-cheat replay parity.
 * Identity = sequenceIndex + frame type + payload hash (not final-answer equality).
 * CI also requires byte-identical canonicalizeFramesJson sequences.
 */

import { createHash } from "node:crypto";
import {
  canonicalizeFramesJson,
  loadGoldenTurnCorpus,
  replayGoldenTurn,
  unifiedDiff,
} from "./harness_bridge.mjs";

/** Soft cap — NFR bound on compared frames per turn. */
export const GYM_FRAME_COMPARE_LIMIT = 512;

/** Soft cap — NFR bound on corpus fixtures per CI gate run. */
export const GYM_REPLAY_CORPUS_LIMIT = 64;

/** Soft cap — distinct domains required in the parity corpus. */
export const PARITY_CORPUS_DOMAIN_LIMIT = 16;

/**
 * Capability domains covered by the production trajectory corpus.
 * Each domain must have ≥1 recorded trajectory in the gate.
 */
export const PARITY_CORPUS_DOMAINS = Object.freeze([
  "thought_answer",
  "tool_fence",
  "correction",
  "meter",
  "harness_error",
]);

/** Map production golden turn id → corpus domain. */
export const PARITY_TRAJECTORY_DOMAIN_BY_ID = Object.freeze({
  "thought-answer-basic": "thought_answer",
  "tool-call-fence": "tool_fence",
  "correction-loop": "correction",
  "meter-tick": "meter",
  "harness-error-terminal": "harness_error",
});

/**
 * Canonical payload hash for one harness frame (sorted-key JSON via harness canon).
 * @param {unknown} frame
 * @returns {string}
 */
export function hashFramePayload(frame) {
  const canonical = canonicalizeFramesJson([frame]).trim();
  const parsed = JSON.parse(canonical);
  const body = Array.isArray(parsed) ? parsed[0] : parsed;
  const digest = createHash("sha256")
    .update(`${JSON.stringify(body)}\n`)
    .digest("hex");
  return `sha256:${digest}`;
}

/**
 * @param {unknown} frame
 * @returns {{ sequenceIndex: number, type: string, payloadHash: string } | null}
 */
export function frameIdentity(frame) {
  if (!frame || typeof frame !== "object") return null;
  const f = /** @type {Record<string, unknown>} */ (frame);
  const sequenceIndex = f.sequenceIndex;
  const type = f.type;
  if (typeof sequenceIndex !== "number" || typeof type !== "string") {
    return null;
  }
  return {
    sequenceIndex,
    type,
    payloadHash: hashFramePayload(frame),
  };
}

/**
 * Compare expected vs actual frame sequences by identity.
 * @param {unknown[]} expected
 * @param {unknown[]} actual
 */
export function assertFrameSequenceIdentity(expected, actual) {
  if (!Array.isArray(expected) || !Array.isArray(actual)) {
    return {
      ok: false,
      failingFrameIndex: -1,
      failingFrameType: "(invalid)",
      detail: "expected and actual must be frame arrays",
      expectedId: null,
      actualId: null,
    };
  }
  if (
    expected.length > GYM_FRAME_COMPARE_LIMIT ||
    actual.length > GYM_FRAME_COMPARE_LIMIT
  ) {
    return {
      ok: false,
      failingFrameIndex: -1,
      failingFrameType: "(section_limit)",
      detail: `frame count exceeds ${GYM_FRAME_COMPARE_LIMIT}`,
      expectedId: null,
      actualId: null,
    };
  }
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i += 1) {
    const expId = i < expected.length ? frameIdentity(expected[i]) : null;
    const actId = i < actual.length ? frameIdentity(actual[i]) : null;
    if (
      !expId ||
      !actId ||
      expId.sequenceIndex !== actId.sequenceIndex ||
      expId.type !== actId.type ||
      expId.payloadHash !== actId.payloadHash
    ) {
      return {
        ok: false,
        failingFrameIndex: i,
        failingFrameType: actId?.type ?? expId?.type ?? "(missing)",
        detail:
          `frame-sequence identity failed at index=${i} ` +
          `(expected type=${expId?.type ?? "∅"} hash=${expId?.payloadHash ?? "∅"}; ` +
          `actual type=${actId?.type ?? "∅"} hash=${actId?.payloadHash ?? "∅"})`,
        expectedId: expId,
        actualId: actId,
      };
    }
  }
  return { ok: true };
}

/**
 * Byte-identical canonical frame sequence (charter CI contract).
 * On divergence: frame-level identity detail + unified diff (never auto-update).
 *
 * @param {unknown[]} expected
 * @param {unknown[]} actual
 * @param {{ turnId?: string }} [opts]
 */
export function assertByteIdenticalCanonicalFrames(expected, actual, opts = {}) {
  const turnId = opts.turnId ?? "turn";
  const identity = assertFrameSequenceIdentity(expected, actual);
  const expectedJson = canonicalizeFramesJson(expected);
  const actualJson = canonicalizeFramesJson(actual);

  if (identity.ok && expectedJson === actualJson) {
    return {
      ok: true,
      expectedJson,
      actualJson,
      diff: "",
      failingFrameIndex: -1,
      failingFrameType: null,
      detail: null,
    };
  }

  const diff = unifiedDiff(expectedJson, actualJson, {
    fromFile: `gym/${turnId}.expected.json`,
    toFile: `gym/${turnId}.actual.json`,
  });

  return {
    ok: false,
    expectedJson,
    actualJson,
    diff,
    failingFrameIndex: identity.ok ? -1 : identity.failingFrameIndex,
    failingFrameType: identity.ok ? "(canonical_bytes)" : identity.failingFrameType,
    detail: identity.ok
      ? `byte-identical canonical drift for ${turnId}`
      : identity.detail,
  };
}

/**
 * Replay a recorded production-path fixture through the gym harness bridge
 * (imports production runtime-harness — never a gym-local parser).
 * @param {object} fixture
 * @param {{ onTelemetry?: (e: object) => void }} [opts]
 */
export function replayProductionTrajectoryThroughGym(fixture, opts = {}) {
  return replayGoldenTurn(fixture, {
    onTelemetry: opts.onTelemetry
      ? (e) => {
          opts.onTelemetry?.({
            event: "training.gym.replay_parity",
            outcome: e.outcome,
            subjectId: e.subjectId,
            ...(e.deviceId !== undefined ? { deviceId: e.deviceId } : {}),
            ...(e.failureClass !== undefined
              ? { failureClass: e.failureClass }
              : {}),
            ...(e.frameCount !== undefined
              ? { frameCount: e.frameCount }
              : {}),
            ...(e.turnId !== undefined ? { turnId: e.turnId } : {}),
          });
        }
      : undefined,
  });
}

/**
 * CI gate: load recorded production golden corpus, replay through gym bridge,
 * require byte-identical canonical frame sequences. Fail with frame-level diff.
 *
 * @param {{
 *   subjectId?: string,
 *   deviceId?: string,
 *   onTelemetry?: (e: object) => void,
 * }} [opts]
 */
export function runTrajectoryReplayParityGate(opts = {}) {
  const subjectId = opts.subjectId ?? "subj-gym-replay-parity-ci";
  const deviceId = opts.deviceId ?? "dev-gym-replay-parity-ci";
  /** @type {(e: object) => void} */
  const emit = (e) => {
    opts.onTelemetry?.(e);
  };

  emit({
    event: "training.gym.replay_parity",
    outcome: "start",
    phase: "gate",
    subjectId,
    deviceId,
  });

  const loaded = loadGoldenTurnCorpus({
    deviceId,
    onTelemetry: (e) => {
      emit({
        event: "training.gym.replay_parity",
        phase: "load",
        outcome: e.outcome,
        subjectId: e.subjectId ?? null,
        deviceId,
        ...(e.failureClass !== undefined
          ? { failureClass: e.failureClass }
          : {}),
      });
    },
  });

  if (!loaded.ok) {
    emit({
      event: "training.gym.replay_parity",
      outcome: "rejected",
      phase: "gate",
      subjectId: loaded.subjectId,
      deviceId,
      failureClass: loaded.failureClass,
    });
    return {
      ok: false,
      failureClass: loaded.failureClass,
      detail: loaded.detail,
      subjectId: loaded.subjectId,
      deviceId,
      turnId: null,
      domain: null,
      diff: "",
      frameIndex: null,
      frameType: null,
      turnCount: 0,
      domainCount: 0,
      domains: [],
    };
  }

  if (loaded.fixtures.length > GYM_REPLAY_CORPUS_LIMIT) {
    emit({
      event: "training.gym.replay_parity",
      outcome: "rejected",
      phase: "gate",
      subjectId,
      deviceId,
      failureClass: "section_limit",
    });
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `corpus fixture count exceeds ${GYM_REPLAY_CORPUS_LIMIT}`,
      subjectId,
      deviceId,
      turnId: null,
      diff: "",
      frameIndex: null,
      frameType: null,
      turnCount: 0,
      domainCount: 0,
      domains: [],
    };
  }

  /** @type {Set<string>} */
  const domainsSeen = new Set();
  for (const fixture of loaded.fixtures) {
    const id = typeof fixture.id === "string" ? fixture.id : "";
    const domain = PARITY_TRAJECTORY_DOMAIN_BY_ID[id];
    if (!domain) {
      emit({
        event: "training.gym.replay_parity",
        outcome: "rejected",
        phase: "gate",
        subjectId: fixture.subjectId ?? subjectId,
        deviceId,
        turnId: id || null,
        failureClass: "schema_violation",
      });
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `production trajectory ${id || "(missing)"} has no corpus domain mapping`,
        subjectId: fixture.subjectId ?? subjectId,
        deviceId,
        turnId: id || null,
        diff: "",
        frameIndex: null,
        frameType: null,
        turnCount: 0,
        domainCount: 0,
        domains: [],
      };
    }
    domainsSeen.add(domain);
  }

  const missingDomains = PARITY_CORPUS_DOMAINS.filter((d) => !domainsSeen.has(d));
  if (missingDomains.length > 0) {
    emit({
      event: "training.gym.replay_parity",
      outcome: "rejected",
      phase: "gate",
      subjectId,
      deviceId,
      failureClass: "missing_corpus",
    });
    return {
      ok: false,
      failureClass: "missing_corpus",
      detail: `parity corpus missing domains: ${missingDomains.join(",")}`,
      subjectId,
      deviceId,
      turnId: null,
      diff: "",
      frameIndex: null,
      frameType: null,
      turnCount: 0,
      domainCount: domainsSeen.size,
      domains: [...domainsSeen].sort(),
    };
  }

  if (domainsSeen.size > PARITY_CORPUS_DOMAIN_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `domain count exceeds ${PARITY_CORPUS_DOMAIN_LIMIT}`,
      subjectId,
      deviceId,
      turnId: null,
      diff: "",
      frameIndex: null,
      frameType: null,
      turnCount: 0,
      domainCount: domainsSeen.size,
      domains: [...domainsSeen].sort(),
    };
  }

  let turnCount = 0;
  for (const fixture of loaded.fixtures) {
    const result = replayProductionTrajectoryThroughGym(fixture, {
      onTelemetry: opts.onTelemetry,
    });

    if (!result.ok) {
      emit({
        event: "training.gym.replay_parity",
        outcome: "rejected",
        phase: "gate",
        subjectId: result.subjectId,
        deviceId: result.deviceId ?? deviceId,
        turnId: fixture.id,
        domain: PARITY_TRAJECTORY_DOMAIN_BY_ID[fixture.id],
        failureClass: result.failureClass,
      });
      return {
        ok: false,
        failureClass: result.failureClass,
        detail: result.detail,
        subjectId: result.subjectId,
        deviceId: result.deviceId ?? deviceId,
        turnId: fixture.id,
        domain: PARITY_TRAJECTORY_DOMAIN_BY_ID[fixture.id] ?? null,
        diff: result.diff ?? "",
        frameIndex: null,
        frameType: null,
        turnCount,
        domainCount: domainsSeen.size,
        domains: [...domainsSeen].sort(),
      };
    }

    const byteCheck = assertByteIdenticalCanonicalFrames(
      fixture.expectedFrames,
      result.frames,
      { turnId: fixture.id },
    );
    if (!byteCheck.ok) {
      emit({
        event: "training.gym.replay_parity",
        outcome: "rejected",
        phase: "gate",
        subjectId: result.subjectId,
        deviceId: result.deviceId ?? deviceId,
        turnId: fixture.id,
        domain: PARITY_TRAJECTORY_DOMAIN_BY_ID[fixture.id],
        failureClass: "canonical_drift",
        frameIndex: byteCheck.failingFrameIndex,
        frameType: byteCheck.failingFrameType,
      });
      return {
        ok: false,
        failureClass: "canonical_drift",
        detail: byteCheck.detail,
        subjectId: result.subjectId,
        deviceId: result.deviceId ?? deviceId,
        turnId: fixture.id,
        domain: PARITY_TRAJECTORY_DOMAIN_BY_ID[fixture.id] ?? null,
        diff: byteCheck.diff,
        frameIndex: byteCheck.failingFrameIndex,
        frameType: byteCheck.failingFrameType,
        turnCount,
        domainCount: domainsSeen.size,
        domains: [...domainsSeen].sort(),
      };
    }

    turnCount += 1;
  }

  const domains = [...domainsSeen].sort();
  emit({
    event: "training.gym.replay_parity",
    outcome: "ok",
    phase: "gate",
    subjectId,
    deviceId,
    turnCount,
    domainCount: domains.length,
  });

  return {
    ok: true,
    turnCount,
    domainCount: domains.length,
    domains,
    subjectId,
    deviceId,
    failureClass: null,
    detail: null,
    turnId: null,
    domain: null,
    diff: "",
    frameIndex: null,
    frameType: null,
  };
}
