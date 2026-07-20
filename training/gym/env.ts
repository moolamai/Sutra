/**
 * GymEnv — resettable / seedable RL environment wrapping production harness.
 *
 * Imports @moolam/runtime-harness only (via harness_bridge). Never re-implements
 * parser, sandbox, correction loop, or frame assembly. Episode terminal flag is
 * derived solely from TURN_COMPLETE / HARNESS_ERROR frames — no custom done.
 */

import { createHash } from "node:crypto";
import {
  createHarnessDeterminismContext,
  type HarnessDeterminismContext,
} from "./determinism.ts";
import {
  cloneSnapshotAtGymReset,
  discardGymSnapshotAtTerminal,
  resolveGymSnapshotStore,
  type CognitiveRolloutSnapshot,
  type SnapshotExportConsent,
  type SnapshotStoreRepository,
} from "./snapshot_store.ts";
import {
  createDefaultGymToolRegistry,
  loadGoldenTurnCorpus,
  replayGoldenTurn,
  runProductionTurnLoop,
} from "./src/harness_bridge.mjs";

/** Soft caps (NFR — bounded episode buffer). */
export const GYM_ENV_FRAME_LIMIT = 512;
export const GYM_ENV_SCENARIO_ID_MAX = 128;
export const GYM_ENV_SEED_MAX = 0xffff_ffff;

/** Production terminal frame types only (charter). */
export const GYM_TERMINAL_FRAME_TYPES = Object.freeze([
  "TURN_COMPLETE",
  "HARNESS_ERROR",
] as const);

export type GymTerminalFrameType = (typeof GYM_TERMINAL_FRAME_TYPES)[number];

export type GymEnvFailureClass =
  | "not_reset"
  | "unknown_scenario"
  | "invalid_seed"
  | "invalid_action"
  | "harness_reject"
  | "already_terminal"
  | "cross_subject"
  | "config"
  | "frame_budget";

export type GymEnvTelemetry = {
  event: "training.gym.env";
  op: "reset" | "step" | "load_scenario";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  scenarioId?: string;
  seed?: number;
  episodeId?: string;
  failureClass?: GymEnvFailureClass;
  frameCount?: number;
  terminalFrameType?: GymTerminalFrameType | null;
  detail?: string;
};

export type GymScenarioRef =
  | string
  | {
      scenarioId: string;
      /** Optional override; default from golden fixture. */
      subjectId?: string;
      deviceId?: string;
    };

export type GymAction = {
  /**
   * Model / stream chunks for this step. When omitted, the loaded scenario
   * fixture.input is used.
   */
  chunks?: string[];
  /**
   * `turn_loop` (default) — ToolCallParser + StreamingTurnHost + sandbox
   * registry + correction loop (production path).
   * `golden_replay` — recorded golden fixture replay (parity / CI).
   */
  path?: "turn_loop" | "golden_replay";
  /** Optional in-process tool registry for turn_loop (default: lookup tool). */
  registry?: unknown;
};

export type GymObservation = {
  scenarioId: string;
  subjectId: string;
  deviceId: string;
  seed: number;
  episodeId: string;
  stepIndex: number;
  /** True after a step that ended on a production terminal frame. */
  terminal: boolean;
  terminalFrameType: GymTerminalFrameType | null;
};

export type GymStepResult = {
  ok: true;
  observation: GymObservation;
  /** Exact production harness frame batch for this step. */
  frames: unknown[];
  /** Derived from frames only — never a gym-invented done bit. */
  terminal: boolean;
  terminalFrameType: GymTerminalFrameType | null;
  subjectId: string;
  deviceId: string;
  /** How many sandbox tool invokes ran (turn_loop path). */
  toolInvocations?: number;
  /** Step path used. */
  path: "turn_loop" | "golden_replay";
};

export type GymResetResult = {
  ok: true;
  observation: GymObservation;
  subjectId: string;
  deviceId: string;
  scenarioId: string;
  seed: number;
  episodeId: string;
};

export type GymEnvError = {
  ok: false;
  failureClass: GymEnvFailureClass;
  detail: string;
  subjectId: string;
  deviceId: string;
};

type LoadedScenario = {
  scenarioId: string;
  subjectId: string;
  deviceId: string;
  correlationId: string;
  input: string[];
  expectedFrames: unknown[];
  coverage: string[];
};

