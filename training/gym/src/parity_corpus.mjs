/**
 * Production trajectory corpus for gym replay parity.
 *
 * Indexes recorded production-path golden turns across capability domains.
 * Parity is frame-sequence identity (sequenceIndex + type + payload hash) with
 * canonical serialization for byte-identical compare and frame-level diff on failure.
 */

import {
  assertByteIdenticalCanonicalFrames,
  frameIdentity,
  GYM_REPLAY_CORPUS_LIMIT,
  PARITY_CORPUS_DOMAIN_LIMIT,
  PARITY_CORPUS_DOMAINS,
  PARITY_TRAJECTORY_DOMAIN_BY_ID,
  replayProductionTrajectoryThroughGym,
} from "./frame_parity.mjs";
import {
  canonicalizeFramesJson,
  loadGoldenTurnCorpus,
} from "./harness_bridge.mjs";

export {
  PARITY_CORPUS_DOMAIN_LIMIT,
  PARITY_CORPUS_DOMAINS,
  PARITY_TRAJECTORY_DOMAIN_BY_ID,
} from "./frame_parity.mjs";

/**
 * @typedef {{
 *   id: string,
 *   domain: string,
 *   subjectId: string,
 *   deviceId: string,
 *   fixture: object,
 * }} ParityCorpusEntry
 */

/**
 * Load the production trajectory corpus (A P6 goldens tagged by domain).
 * @param {{
 *   deviceId?: string,
 *   onTelemetry?: (e: object) => void,
 * }} [opts]
 */
export function loadProductionTrajectoryParityCorpus(opts = {}) {
  const deviceId = opts.deviceId ?? "dev-parity-corpus";
  /** @type {(e: object) => void} */
  const emit = (e) => {
    opts.onTelemetry?.(e);
  };

  emit({
    event: "training.gym.replay_parity",
    phase: "corpus_load",
    outcome: "start",
    subjectId: null,
    deviceId,
  });

  const loaded = loadGoldenTurnCorpus({
    deviceId,
    onTelemetry: (e) => {
      emit({
        event: "training.gym.replay_parity",
        phase: "corpus_load",
        outcome: e.outcome,
        subjectId: e.subjectId ?? null,
        deviceId,
        ...(e.failureClass !== undefined
          ? { failureClass: e.failureClass }
          : {}),
        ...(e.turnCount !== undefined ? { turnCount: e.turnCount } : {}),
      });
    },
  });

  if (!loaded.ok) {
    return {
      ok: false,
      failureClass: loaded.failureClass,
      detail: loaded.detail,
      subjectId: loaded.subjectId,
      deviceId,
      entries: /** @type {ParityCorpusEntry[]} */ ([]),
      domains: /** @type {string[]} */ ([]),
      turnCount: 0,
    };
  }

  if (loaded.fixtures.length > GYM_REPLAY_CORPUS_LIMIT) {
    emit({
      event: "training.gym.replay_parity",
      phase: "corpus_load",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      failureClass: "section_limit",
    });
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `corpus fixture count exceeds ${GYM_REPLAY_CORPUS_LIMIT}`,
      subjectId: null,
      deviceId,
      entries: [],
      domains: [],
      turnCount: 0,
    };
  }

  /** @type {ParityCorpusEntry[]} */
  const entries = [];
  /** @type {Set<string>} */
  const domainsSeen = new Set();

  for (const fixture of loaded.fixtures) {
    const id = typeof fixture.id === "string" ? fixture.id : "";
    const domain = PARITY_TRAJECTORY_DOMAIN_BY_ID[id];
    if (!domain) {
      emit({
        event: "training.gym.replay_parity",
        phase: "corpus_load",
        outcome: "rejected",
        subjectId: fixture.subjectId ?? null,
        deviceId,
        turnId: id || null,
        failureClass: "schema_violation",
      });
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `production trajectory ${id || "(missing)"} has no corpus domain mapping`,
        subjectId: fixture.subjectId ?? null,
        deviceId,
        entries: [],
        domains: [],
        turnCount: 0,
      };
    }
    if (!fixture.subjectId || typeof fixture.subjectId !== "string") {
      return {
        ok: false,
        failureClass: "missing_subject",
        detail: `trajectory ${id} missing subjectId`,
        subjectId: null,
        deviceId,
        entries: [],
        domains: [],
        turnCount: 0,
      };
    }
    domainsSeen.add(domain);
    entries.push({
      id,
      domain,
      subjectId: fixture.subjectId,
      deviceId:
        typeof fixture.deviceId === "string" && fixture.deviceId.trim()
          ? fixture.deviceId
          : deviceId,
      fixture,
    });
  }

  const missingDomains = PARITY_CORPUS_DOMAINS.filter((d) => !domainsSeen.has(d));
  if (missingDomains.length > 0) {
    emit({
      event: "training.gym.replay_parity",
      phase: "corpus_load",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      failureClass: "missing_corpus",
    });
    return {
      ok: false,
      failureClass: "missing_corpus",
      detail: `parity corpus missing domains: ${missingDomains.join(",")}`,
      subjectId: null,
      deviceId,
      entries: [],
      domains: [...domainsSeen].sort(),
      turnCount: 0,
    };
  }

  if (domainsSeen.size > PARITY_CORPUS_DOMAIN_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `domain count exceeds ${PARITY_CORPUS_DOMAIN_LIMIT}`,
      subjectId: null,
      deviceId,
      entries: [],
      domains: [...domainsSeen].sort(),
      turnCount: 0,
    };
  }

  const domains = [...domainsSeen].sort();
  emit({
    event: "training.gym.replay_parity",
    phase: "corpus_load",
    outcome: "ok",
    subjectId: null,
    deviceId,
    turnCount: entries.length,
    domainCount: domains.length,
  });

  return {
    ok: true,
    entries,
    domains,
    turnCount: entries.length,
    domainCount: domains.length,
    subjectId: null,
    deviceId,
    failureClass: null,
    detail: null,
  };
}