function emit(
  onTelemetry: ((e: GymEnvTelemetry) => void) | undefined,
  partial: Omit<GymEnvTelemetry, "event">,
): void {
  onTelemetry?.({ event: "training.gym.env", ...partial });
}

function normalizeScenarioRef(scenario: GymScenarioRef): {
  scenarioId: string;
  subjectId?: string;
  deviceId?: string;
} {
  if (typeof scenario === "string") {
    return { scenarioId: scenario.trim() };
  }
  return {
    scenarioId: scenario.scenarioId.trim(),
    ...(scenario.subjectId !== undefined
      ? { subjectId: scenario.subjectId.trim() }
      : {}),
    ...(scenario.deviceId !== undefined
      ? { deviceId: scenario.deviceId.trim() }
      : {}),
  };
}

/**
 * Derive terminal flag solely from harness frame types.
 * Custom gym done flags are forbidden.
 */
export function terminalFromHarnessFrames(frames: readonly unknown[]): {
  terminal: boolean;
  terminalFrameType: GymTerminalFrameType | null;
} {
  if (!Array.isArray(frames) || frames.length < 1) {
    return { terminal: false, terminalFrameType: null };
  }
  const last = frames[frames.length - 1];
  if (!last || typeof last !== "object") {
    return { terminal: false, terminalFrameType: null };
  }
  const type = (last as { type?: unknown }).type;
  if (type === "TURN_COMPLETE" || type === "HARNESS_ERROR") {
    return { terminal: true, terminalFrameType: type };
  }
  return { terminal: false, terminalFrameType: null };
}

export function isGymTerminalFrameType(
  value: unknown,
): value is GymTerminalFrameType {
  return value === "TURN_COMPLETE" || value === "HARNESS_ERROR";
}

/**
 * Frame types that must NEVER set episode terminal / done by themselves.
 * Derived from the production harness frame enum minus terminal types.
 */
export const GYM_NON_TERMINAL_FRAME_TYPES = Object.freeze(
  [
    "SESSION_START",
    "THOUGHT_DELTA",
    "ANSWER_DELTA",
    "TOOL_STATUS",
    "ADVISORY_ATTACH",
    "METER_TICK",
  ] as const,
);

export type GymTerminationMappingFailureClass =
  | "custom_done_forbidden"
  | "terminal_mismatch"
  | "non_terminal_marked_done"
  | "missing_frames";

/**
 * Assert episode termination mapping for a harness frame batch.
 * Terminal iff the last frame is TURN_COMPLETE or HARNESS_ERROR.
 * Custom `done` bits are a hard failure (anti-cheat).
 */
export function assertEpisodeTerminationMapping(
  input: {
    frames: readonly unknown[];
    /** Optional observation / step result to cross-check. */
    observation?: {
      terminal?: boolean;
      terminalFrameType?: unknown;
      done?: unknown;
    };
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: GymEnvTelemetry) => void;
  },
):
  | {
      ok: true;
      terminal: boolean;
      terminalFrameType: GymTerminalFrameType | null;
      subjectId: string;
      deviceId: string;
    }
  | {
      ok: false;
      failureClass: GymTerminationMappingFailureClass;
      detail: string;
      subjectId: string;
      deviceId: string;
    } {
  const subjectId = input.subjectId?.trim() || "subj.gym.terminal";
  const deviceId = input.deviceId?.trim() || "dev-gym-terminal";

  const fail = (
    failureClass: GymTerminationMappingFailureClass,
    detail: string,
  ) => {
    emit(input.onTelemetry, {
      op: "step",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "harness_reject",
      detail: `${failureClass}: ${detail}`,
    });
    return {
      ok: false as const,
      failureClass,
      detail,
      subjectId,
      deviceId,
    };
  };

  if (!Array.isArray(input.frames)) {
    return fail("missing_frames", "frames must be an array");
  }

  if (
    input.observation !== undefined &&
    Object.prototype.hasOwnProperty.call(input.observation, "done")
  ) {
    return fail(
      "custom_done_forbidden",
      "custom observation.done is forbidden — use terminal from harness frames",
    );
  }

  const derived = terminalFromHarnessFrames(input.frames);

  if (input.observation !== undefined) {
    if (input.observation.terminal !== derived.terminal) {
      return fail(
        "terminal_mismatch",
        `observation.terminal=${String(input.observation.terminal)} ≠ derived=${String(derived.terminal)}`,
      );
    }
    if (input.observation.terminalFrameType !== derived.terminalFrameType) {
      return fail(
        "terminal_mismatch",
        `observation.terminalFrameType=${String(input.observation.terminalFrameType)} ≠ derived=${String(derived.terminalFrameType)}`,
      );
    }
  }

  if (!derived.terminal && input.frames.length > 0) {
    const last = input.frames[input.frames.length - 1];
    const type =
      last && typeof last === "object"
        ? (last as { type?: unknown }).type
        : undefined;
    if (
      typeof type === "string" &&
      (GYM_NON_TERMINAL_FRAME_TYPES as readonly string[]).includes(type) &&
      input.observation?.terminal === true
    ) {
      return fail(
        "non_terminal_marked_done",
        `frame type ${type} must not set terminal`,
      );
    }
  }

  emit(input.onTelemetry, {
    op: "step",
    outcome: "ok",
    subjectId,
    deviceId,
    frameCount: input.frames.length,
    terminalFrameType: derived.terminalFrameType,
    detail: derived.terminal
      ? `terminal=${derived.terminalFrameType}`
      : "non-terminal batch",
  });

  return {
    ok: true,
    terminal: derived.terminal,
    terminalFrameType: derived.terminalFrameType,
    subjectId,
    deviceId,
  };
}

function validateSeed(seed: unknown): seed is number {
  return (
    typeof seed === "number" &&
    Number.isInteger(seed) &&
    seed >= 0 &&
    seed <= GYM_ENV_SEED_MAX
  );
}

function episodeIdFor(input: {
  scenarioId: string;
  subjectId: string;
  seed: number;
}): string {
  const digest = createHash("sha256")
    .update(
      `${input.scenarioId}\n${input.subjectId}\n${input.seed}\n`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return `ep.${digest}`;
}

/**
 * Load a golden / guidance scenario fixture by id from the production corpus.
 */
export function loadGymScenarioFixture(
  scenario: GymScenarioRef,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: GymEnvTelemetry) => void;
  } = {},
):
  | { ok: true; scenario: LoadedScenario; subjectId: string; deviceId: string }
  | GymEnvError {
  const ref = normalizeScenarioRef(scenario);
  const subjectId = options.subjectId?.trim() || "subj.gym.env";
  const deviceId = options.deviceId?.trim() || "dev-gym-env";

  if (!ref.scenarioId || ref.scenarioId.length > GYM_ENV_SCENARIO_ID_MAX) {
    emit(options.onTelemetry, {
      op: "load_scenario",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "unknown_scenario",
      detail: "scenarioId required (max length bound)",
    });
    return {
      ok: false,
      failureClass: "unknown_scenario",
      detail: "scenarioId required (max length bound)",
      subjectId,
      deviceId,
    };
  }

  const loaded = loadGoldenTurnCorpus({
    deviceId,
  });
  if (!loaded.ok) {
    emit(options.onTelemetry, {
      op: "load_scenario",
      outcome: "error",
      subjectId,
      deviceId,
      scenarioId: ref.scenarioId,
      failureClass: "config",
      detail: loaded.detail,
    });
    return {
      ok: false,
      failureClass: "config",
      detail: loaded.detail,
      subjectId,
      deviceId,
    };
  }

  const fixture = loaded.fixtures.find((f) => f.id === ref.scenarioId);
  if (!fixture) {
    emit(options.onTelemetry, {
      op: "load_scenario",
      outcome: "error",
      subjectId,
      deviceId,
      scenarioId: ref.scenarioId,
      failureClass: "unknown_scenario",
      detail: `scenario not in golden corpus: ${ref.scenarioId}`,
    });
    return {
      ok: false,
      failureClass: "unknown_scenario",
      detail: `scenario not in golden corpus: ${ref.scenarioId}`,
      subjectId,
      deviceId,
    };
  }

  const scopedSubject = ref.subjectId || fixture.subjectId;
  const scopedDevice = ref.deviceId || fixture.deviceId;
  if (scopedSubject !== fixture.subjectId) {
    // Scenario fixtures are subject-scoped; override must match fixture or be omitted.
    emit(options.onTelemetry, {
      op: "load_scenario",
      outcome: "error",
      subjectId: scopedSubject,
      deviceId: scopedDevice,
      scenarioId: ref.scenarioId,
      failureClass: "cross_subject",
      detail: "scenario subjectId override must match fixture subjectId",
    });
    return {
      ok: false,
      failureClass: "cross_subject",
      detail: "scenario subjectId override must match fixture subjectId",
      subjectId: scopedSubject,
      deviceId: scopedDevice,
    };
  }

  const scenarioLoaded: LoadedScenario = {
    scenarioId: fixture.id,
    subjectId: fixture.subjectId,
    deviceId: fixture.deviceId,
    correlationId: fixture.correlationId,
    input: [...fixture.input],
    expectedFrames: [...fixture.expectedFrames],
    coverage: [...fixture.coverage],
  };

  emit(options.onTelemetry, {
    op: "load_scenario",
    outcome: "ok",
    subjectId: scenarioLoaded.subjectId,
    deviceId: scenarioLoaded.deviceId,
    scenarioId: scenarioLoaded.scenarioId,
    detail: `chunks=${scenarioLoaded.input.length}`,
  });

  return {
    ok: true,
    scenario: scenarioLoaded,
    subjectId: scenarioLoaded.subjectId,
    deviceId: scenarioLoaded.deviceId,
  };
}