/**
 * Prove every corpus domain is represented (≥1 trajectory).
 * @param {{ entries: ParityCorpusEntry[], domains: string[] }} corpus
 */
export function assertParityCorpusMultiDomainCoverage(corpus) {
  if (!corpus || !Array.isArray(corpus.entries) || !Array.isArray(corpus.domains)) {
    return {
      ok: false,
      detail: "corpus entries/domains required",
      missingDomains: [...PARITY_CORPUS_DOMAINS],
    };
  }
  const seen = new Set(corpus.entries.map((e) => e.domain));
  const missingDomains = PARITY_CORPUS_DOMAINS.filter((d) => !seen.has(d));
  if (missingDomains.length > 0) {
    return {
      ok: false,
      detail: `missing domains: ${missingDomains.join(",")}`,
      missingDomains,
    };
  }
  if (corpus.entries.length < PARITY_CORPUS_DOMAINS.length) {
    return {
      ok: false,
      detail: "corpus must have at least one trajectory per domain",
      missingDomains: [],
    };
  }
  return { ok: true, detail: null, missingDomains: [] };
}

/**
 * Replay one corpus entry through GymEnv golden_replay path; compare to
 * production expectedFrames with canonical byte identity + frame-level diff.
 * @param {ParityCorpusEntry} entry
 * @param {{ seed?: number, onTelemetry?: (e: object) => void }} [opts]
 */