/**
 * Resettable / seedable gym environment over the production harness path.
 * One instance = one rollout; do not share across subjects.
 */
export class GymEnv {
  private scenario: LoadedScenario | null = null;
  private seed: number | null = null;
  private episodeId: string | null = null;
  private determinism: HarnessDeterminismContext | null = null;
  private rolloutSnapshot: CognitiveRolloutSnapshot | null = null;
  private stepIndex = 0;
  private terminal = false;
  private terminalFrameType: GymTerminalFrameType | null = null;
  private lastStep: GymStepResult | null = null;
  private readonly onTelemetry: ((e: GymEnvTelemetry) => void) | undefined;
  private readonly defaultSubjectId: string;
  private readonly defaultDeviceId: string;
  private readonly defaultRegistry: unknown;
  private readonly snapshotStore: SnapshotStoreRepository;
  private readonly snapshotTemplate: CognitiveRolloutSnapshot | null;
  private readonly trajectoryConsent: SnapshotExportConsent | null;
  private snapshotTeardownDone = false;

  constructor(
    options: {
      subjectId?: string;
      deviceId?: string;
      onTelemetry?: (e: GymEnvTelemetry) => void;
      /** Optional tool registry injected into turn_loop steps. */
      registry?: unknown;
      /** Optional snapshot repository (default: env-selected memory). */
      snapshotStore?: SnapshotStoreRepository;
      /** Optional template deep-cloned at reset (never live prod alias). */
      snapshotTemplate?: CognitiveRolloutSnapshot | null;
      /**
       * When opted-in, terminal teardown retains the snapshot for export.
       * Missing / declined → discard (default sovereign path).
       */
      trajectoryConsent?: SnapshotExportConsent | null;
    } = {},
  ) {
    this.defaultSubjectId = options.subjectId?.trim() || "subj.gym.env";
    this.defaultDeviceId = options.deviceId?.trim() || "dev-gym-env";
    this.onTelemetry = options.onTelemetry;
    this.defaultRegistry =
      options.registry ?? createDefaultGymToolRegistry();
    this.snapshotStore = resolveGymSnapshotStore({
      deviceId: this.defaultDeviceId,
      ...(options.snapshotStore !== undefined
        ? { snapshotStore: options.snapshotStore }
        : {}),
      ...(this.onTelemetry !== undefined
        ? {
            onTelemetry: (e) => {
              emit(this.onTelemetry, {
                op: "reset",
                outcome: e.outcome === "ok" ? "ok" : "error",
                subjectId: e.subjectId ?? this.defaultSubjectId,
                deviceId: e.deviceId,
                ...(e.episodeId !== undefined
                  ? { episodeId: e.episodeId }
                  : {}),
                ...(e.failureClass !== undefined
                  ? {
                      failureClass:
                        e.failureClass === "cross_subject"
                          ? "cross_subject"
                          : e.failureClass === "missing_subject"
                            ? "config"
                            : "config",
                    }
                  : {}),
                detail: e.detail ?? "snapshot store",
              });
            },
          }
        : {}),
    });
    this.snapshotTemplate = options.snapshotTemplate ?? null;
    this.trajectoryConsent = options.trajectoryConsent ?? null;
  }

  /** Bound seed after successful reset (determinism control consumes this). */
  getHarnessSeed(): number | null {
    return this.seed;
  }

  /** Seeded clock + per-rollout RNG bound at reset (never shared across envs). */
  getDeterminismContext(): HarnessDeterminismContext | null {
    return this.determinism;
  }

  /** Deep-cloned cognitive snapshot for this episode (null before reset). */
  getRolloutSnapshot(): CognitiveRolloutSnapshot | null {
    return this.rolloutSnapshot;
  }

  getEpisodeId(): string | null {
    return this.episodeId;
  }

  getScenarioId(): string | null {
    return this.scenario?.scenarioId ?? null;
  }

  /**
   * Load scenario fixture and seed the harness context.
   * Idempotent for the same (scenario, seed): returns equivalent observation.
   */
  reset(
    scenario: GymScenarioRef,
    seed: number,
  ): GymResetResult | GymEnvError {
    const subjectHint = this.defaultSubjectId;
    const deviceHint = this.defaultDeviceId;

    if (!validateSeed(seed)) {
      emit(this.onTelemetry, {
        op: "reset",
        outcome: "error",
        subjectId: subjectHint,
        deviceId: deviceHint,
        failureClass: "invalid_seed",
        detail: `seed must be integer in [0, ${GYM_ENV_SEED_MAX}]`,
      });
      return {
        ok: false,
        failureClass: "invalid_seed",
        detail: `seed must be integer in [0, ${GYM_ENV_SEED_MAX}]`,
        subjectId: subjectHint,
        deviceId: deviceHint,
      };
    }

    const loaded = loadGymScenarioFixture(scenario, {
      subjectId: subjectHint,
      deviceId: deviceHint,
      ...(this.onTelemetry !== undefined
        ? { onTelemetry: this.onTelemetry }
        : {}),
    });
    if (!loaded.ok) {
      return loaded;
    }

    const episodeId = episodeIdFor({
      scenarioId: loaded.scenario.scenarioId,
      subjectId: loaded.scenario.subjectId,
      seed,
    });

    const injected = createHarnessDeterminismContext({
      seed,
      subjectId: loaded.scenario.subjectId,
      deviceId: loaded.scenario.deviceId,
      scenarioId: loaded.scenario.scenarioId,
      episodeId,
      ...(this.onTelemetry !== undefined
        ? {
            onTelemetry: (e) => {
              emit(this.onTelemetry, {
                op: "reset",
                outcome: e.outcome,
                subjectId: e.subjectId,
                deviceId: e.deviceId,
                ...(e.scenarioId !== undefined
                  ? { scenarioId: e.scenarioId }
                  : {}),
                ...(e.seed !== undefined ? { seed: e.seed } : {}),
                ...(e.episodeId !== undefined
                  ? { episodeId: e.episodeId }
                  : {}),
                ...(e.failureClass !== undefined
                  ? {
                      failureClass:
                        e.failureClass === "invalid_seed"
                          ? "invalid_seed"
                          : e.failureClass === "cross_subject"
                            ? "cross_subject"
                            : "config",
                    }
                  : {}),
                detail: e.detail ?? "determinism inject",
              });
            },
          }
        : {}),
    });
    if (!injected.ok) {
      return {
        ok: false,
        failureClass:
          injected.failureClass === "invalid_seed"
            ? "invalid_seed"
            : injected.failureClass === "cross_subject"
              ? "cross_subject"
              : "config",
        detail: injected.detail,
        subjectId: injected.subjectId,
        deviceId: injected.deviceId,
      };
    }

    const cloned = cloneSnapshotAtGymReset({
      store: this.snapshotStore,
      subjectId: loaded.scenario.subjectId,
      deviceId: loaded.scenario.deviceId,
      episodeId,
      template: this.snapshotTemplate,
      ...(this.onTelemetry !== undefined
        ? {
            onTelemetry: (e) => {
              emit(this.onTelemetry, {
                op: "reset",
                outcome: e.outcome === "ok" ? "ok" : "error",
                subjectId: e.subjectId ?? loaded.scenario.subjectId,
                deviceId: e.deviceId,
                scenarioId: loaded.scenario.scenarioId,
                seed,
                episodeId,
                ...(e.failureClass !== undefined
                  ? {
                      failureClass:
                        e.failureClass === "cross_subject"
                          ? "cross_subject"
                          : "config",
                    }
                  : {}),
                detail: e.detail ?? "snapshot clone",
              });
            },
          }
        : {}),
    });
    if (!cloned.ok) {
      return {
        ok: false,
        failureClass:
          cloned.failureClass === "cross_subject"
            ? "cross_subject"
            : "config",
        detail: cloned.detail,
        subjectId: cloned.subjectId,
        deviceId: cloned.deviceId,
      };
    }

    this.scenario = loaded.scenario;
    this.seed = seed;
    this.episodeId = episodeId;
    this.determinism = injected.context;
    this.rolloutSnapshot = cloned.snapshot;
    this.stepIndex = 0;
    this.terminal = false;
    this.terminalFrameType = null;
    this.lastStep = null;
    this.snapshotTeardownDone = false;

    const observation: GymObservation = {
      scenarioId: loaded.scenario.scenarioId,
      subjectId: loaded.scenario.subjectId,
      deviceId: loaded.scenario.deviceId,
      seed,
      episodeId,
      stepIndex: 0,
      terminal: false,
      terminalFrameType: null,
    };

    emit(this.onTelemetry, {
      op: "reset",
      outcome: "ok",
      subjectId: observation.subjectId,
      deviceId: observation.deviceId,
      scenarioId: observation.scenarioId,
      seed,
      episodeId,
      detail:
        "scenario loaded; harness seed + determinism + snapshot clone bound",
    });

    return {
      ok: true,
      observation,
      subjectId: observation.subjectId,
      deviceId: observation.deviceId,
      scenarioId: observation.scenarioId,
      seed,
      episodeId,
    };
  }