export async function replayParityCorpusEntryThroughGymEnv(entry, opts = {}) {
  const seed = opts.seed ?? 1;
  const { GymEnv } = await import("../env.ts");
  const env = new GymEnv({
    subjectId: entry.subjectId,
    deviceId: entry.deviceId,
    ...(opts.onTelemetry
      ? {
          onTelemetry: (e) => {
            opts.onTelemetry?.({
              event: "training.gym.replay_parity",
              phase: "gym_env",
              outcome: e.outcome,
              subjectId: e.subjectId ?? entry.subjectId,
              deviceId: e.deviceId ?? entry.deviceId,
              turnId: entry.id,
              domain: entry.domain,
              ...(e.failureClass !== undefined
                ? { failureClass: e.failureClass }
                : {}),
            });
          },
        }
      : {}),
  });

  const reset = env.reset(entry.id, seed);
  if (!reset.ok) {
    return {
      ok: false,
      failureClass: reset.failureClass,
      detail: reset.detail,
      subjectId: reset.subjectId,
      deviceId: reset.deviceId,
      turnId: entry.id,
      domain: entry.domain,
      frames: [],
      diff: "",
      failingFrameIndex: null,
      failingFrameType: null,
    };
  }

  const stepped = await env.step({ path: "golden_replay" });
  if (!stepped.ok) {
    return {
      ok: false,
      failureClass: stepped.failureClass,
      detail: stepped.detail,
      subjectId: stepped.subjectId,
      deviceId: stepped.deviceId,
      turnId: entry.id,
      domain: entry.domain,
      frames: [],
      diff: "",
      failingFrameIndex: null,
      failingFrameType: null,
    };
  }

  const expected = entry.fixture.expectedFrames;
  const byteCheck = assertByteIdenticalCanonicalFrames(expected, stepped.frames, {
    turnId: entry.id,
  });
  if (!byteCheck.ok) {
    return {
      ok: false,
      failureClass: "canonical_drift",
      detail: byteCheck.detail,
      subjectId: entry.subjectId,
      deviceId: entry.deviceId,
      turnId: entry.id,
      domain: entry.domain,
      frames: stepped.frames,
      diff: byteCheck.diff,
      failingFrameIndex: byteCheck.failingFrameIndex,
      failingFrameType: byteCheck.failingFrameType,
    };
  }

  // Terminal must be production TURN_COMPLETE / HARNESS_ERROR only.
  const terminal = stepped.frames[stepped.frames.length - 1];
  const terminalType =
    terminal && typeof terminal === "object"
      ? /** @type {{ type?: string }} */ (terminal).type
      : undefined;
  if (terminalType !== "TURN_COMPLETE" && terminalType !== "HARNESS_ERROR") {
    return {
      ok: false,
      failureClass: "canonical_drift",
      detail: `non-production terminal frame type=${String(terminalType)}`,
      subjectId: entry.subjectId,
      deviceId: entry.deviceId,
      turnId: entry.id,
      domain: entry.domain,
      frames: stepped.frames,
      diff: "",
      failingFrameIndex: stepped.frames.length - 1,
      failingFrameType: terminalType ?? "(missing)",
    };
  }

  return {
    ok: true,
    subjectId: entry.subjectId,
    deviceId: entry.deviceId,
    turnId: entry.id,
    domain: entry.domain,
    frames: stepped.frames,
    canonicalJson: canonicalizeFramesJson(stepped.frames),
    terminalFrameType: terminalType,
    diff: "",
    failingFrameIndex: null,
    failingFrameType: null,
    failureClass: null,
    detail: null,
  };
}

/**
 * Replay the full production trajectory corpus through GymEnv.
 * @param {{
 *   subjectId?: string,
 *   deviceId?: string,
 *   onTelemetry?: (e: object) => void,
 * }} [opts]
 */