  /**
   * Advance the episode via the production turn loop (parser + host +
   * sandbox registry + correction) or golden replay. Terminal flag is
   * derived from harness frames only. Replayed step after terminal is
   * idempotent.
   */
  async step(action: GymAction = {}): Promise<GymStepResult | GymEnvError> {
    const subjectHint =
      this.scenario?.subjectId ?? this.defaultSubjectId;
    const deviceHint = this.scenario?.deviceId ?? this.defaultDeviceId;

    if (
      this.scenario === null ||
      this.seed === null ||
      this.episodeId === null
    ) {
      emit(this.onTelemetry, {
        op: "step",
        outcome: "error",
        subjectId: subjectHint,
        deviceId: deviceHint,
        failureClass: "not_reset",
        detail: "reset(scenario, seed) required before step",
      });
      return {
        ok: false,
        failureClass: "not_reset",
        detail: "reset(scenario, seed) required before step",
        subjectId: subjectHint,
        deviceId: deviceHint,
      };
    }

    if (this.terminal && this.lastStep !== null) {
      emit(this.onTelemetry, {
        op: "step",
        outcome: "ok",
        subjectId: this.scenario.subjectId,
        deviceId: this.scenario.deviceId,
        scenarioId: this.scenario.scenarioId,
        seed: this.seed,
        episodeId: this.episodeId,
        frameCount: this.lastStep.frames.length,
        terminalFrameType: this.lastStep.terminalFrameType,
        detail: "idempotent replay of terminal step",
      });
      return this.lastStep;
    }

    if (action !== null && typeof action !== "object") {
      emit(this.onTelemetry, {
        op: "step",
        outcome: "error",
        subjectId: this.scenario.subjectId,
        deviceId: this.scenario.deviceId,
        failureClass: "invalid_action",
        detail: "action must be an object",
      });
      return {
        ok: false,
        failureClass: "invalid_action",
        detail: "action must be an object",
        subjectId: this.scenario.subjectId,
        deviceId: this.scenario.deviceId,
      };
    }

    const path = action.path === "golden_replay" ? "golden_replay" : "turn_loop";
    const chunks =
      action.chunks !== undefined ? action.chunks : this.scenario.input;
    if (!Array.isArray(chunks) || chunks.length < 1) {
      emit(this.onTelemetry, {
        op: "step",
        outcome: "error",
        subjectId: this.scenario.subjectId,
        deviceId: this.scenario.deviceId,
        failureClass: "invalid_action",
        detail: "action.chunks must be a non-empty string[] when provided",
      });
      return {
        ok: false,
        failureClass: "invalid_action",
        detail: "action.chunks must be a non-empty string[] when provided",
        subjectId: this.scenario.subjectId,
        deviceId: this.scenario.deviceId,
      };
    }
    if (chunks.some((c) => typeof c !== "string")) {
      return {
        ok: false,
        failureClass: "invalid_action",
        detail: "action.chunks entries must be strings",
        subjectId: this.scenario.subjectId,
        deviceId: this.scenario.deviceId,
      };
    }

    if (path === "golden_replay") {
      return this.stepGoldenReplay(chunks);
    }
    return this.stepTurnLoop(chunks, action.registry ?? this.defaultRegistry);
  }