export async function runProductionTrajectoryParitySuite(opts = {}) {
  const subjectId = opts.subjectId ?? "subj-gym-parity-corpus";
  const deviceId = opts.deviceId ?? "dev-gym-parity-corpus";
  /** @type {(e: object) => void} */
  const emit = (e) => {
    opts.onTelemetry?.(e);
  };

  emit({
    event: "training.gym.replay_parity",
    phase: "suite",
    outcome: "start",
    subjectId,
    deviceId,
  });

  const corpus = loadProductionTrajectoryParityCorpus({
    deviceId,
    onTelemetry: opts.onTelemetry,
  });
  if (!corpus.ok) {
    emit({
      event: "training.gym.replay_parity",
      phase: "suite",
      outcome: "rejected",
      subjectId: corpus.subjectId,
      deviceId,
      failureClass: corpus.failureClass,
    });
    return {
      ok: false,
      failureClass: corpus.failureClass,
      detail: corpus.detail,
      subjectId: corpus.subjectId,
      deviceId,
      turnCount: 0,
      domainCount: 0,
      domains: corpus.domains,
      turnId: null,
      domain: null,
      diff: "",
      frameIndex: null,
      frameType: null,
    };
  }

  const coverage = assertParityCorpusMultiDomainCoverage(corpus);
  if (!coverage.ok) {
    emit({
      event: "training.gym.replay_parity",
      phase: "suite",
      outcome: "rejected",
      subjectId,
      deviceId,
      failureClass: "missing_corpus",
    });
    return {
      ok: false,
      failureClass: "missing_corpus",
      detail: coverage.detail,
      subjectId,
      deviceId,
      turnCount: 0,
      domainCount: corpus.domainCount,
      domains: corpus.domains,
      turnId: null,
      domain: null,
      diff: "",
      frameIndex: null,
      frameType: null,
    };
  }

  let turnCount = 0;
  for (const entry of corpus.entries) {
    // Bridge path (production harness import) must match committed frames.
    const bridge = replayProductionTrajectoryThroughGym(entry.fixture, {
      onTelemetry: opts.onTelemetry,
    });
    if (!bridge.ok) {
      emit({
        event: "training.gym.replay_parity",
        phase: "suite",
        outcome: "rejected",
        subjectId: bridge.subjectId,
        deviceId: bridge.deviceId ?? deviceId,
        turnId: entry.id,
        domain: entry.domain,
        failureClass: bridge.failureClass,
      });
      return {
        ok: false,
        failureClass: bridge.failureClass,
        detail: bridge.detail,
        subjectId: bridge.subjectId,
        deviceId: bridge.deviceId ?? deviceId,
        turnCount,
        domainCount: corpus.domainCount,
        domains: corpus.domains,
        turnId: entry.id,
        domain: entry.domain,
        diff: bridge.diff ?? "",
        frameIndex: null,
        frameType: null,
      };
    }

    const bridgeBytes = assertByteIdenticalCanonicalFrames(
      entry.fixture.expectedFrames,
      bridge.frames,
      { turnId: entry.id },
    );
    if (!bridgeBytes.ok) {
      emit({
        event: "training.gym.replay_parity",
        phase: "suite",
        outcome: "rejected",
        subjectId: entry.subjectId,
        deviceId: entry.deviceId,
        turnId: entry.id,
        domain: entry.domain,
        failureClass: "canonical_drift",
        frameIndex: bridgeBytes.failingFrameIndex,
        frameType: bridgeBytes.failingFrameType,
      });
      return {
        ok: false,
        failureClass: "canonical_drift",
        detail: bridgeBytes.detail,
        subjectId: entry.subjectId,
        deviceId: entry.deviceId,
        turnCount,
        domainCount: corpus.domainCount,
        domains: corpus.domains,
        turnId: entry.id,
        domain: entry.domain,
        diff: bridgeBytes.diff,
        frameIndex: bridgeBytes.failingFrameIndex,
        frameType: bridgeBytes.failingFrameType,
      };
    }

    // GymEnv path must match the same canonical sequence (one code path).
    const gym = await replayParityCorpusEntryThroughGymEnv(entry, {
      seed: 1,
      onTelemetry: opts.onTelemetry,
    });
    if (!gym.ok) {
      emit({
        event: "training.gym.replay_parity",
        phase: "suite",
        outcome: "rejected",
        subjectId: gym.subjectId,
        deviceId: gym.deviceId,
        turnId: entry.id,
        domain: entry.domain,
        failureClass: gym.failureClass,
        frameIndex: gym.failingFrameIndex,
        frameType: gym.failingFrameType,
      });
      return {
        ok: false,
        failureClass: gym.failureClass,
        detail: gym.detail,
        subjectId: gym.subjectId,
        deviceId: gym.deviceId,
        turnCount,
        domainCount: corpus.domainCount,
        domains: corpus.domains,
        turnId: entry.id,
        domain: entry.domain,
        diff: gym.diff,
        frameIndex: gym.failingFrameIndex,
        frameType: gym.failingFrameType,
      };
    }

    // Bridge vs GymEnv identity (sequenceIndex + payload hash).
    for (let i = 0; i < gym.frames.length; i += 1) {
      const exp = frameIdentity(bridge.frames[i]);
      const act = frameIdentity(gym.frames[i]);
      if (
        !exp ||
        !act ||
        exp.sequenceIndex !== act.sequenceIndex ||
        exp.type !== act.type ||
        exp.payloadHash !== act.payloadHash
      ) {
        const diff = assertByteIdenticalCanonicalFrames(
          bridge.frames,
          gym.frames,
          { turnId: `${entry.id}.bridge_vs_gym` },
        );
        emit({
          event: "training.gym.replay_parity",
          phase: "suite",
          outcome: "rejected",
          subjectId: entry.subjectId,
          deviceId: entry.deviceId,
          turnId: entry.id,
          domain: entry.domain,
          failureClass: "canonical_drift",
          frameIndex: i,
          frameType: act?.type ?? exp?.type ?? "(missing)",
        });
        return {
          ok: false,
          failureClass: "canonical_drift",
          detail: `bridge vs GymEnv identity failed at index=${i} domain=${entry.domain}`,
          subjectId: entry.subjectId,
          deviceId: entry.deviceId,
          turnCount,
          domainCount: corpus.domainCount,
          domains: corpus.domains,
          turnId: entry.id,
          domain: entry.domain,
          diff: diff.diff,
          frameIndex: i,
          frameType: act?.type ?? exp?.type ?? "(missing)",
        };
      }
    }

    turnCount += 1;
  }

  emit({
    event: "training.gym.replay_parity",
    phase: "suite",
    outcome: "ok",
    subjectId,
    deviceId,
    turnCount,
    domainCount: corpus.domainCount,
  });

  return {
    ok: true,
    turnCount,
    domainCount: corpus.domainCount,
    domains: corpus.domains,
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