  private finalizeStep(input: {
    frames: unknown[];
    path: "turn_loop" | "golden_replay";
    toolInvocations?: number;
    detail: string;
  }): GymStepResult | GymEnvError {
    if (this.scenario === null || this.seed === null || this.episodeId === null) {
      return {
        ok: false,
        failureClass: "not_reset",
        detail: "reset(scenario, seed) required before step",
        subjectId: this.defaultSubjectId,
        deviceId: this.defaultDeviceId,
      };
    }

    if (input.frames.length > GYM_ENV_FRAME_LIMIT) {
      return {
        ok: false,
        failureClass: "frame_budget",
        detail: `frame batch exceeds ${GYM_ENV_FRAME_LIMIT}`,
        subjectId: this.scenario.subjectId,
        deviceId: this.scenario.deviceId,
      };
    }

    for (const frame of input.frames) {
      const sid = (frame as { subjectId?: string }).subjectId;
      if (sid !== this.scenario.subjectId) {
        emit(this.onTelemetry, {
          op: "step",
          outcome: "error",
          subjectId: this.scenario.subjectId,
          deviceId: this.scenario.deviceId,
          failureClass: "cross_subject",
          detail: "harness frame subjectId diverged from scenario",
        });
        return {
          ok: false,
          failureClass: "cross_subject",
          detail: "harness frame subjectId diverged from scenario",
          subjectId: this.scenario.subjectId,
          deviceId: this.scenario.deviceId,
        };
      }
    }

    const derived = terminalFromHarnessFrames(input.frames);
    this.stepIndex += 1;
    this.terminal = derived.terminal;
    this.terminalFrameType = derived.terminalFrameType;

    if (derived.terminal && !this.snapshotTeardownDone) {
      this.runSnapshotTeardownAtTerminal();
    }

    const observation: GymObservation = {
      scenarioId: this.scenario.scenarioId,
      subjectId: this.scenario.subjectId,
      deviceId: this.scenario.deviceId,
      seed: this.seed,
      episodeId: this.episodeId,
      stepIndex: this.stepIndex,
      terminal: derived.terminal,
      terminalFrameType: derived.terminalFrameType,
    };

    const result: GymStepResult = {
      ok: true,
      observation,
      frames: input.frames,
      terminal: derived.terminal,
      terminalFrameType: derived.terminalFrameType,
      subjectId: this.scenario.subjectId,
      deviceId: this.scenario.deviceId,
      path: input.path,
      ...(input.toolInvocations !== undefined
        ? { toolInvocations: input.toolInvocations }
        : {}),
    };
    this.lastStep = result;

    emit(this.onTelemetry, {
      op: "step",
      outcome: "ok",
      subjectId: observation.subjectId,
      deviceId: observation.deviceId,
      scenarioId: observation.scenarioId,
      seed: this.seed,
      episodeId: this.episodeId,
      frameCount: result.frames.length,
      terminalFrameType: derived.terminalFrameType,
      detail: input.detail,
    });

    return result;
  }

  /**
   * On episode terminal: discard snapshot unless trajectory export consent
   * passes; release fleet slot. Idempotent across repeated terminal steps.
   */
  private runSnapshotTeardownAtTerminal(): void {
    if (
      this.snapshotTeardownDone ||
      this.scenario === null ||
      this.episodeId === null
    ) {
      return;
    }
    this.snapshotTeardownDone = true;
    const torn = discardGymSnapshotAtTerminal({
      store: this.snapshotStore,
      subjectId: this.scenario.subjectId,
      deviceId: this.scenario.deviceId,
      episodeId: this.episodeId,
      consent: this.trajectoryConsent,
      releaseFleet: this.snapshotStore.rolloutId !== undefined,
    });
    if (torn.ok && torn.discarded) {
      this.rolloutSnapshot = null;
    } else if (torn.ok && torn.retained) {
      this.rolloutSnapshot = torn.snapshot;
    }
  }

  private stepGoldenReplay(chunks: string[]): GymStepResult | GymEnvError {
    if (this.scenario === null || this.seed === null || this.episodeId === null) {
      return {
        ok: false,
        failureClass: "not_reset",
        detail: "reset(scenario, seed) required before step",
        subjectId: this.defaultSubjectId,
        deviceId: this.defaultDeviceId,
      };
    }

    const fixture = {
      id: this.scenario.scenarioId,
      subjectId: this.scenario.subjectId,
      deviceId: this.scenario.deviceId,
      correlationId: this.scenario.correlationId,
      input: chunks,
      expectedFrames: this.scenario.expectedFrames,
      coverage: this.scenario.coverage,
    };

    const replayed = replayGoldenTurn(fixture, {
      onTelemetry: (e) => {
        emit(this.onTelemetry, {
          op: "step",
          outcome: e.outcome === "ok" ? "ok" : "error",
          subjectId: e.subjectId ?? this.scenario!.subjectId,
          deviceId: e.deviceId ?? this.scenario!.deviceId,
          scenarioId: this.scenario!.scenarioId,
          seed: this.seed!,
          episodeId: this.episodeId!,
          ...(e.failureClass !== undefined
            ? { failureClass: "harness_reject" }
            : {}),
          ...(e.frameCount !== undefined ? { frameCount: e.frameCount } : {}),
          detail: "production harness golden replay",
        });
      },
    });

    if (!replayed.ok) {
      emit(this.onTelemetry, {
        op: "step",
        outcome: "error",
        subjectId: this.scenario.subjectId,
        deviceId: this.scenario.deviceId,
        scenarioId: this.scenario.scenarioId,
        seed: this.seed,
        episodeId: this.episodeId,
        failureClass: "harness_reject",
        detail: replayed.detail,
      });
      return {
        ok: false,
        failureClass: "harness_reject",
        detail: replayed.detail,
        subjectId: this.scenario.subjectId,
        deviceId: this.scenario.deviceId,
      };
    }

    return this.finalizeStep({
      frames: replayed.frames,
      path: "golden_replay",
      detail: "golden_replay path",
    });
  }

  private async stepTurnLoop(
    chunks: string[],
    registry: unknown,
  ): Promise<GymStepResult | GymEnvError> {
    if (this.scenario === null || this.seed === null || this.episodeId === null) {
      return {
        ok: false,
        failureClass: "not_reset",
        detail: "reset(scenario, seed) required before step",
        subjectId: this.defaultSubjectId,
        deviceId: this.defaultDeviceId,
      };
    }

    const pinnedAtFrame = this.scenario.expectedFrames.find(
      (f) =>
        f &&
        typeof f === "object" &&
        (f as { type?: string }).type === "SESSION_START",
    ) as { pinnedAt?: string } | undefined;
    const pinnedAt =
      pinnedAtFrame?.pinnedAt ?? this.determinism?.clock.toIso();

    const turnId = this.scenario.correlationId.replace(/^corr-/, "turn-");
    const looped = await runProductionTurnLoop({
      subjectId: this.scenario.subjectId,
      deviceId: this.scenario.deviceId,
      correlationId: this.scenario.correlationId,
      turnId,
      chunks,
      seed: this.seed,
      ...(pinnedAt !== undefined ? { pinnedAt } : {}),
      ...(registry !== undefined ? { registry } : {}),
      onTelemetry: (e) => {
        emit(this.onTelemetry, {
          op: "step",
          outcome: e.outcome === "ok" ? "ok" : "error",
          subjectId: e.subjectId ?? this.scenario!.subjectId,
          deviceId: e.deviceId ?? this.scenario!.deviceId,
          scenarioId: this.scenario!.scenarioId,
          seed: this.seed!,
          episodeId: this.episodeId!,
          ...(e.failureClass !== undefined
            ? { failureClass: "harness_reject" }
            : {}),
          ...(e.frameCount !== undefined ? { frameCount: e.frameCount } : {}),
          detail: e.detail ?? "production turn loop",
        });
      },
    });

    if (!looped.ok) {
      emit(this.onTelemetry, {
        op: "step",
        outcome: "error",
        subjectId: this.scenario.subjectId,
        deviceId: this.scenario.deviceId,
        scenarioId: this.scenario.scenarioId,
        seed: this.seed,
        episodeId: this.episodeId,
        failureClass: "harness_reject",
        detail: looped.detail,
      });
      return {
        ok: false,
        failureClass: "harness_reject",
        detail: looped.detail,
        subjectId: this.scenario.subjectId,
        deviceId: this.scenario.deviceId,
      };
    }

    return this.finalizeStep({
      frames: looped.frames,
      path: "turn_loop",
      toolInvocations: looped.toolInvocations,
      detail: `turn_loop;tools=${looped.toolInvocations};terminal_pending`,
    });
  }
}
