/**
 * One-operation kill-switch orchestrator for baseline reversion.
 *
 * Reverts every learned component — challenger adapters to champion/base,
 * compaction / routing / healing flags off — in a single audited operator
 * call. In-flight turns finish under their pinned checkpoint before unload;
 * a second invoke is an idempotent advisory no-op.
 *
 * Low-level flag apply lives in governance.ts; this module is the typed
 * operator surface + audit trail. Not a new public package export.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  KILL_SWITCH_COMPONENT_LIMIT,
  KILL_SWITCH_LEARNED_FLAGS,
  SURGERY_COMPONENT_CLASSES,
  applyKillSwitch,
  isKillSwitchBaseline,
  type KillSwitchLearnedFlag,
  type KillSwitchLearnedState,
  type SurgeryComponentClass,
} from "./governance.js";

export const KILL_SWITCH_ORCHESTRATOR_SCHEMA_VERSION =
  "kill-switch.orchestrator.v1" as const;
export const KILL_SWITCH_AUDIT_SCHEMA_VERSION =
  "kill-switch.audit.v1" as const;

export const KILL_SWITCH_ORCHESTRATOR_TIMEOUT_MS = 5_000 as const;
export const KILL_SWITCH_ORCHESTRATOR_TURN_LIMIT = 32 as const;
export const KILL_SWITCH_ORCHESTRATOR_OPERATION_LIMIT = 256 as const;
export const KILL_SWITCH_ORCHESTRATOR_AUDIT_LIMIT = 128 as const;
export const KILL_SWITCH_GOLDEN_TURN_RELPATH =
  "packages/sync-protocol/fixtures/golden-turns" as const;
export const KILL_SWITCH_GOLDEN_TURN_LIMIT = 64 as const;
export const KILL_SWITCH_GOLDEN_FRAME_LIMIT = 64 as const;
export const KILL_SWITCH_GOLDEN_BYTES_LIMIT = 1_048_576 as const;

export const KILL_SWITCH_POLICY_FLAGS = Object.freeze([
  "learned_compaction",
  "learned_routing",
  "learned_healing",
] as const satisfies readonly KillSwitchLearnedFlag[]);

export type KillSwitchOrchestratorFailureClass =
  | "kill_switch.invalid_input"
  | "kill_switch.missing_subject"
  | "kill_switch.cross_subject_denied"
  | "kill_switch.locality_forbidden"
  | "kill_switch.partial"
  | "kill_switch.section_limit"
  | "kill_switch.downstream_timeout"
  | "kill_switch.idempotent_conflict"
  | "kill_switch.in_flight_corruption"
  | "kill_switch.sovereignty"
  | "kill_switch.capacity"
  | "kill_switch.golden_source_missing"
  | "kill_switch.golden_schema_violation"
  | "kill_switch.golden_mismatch"
  | "kill_switch.golden_executor_failed";

export class KillSwitchOrchestratorError extends Error {
  readonly obligation: KillSwitchOrchestratorFailureClass;
  readonly subjectId: string | null | undefined;
  readonly deviceId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: KillSwitchOrchestratorFailureClass;
      subjectId?: string | null;
      deviceId?: string;
    },
  ) {
    super(message);
    this.name = "KillSwitchOrchestratorError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
  }
}

export type KillSwitchTelemetryEvent = {
  event: "learning.kill_switch.orchestrator";
  outcome: "ok" | "rejected" | "advisory" | "idempotent_replay";
  subjectId: string | null;
  deviceId?: string;
  action?:
    | "orchestrate"
    | "drain_inflight"
    | "unload_adapter"
    | "disable_flags"
    | "audit"
    | "golden_load"
    | "golden_replay"
    | "golden_drill";
  failureClass?: KillSwitchOrchestratorFailureClass;
  operationId?: string;
  adapterRevertedTo?: string;
  componentsReverted?: readonly string[];
  drainedTurnCount?: number;
  advisory?: string;
  turnId?: string;
  goldenTurnCount?: number;
  expectedHash?: string;
  actualHash?: string;
};

export type KillSwitchInFlightTurn = {
  turnId: string;
  subjectId: string;
  /** Checkpoint the turn must finish under — never swap mid-turn. */
  pinnedCheckpointId: string;
  status: "running" | "completed_under_checkpoint";
};

export type KillSwitchOperatorSurface = {
  schemaVersion: typeof KILL_SWITCH_ORCHESTRATOR_SCHEMA_VERSION;
  subjectId: string | null;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  /** Champion / baseline adapter id — target after unload. */
  championAdapterId: string;
  /**
   * Active challenger (or champion when already baseline). Unloaded to
   * championAdapterId on a successful orchestrator apply.
   */
  activeAdapterId: string;
  adapterPinned: boolean;
  flags: Record<KillSwitchLearnedFlag, boolean>;
  inFlightTurns: KillSwitchInFlightTurn[];
};

export type KillSwitchAuditRecord = {
  schemaVersion: typeof KILL_SWITCH_AUDIT_SCHEMA_VERSION;
  operationId: string;
  subjectId: string | null;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  completedAt: string;
  outcome: "ok" | "advisory_idempotent";
  componentsReverted: readonly SurgeryComponentClass[];
  flagsDisabled: readonly KillSwitchLearnedFlag[];
  adapterRevertedTo: string;
  drainedTurnIds: readonly string[];
  idempotent: boolean;
  advisory?: string;
};

export type KillSwitchOrchestratorResult = {
  ok: true;
  surface: KillSwitchOperatorSurface;
  audit: KillSwitchAuditRecord;
  idempotent: boolean;
};

const FORBIDDEN_CONTENT_KEY =
  /utterance|promptBody|replyBody|learnerContent|rawContent|secret|weightTensor/i;

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function emit(
  onTelemetry: ((e: KillSwitchTelemetryEvent) => void) | undefined,
  event: KillSwitchTelemetryEvent,
): void {
  onTelemetry?.(event);
}

function assertMetadataOnly(
  value: unknown,
  label: string,
  meta: { subjectId?: string | null; deviceId?: string } = {},
): void {
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_CONTENT_KEY.test(key)) {
      throw new KillSwitchOrchestratorError(
        `${label} forbids raw content field ${key}`,
        {
          obligation: "kill_switch.sovereignty",
          ...(meta.subjectId !== undefined
            ? { subjectId: meta.subjectId }
            : {}),
          ...(meta.deviceId !== undefined ? { deviceId: meta.deviceId } : {}),
        },
      );
    }
  }
}

function scopeKey(subjectId: string | null): string {
  return subjectId === null ? "__fleet__" : subjectId;
}

function toLearnedState(surface: KillSwitchOperatorSurface): KillSwitchLearnedState {
  return {
    flags: { ...surface.flags },
    adapterPinned: surface.adapterPinned,
  };
}

function allFlagsOff(): Record<KillSwitchLearnedFlag, boolean> {
  const flags = {} as Record<KillSwitchLearnedFlag, boolean>;
  for (const flag of KILL_SWITCH_LEARNED_FLAGS) {
    flags[flag] = false;
  }
  return flags;
}

/**
 * Build a learned-on operator surface (challenger pinned, all flags on).
 * Used by drills and operator staging before a kill-switch fire.
 */
export function createLearnedOnKillSwitchSurface(input: {
  subjectId: string | null;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  championAdapterId: string;
  challengerAdapterId: string;
  inFlightTurns?: readonly KillSwitchInFlightTurn[];
}): KillSwitchOperatorSurface {
  if (
    !ID_RE.test(input.deviceId) ||
    !ID_RE.test(input.championAdapterId) ||
    !ID_RE.test(input.challengerAdapterId)
  ) {
    throw new KillSwitchOrchestratorError("device/adapter ids must be stable", {
      obligation: "kill_switch.invalid_input",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
    });
  }
  if (
    input.subjectId !== null &&
    (typeof input.subjectId !== "string" || !ID_RE.test(input.subjectId))
  ) {
    throw new KillSwitchOrchestratorError(
      "subject-bound kill-switch requires a stable subjectId",
      {
        obligation: "kill_switch.missing_subject",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }
  if (input.locality !== "on-device" && input.locality !== "self-hosted") {
    throw new KillSwitchOrchestratorError("invalid locality", {
      obligation: "kill_switch.locality_forbidden",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
    });
  }
  const turns = [...(input.inFlightTurns ?? [])];
  if (turns.length > KILL_SWITCH_ORCHESTRATOR_TURN_LIMIT) {
    throw new KillSwitchOrchestratorError(
      `in-flight turns exceed ${KILL_SWITCH_ORCHESTRATOR_TURN_LIMIT}`,
      {
        obligation: "kill_switch.section_limit",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }
  for (const turn of turns) {
    assertMetadataOnly(turn, `in-flight turn ${turn.turnId}`, {
      subjectId: input.subjectId,
      deviceId: input.deviceId,
    });
    if (input.subjectId !== null && turn.subjectId !== input.subjectId) {
      throw new KillSwitchOrchestratorError(
        "in-flight turn subjectId must match surface subjectId",
        {
          obligation: "kill_switch.cross_subject_denied",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }
  }
  const flags = {} as Record<KillSwitchLearnedFlag, boolean>;
  for (const flag of KILL_SWITCH_LEARNED_FLAGS) {
    flags[flag] = true;
  }
  return {
    schemaVersion: KILL_SWITCH_ORCHESTRATOR_SCHEMA_VERSION,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    locality: input.locality,
    championAdapterId: input.championAdapterId,
    activeAdapterId: input.challengerAdapterId,
    adapterPinned: true,
    flags,
    inFlightTurns: turns.map((turn) => ({ ...turn, status: "running" as const })),
  };
}

/** True when adapter is at champion and every learned flag is off. */
export function isKillSwitchOrchestratorBaseline(
  surface: KillSwitchOperatorSurface,
): boolean {
  if (surface.activeAdapterId !== surface.championAdapterId) return false;
  if (surface.adapterPinned) return false;
  return isKillSwitchBaseline(toLearnedState(surface));
}

export type KillSwitchOrchestratorStore = {
  get(subjectId: string | null): KillSwitchOperatorSurface | undefined;
  set(subjectId: string | null, surface: KillSwitchOperatorSurface): void;
};

/** Bounded in-memory store for subject-scoped operator surfaces (tests + local ops). */
export function createKillSwitchOrchestratorStore(
  initial?: readonly KillSwitchOperatorSurface[],
): KillSwitchOrchestratorStore {
  const map = new Map<string, KillSwitchOperatorSurface>();
  if (initial !== undefined) {
    if (initial.length > KILL_SWITCH_ORCHESTRATOR_OPERATION_LIMIT) {
      throw new KillSwitchOrchestratorError(
        "orchestrator store capacity exceeded",
        { obligation: "kill_switch.capacity" },
      );
    }
    for (const surface of initial) {
      map.set(scopeKey(surface.subjectId), structuredClone(surface));
    }
  }
  return {
    get(subjectId) {
      const hit = map.get(scopeKey(subjectId));
      return hit === undefined ? undefined : structuredClone(hit);
    },
    set(subjectId, surface) {
      if (
        map.size >= KILL_SWITCH_ORCHESTRATOR_OPERATION_LIMIT &&
        !map.has(scopeKey(subjectId))
      ) {
        throw new KillSwitchOrchestratorError(
          "orchestrator store capacity exceeded",
          {
            obligation: "kill_switch.capacity",
            subjectId,
            deviceId: surface.deviceId,
          },
        );
      }
      map.set(scopeKey(subjectId), structuredClone(surface));
    },
  };
}

const operationReceipts = new Map<string, KillSwitchAuditRecord>();
const subjectLocks = new Set<string>();

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  meta: { subjectId: string | null; deviceId: string },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = Promise.resolve(promise).then(
    (value) => ({ kind: "ok" as const, value }),
    (error: unknown) => ({ kind: "err" as const, error }),
  );
  try {
    const raced = await Promise.race([
      guarded,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    if (raced.kind === "timeout") {
      throw new KillSwitchOrchestratorError(
        `kill-switch timed out after ${timeoutMs}ms (${label})`,
        {
          obligation: "kill_switch.downstream_timeout",
          subjectId: meta.subjectId,
          deviceId: meta.deviceId,
        },
      );
    }
    if (raced.kind === "err") {
      if (raced.error instanceof KillSwitchOrchestratorError) throw raced.error;
      throw new KillSwitchOrchestratorError(
        `kill-switch drain failed: ${
          raced.error instanceof Error ? raced.error.message : "unknown"
        }`,
        {
          obligation: "kill_switch.in_flight_corruption",
          subjectId: meta.subjectId,
          deviceId: meta.deviceId,
        },
      );
    }
    return raced.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Drain in-flight turns under their pinned checkpoints — never unload the
 * challenger mid-turn. Returns drained turn ids in stable order.
 */
async function drainInFlightTurns(input: {
  surface: KillSwitchOperatorSurface;
  timeoutMs: number;
  drainTurn?: (turn: KillSwitchInFlightTurn) => Promise<void>;
  onTelemetry?: (e: KillSwitchTelemetryEvent) => void;
}): Promise<{ surface: KillSwitchOperatorSurface; drainedTurnIds: string[] }> {
  const drainedTurnIds: string[] = [];
  const nextTurns: KillSwitchInFlightTurn[] = [];

  for (const turn of input.surface.inFlightTurns) {
    if (turn.status === "completed_under_checkpoint") {
      nextTurns.push(turn);
      continue;
    }
    // Capture checkpoint pin before any adapter unload.
    const pinnedCheckpointId = turn.pinnedCheckpointId;
    emit(input.onTelemetry, {
      event: "learning.kill_switch.orchestrator",
      outcome: "ok",
      subjectId: input.surface.subjectId,
      deviceId: input.surface.deviceId,
      action: "drain_inflight",
      drainedTurnCount: 1,
    });

    if (input.drainTurn !== undefined) {
      await withTimeout(
        input.drainTurn(turn),
        input.timeoutMs,
        `drain turn=${turn.turnId}`,
        {
          subjectId: input.surface.subjectId,
          deviceId: input.surface.deviceId,
        },
      );
    }

    // Mid-turn corruption guard: checkpoint must still match the pin.
    if (turn.pinnedCheckpointId !== pinnedCheckpointId) {
      throw new KillSwitchOrchestratorError(
        `in-flight turn ${turn.turnId} lost pinned checkpoint during drain`,
        {
          obligation: "kill_switch.in_flight_corruption",
          subjectId: input.surface.subjectId,
          deviceId: input.surface.deviceId,
        },
      );
    }

    nextTurns.push({
      ...turn,
      status: "completed_under_checkpoint",
    });
    drainedTurnIds.push(turn.turnId);
  }

  return {
    surface: {
      ...input.surface,
      inFlightTurns: nextTurns,
    },
    drainedTurnIds: [...drainedTurnIds].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * One-operation kill-switch orchestrator for operators.
 *
 * 1. Serialize per subjectId (or fleet scope).
 * 2. Drain in-flight turns under pinned checkpoints.
 * 3. Unload challenger adapter → champion/base.
 * 4. Disable every learned flag (compaction, routing, healing, …).
 * 5. Persist an audit record; second invoke is an advisory no-op.
 */
export async function runKillSwitchOrchestrator(input: {
  operationId: string;
  store: KillSwitchOrchestratorStore;
  subjectId: string | null;
  deviceId: string;
  locality?: "on-device" | "self-hosted";
  timeoutMs?: number;
  now?: () => string;
  /** Test/edge only: leave named flags on → partial failure. */
  leaveOnFlags?: readonly KillSwitchLearnedFlag[];
  /** Optional async drain hook (may time out). */
  drainTurn?: (turn: KillSwitchInFlightTurn) => Promise<void>;
  onTelemetry?: (e: KillSwitchTelemetryEvent) => void;
}): Promise<KillSwitchOrchestratorResult> {
  if (!ID_RE.test(input.operationId) || !ID_RE.test(input.deviceId)) {
    throw new KillSwitchOrchestratorError(
      "operationId and deviceId must be stable ids",
      {
        obligation: "kill_switch.invalid_input",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }
  if (
    input.subjectId !== null &&
    (typeof input.subjectId !== "string" || !ID_RE.test(input.subjectId))
  ) {
    throw new KillSwitchOrchestratorError(
      "subject-bound kill-switch requires a stable subjectId",
      {
        obligation: "kill_switch.missing_subject",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }
  if (
    input.leaveOnFlags !== undefined &&
    input.leaveOnFlags.length > KILL_SWITCH_COMPONENT_LIMIT
  ) {
    throw new KillSwitchOrchestratorError(
      `leaveOnFlags exceed ${KILL_SWITCH_COMPONENT_LIMIT}`,
      {
        obligation: "kill_switch.section_limit",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }

  const receiptKey = [
    input.operationId,
    scopeKey(input.subjectId),
    input.deviceId,
  ].join("|");
  const prior = operationReceipts.get(receiptKey);
  if (prior !== undefined) {
    const surface = input.store.get(input.subjectId);
    if (surface === undefined || !isKillSwitchOrchestratorBaseline(surface)) {
      throw new KillSwitchOrchestratorError(
        "kill-switch operation idempotency conflict",
        {
          obligation: "kill_switch.idempotent_conflict",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }
    emit(input.onTelemetry, {
      event: "learning.kill_switch.orchestrator",
      outcome: "idempotent_replay",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "orchestrate",
      operationId: input.operationId,
      ...(prior.advisory !== undefined ? { advisory: prior.advisory } : {}),
    });
    return {
      ok: true,
      surface,
      audit: prior,
      idempotent: true,
    };
  }

  const lockKey = scopeKey(input.subjectId);
  if (subjectLocks.has(lockKey)) {
    throw new KillSwitchOrchestratorError(
      "concurrent kill-switch for the same subjectId is forbidden",
      {
        obligation: "kill_switch.idempotent_conflict",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }

  const existing = input.store.get(input.subjectId);
  if (existing === undefined) {
    throw new KillSwitchOrchestratorError(
      "no kill-switch surface registered for subject scope",
      {
        obligation: "kill_switch.invalid_input",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }
  assertMetadataOnly(existing, "kill-switch surface", {
    subjectId: input.subjectId,
    deviceId: input.deviceId,
  });

  if (existing.subjectId !== input.subjectId) {
    throw new KillSwitchOrchestratorError(
      "store surface subjectId does not match orchestrator subjectId",
      {
        obligation: "kill_switch.cross_subject_denied",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }
  if (existing.deviceId !== input.deviceId) {
    throw new KillSwitchOrchestratorError(
      "deviceId must match the registered surface",
      {
        obligation: "kill_switch.invalid_input",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }
  if (
    input.locality !== undefined &&
    existing.locality !== input.locality
  ) {
    throw new KillSwitchOrchestratorError("locality mismatch", {
      obligation: "kill_switch.locality_forbidden",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
    });
  }

  // Already baseline → advisory no-op (idempotent).
  if (isKillSwitchOrchestratorBaseline(existing)) {
    const completedAt = (input.now ?? (() => new Date().toISOString()))();
    const advisory =
      "kill-switch already at deterministic baseline — no-op advisory";
    const audit: KillSwitchAuditRecord = {
      schemaVersion: KILL_SWITCH_AUDIT_SCHEMA_VERSION,
      operationId: input.operationId,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      locality: existing.locality,
      completedAt,
      outcome: "advisory_idempotent",
      componentsReverted: [...SURGERY_COMPONENT_CLASSES],
      flagsDisabled: [...KILL_SWITCH_LEARNED_FLAGS],
      adapterRevertedTo: existing.championAdapterId,
      drainedTurnIds: [],
      idempotent: true,
      advisory,
    };
    if (operationReceipts.size >= KILL_SWITCH_ORCHESTRATOR_AUDIT_LIMIT) {
      throw new KillSwitchOrchestratorError(
        "kill-switch audit capacity exceeded",
        {
          obligation: "kill_switch.capacity",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }
    operationReceipts.set(receiptKey, audit);
    emit(input.onTelemetry, {
      event: "learning.kill_switch.orchestrator",
      outcome: "advisory",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "orchestrate",
      operationId: input.operationId,
      advisory,
      adapterRevertedTo: existing.championAdapterId,
    });
    return {
      ok: true,
      surface: existing,
      audit,
      idempotent: true,
    };
  }

  subjectLocks.add(lockKey);
  try {
    const timeoutMs = input.timeoutMs ?? KILL_SWITCH_ORCHESTRATOR_TIMEOUT_MS;
    const completedAt = (input.now ?? (() => new Date().toISOString()))();

    emit(input.onTelemetry, {
      event: "learning.kill_switch.orchestrator",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "orchestrate",
      operationId: input.operationId,
    });

    // Durable side-effect boundary: drain first, then unload + flags.
    const drained = await drainInFlightTurns({
      surface: existing,
      timeoutMs,
      ...(input.drainTurn !== undefined ? { drainTurn: input.drainTurn } : {}),
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    });

    // Revert adapter to champion/base AFTER drain — never mid-turn.
    emit(input.onTelemetry, {
      event: "learning.kill_switch.orchestrator",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "unload_adapter",
      operationId: input.operationId,
      adapterRevertedTo: drained.surface.championAdapterId,
    });

    const flagApply = applyKillSwitch(toLearnedState(drained.surface), {
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      ...(input.leaveOnFlags !== undefined
        ? { leaveOnFlags: input.leaveOnFlags }
        : {}),
    });

    if (!flagApply.ok) {
      // Partial durable state: drain may have completed — surface still names
      // remaining-on flags; never silent continue.
      const partialSurface: KillSwitchOperatorSurface = {
        ...drained.surface,
        flags: flagApply.state.flags,
        adapterPinned: flagApply.state.adapterPinned,
        // Adapter unload withheld on partial — constitution violation named.
        activeAdapterId: drained.surface.activeAdapterId,
      };
      input.store.set(input.subjectId, partialSurface);
      emit(input.onTelemetry, {
        event: "learning.kill_switch.orchestrator",
        outcome: "rejected",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        action: "disable_flags",
        operationId: input.operationId,
        failureClass: "kill_switch.partial",
        componentsReverted: flagApply.remainingOn,
      });
      throw new KillSwitchOrchestratorError(flagApply.detail, {
        obligation: "kill_switch.partial",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      });
    }

    emit(input.onTelemetry, {
      event: "learning.kill_switch.orchestrator",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "disable_flags",
      operationId: input.operationId,
      componentsReverted: flagApply.componentsReverted,
    });

    const nextSurface: KillSwitchOperatorSurface = {
      ...drained.surface,
      flags: allFlagsOff(),
      adapterPinned: false,
      activeAdapterId: drained.surface.championAdapterId,
      inFlightTurns: drained.surface.inFlightTurns,
    };

    if (!isKillSwitchOrchestratorBaseline(nextSurface)) {
      throw new KillSwitchOrchestratorError(
        "kill-switch incomplete after orchestrator apply",
        {
          obligation: "kill_switch.partial",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }

    // Receipt precedes store write so a crashed callback still replays.
    const audit: KillSwitchAuditRecord = {
      schemaVersion: KILL_SWITCH_AUDIT_SCHEMA_VERSION,
      operationId: input.operationId,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      locality: nextSurface.locality,
      completedAt,
      outcome: "ok",
      componentsReverted: [...SURGERY_COMPONENT_CLASSES],
      flagsDisabled: [...KILL_SWITCH_LEARNED_FLAGS],
      adapterRevertedTo: nextSurface.championAdapterId,
      drainedTurnIds: drained.drainedTurnIds,
      idempotent: false,
    };
    assertMetadataOnly(audit, "kill-switch audit", {
      subjectId: input.subjectId,
      deviceId: input.deviceId,
    });
    if (operationReceipts.size >= KILL_SWITCH_ORCHESTRATOR_AUDIT_LIMIT) {
      throw new KillSwitchOrchestratorError(
        "kill-switch audit capacity exceeded",
        {
          obligation: "kill_switch.capacity",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }
    operationReceipts.set(receiptKey, audit);
    input.store.set(input.subjectId, nextSurface);

    emit(input.onTelemetry, {
      event: "learning.kill_switch.orchestrator",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "audit",
      operationId: input.operationId,
      adapterRevertedTo: audit.adapterRevertedTo,
      componentsReverted: audit.componentsReverted,
      drainedTurnCount: audit.drainedTurnIds.length,
    });

    return {
      ok: true,
      surface: nextSurface,
      audit,
      idempotent: false,
    };
  } finally {
    subjectLocks.delete(lockKey);
  }
}

export type KillSwitchGoldenTurnFixture = {
  id: string;
  subjectId: string;
  deviceId: string;
  correlationId: string;
  input: readonly string[];
  expectedFrames: readonly unknown[];
  coverage: readonly string[];
};

export type KillSwitchGoldenReplayOutput =
  | string
  | readonly unknown[]
  | {
      ok: boolean;
      canonicalJson?: string;
      failureClass?: string;
    };

export type KillSwitchGoldenTurnExecutor = (
  fixture: KillSwitchGoldenTurnFixture,
  baselineSurface: KillSwitchOperatorSurface,
) => KillSwitchGoldenReplayOutput | Promise<KillSwitchGoldenReplayOutput>;

export type KillSwitchGoldenTurnProof = {
  turnId: string;
  expectedHash: string;
  actualHash: string;
  byteMatch: true;
};

export type KillSwitchGoldenRestorationReport = {
  ok: true;
  operationId: string;
  subjectId: string | null;
  deviceId: string;
  killSwitchAudit: KillSwitchAuditRecord;
  goldenTurnCount: number;
  byteMatch: true;
  proofs: readonly KillSwitchGoldenTurnProof[];
};

type KillSwitchGoldenManifest = {
  version: string;
  turns: Array<{ id: string; file: string }>;
};

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep(
        (value as Record<string, unknown>)[key],
      );
    }
    return sorted;
  }
  return value;
}

/** Canonical frame bytes used by the protocol/runtime golden replay contract. */
export function canonicalizeKillSwitchGoldenFrames(frames: unknown): string {
  return `${JSON.stringify(sortKeysDeep(frames), null, 2)}\n`;
}

function isGoldenFixture(value: unknown): value is KillSwitchGoldenTurnFixture {
  if (value === null || typeof value !== "object") return false;
  const fixture = value as Record<string, unknown>;
  return (
    typeof fixture.id === "string" &&
    ID_RE.test(fixture.id) &&
    typeof fixture.subjectId === "string" &&
    ID_RE.test(fixture.subjectId) &&
    typeof fixture.deviceId === "string" &&
    ID_RE.test(fixture.deviceId) &&
    typeof fixture.correlationId === "string" &&
    ID_RE.test(fixture.correlationId) &&
    Array.isArray(fixture.input) &&
    fixture.input.length > 0 &&
    fixture.input.length <= KILL_SWITCH_GOLDEN_FRAME_LIMIT &&
    fixture.input.every((chunk) => typeof chunk === "string") &&
    Array.isArray(fixture.expectedFrames) &&
    fixture.expectedFrames.length > 0 &&
    fixture.expectedFrames.length <= KILL_SWITCH_GOLDEN_FRAME_LIMIT &&
    Array.isArray(fixture.coverage) &&
    fixture.coverage.every((item) => typeof item === "string")
  );
}

async function loadKillSwitchGoldenTurns(input: {
  repoRoot: string;
  subjectId: string | null;
  deviceId: string;
  onTelemetry?: (e: KillSwitchTelemetryEvent) => void;
}): Promise<KillSwitchGoldenTurnFixture[]> {
  const root = path.resolve(input.repoRoot);
  const fixtureDir = path.resolve(root, KILL_SWITCH_GOLDEN_TURN_RELPATH);
  if (
    fixtureDir !== root &&
    !fixtureDir.startsWith(`${root}${path.sep}`)
  ) {
    throw new KillSwitchOrchestratorError(
      "golden fixture path escapes repo root",
      {
        obligation: "kill_switch.golden_schema_violation",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }

  let manifestText: string;
  try {
    manifestText = await readFile(path.join(fixtureDir, "manifest.json"), "utf8");
  } catch {
    emit(input.onTelemetry, {
      event: "learning.kill_switch.orchestrator",
      outcome: "rejected",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "golden_load",
      failureClass: "kill_switch.golden_source_missing",
    });
    throw new KillSwitchOrchestratorError(
      `golden manifest missing under ${KILL_SWITCH_GOLDEN_TURN_RELPATH}`,
      {
        obligation: "kill_switch.golden_source_missing",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }

  let manifest: KillSwitchGoldenManifest;
  try {
    manifest = JSON.parse(manifestText) as KillSwitchGoldenManifest;
  } catch {
    throw new KillSwitchOrchestratorError("golden manifest is not JSON", {
      obligation: "kill_switch.golden_schema_violation",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
    });
  }
  if (
    typeof manifest.version !== "string" ||
    !Array.isArray(manifest.turns) ||
    manifest.turns.length < 1 ||
    manifest.turns.length > KILL_SWITCH_GOLDEN_TURN_LIMIT
  ) {
    throw new KillSwitchOrchestratorError(
      "golden manifest violates bounded corpus schema",
      {
        obligation: "kill_switch.golden_schema_violation",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }

  const fixtures: KillSwitchGoldenTurnFixture[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.turns) {
    if (
      typeof entry?.id !== "string" ||
      !ID_RE.test(entry.id) ||
      typeof entry.file !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/.test(entry.file) ||
      seen.has(entry.id)
    ) {
      throw new KillSwitchOrchestratorError(
        "golden manifest contains invalid or duplicate entry",
        {
          obligation: "kill_switch.golden_schema_violation",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }
    seen.add(entry.id);

    let fixtureText: string;
    try {
      fixtureText = await readFile(path.join(fixtureDir, entry.file), "utf8");
    } catch {
      throw new KillSwitchOrchestratorError(
        `golden fixture missing: ${entry.file}`,
        {
          obligation: "kill_switch.golden_source_missing",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }
    if (Buffer.byteLength(fixtureText, "utf8") > KILL_SWITCH_GOLDEN_BYTES_LIMIT) {
      throw new KillSwitchOrchestratorError(
        `golden fixture exceeds ${KILL_SWITCH_GOLDEN_BYTES_LIMIT} bytes`,
        {
          obligation: "kill_switch.section_limit",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }

    let fixture: unknown;
    try {
      fixture = JSON.parse(fixtureText) as unknown;
    } catch {
      throw new KillSwitchOrchestratorError(
        `golden fixture is not JSON: ${entry.id}`,
        {
          obligation: "kill_switch.golden_schema_violation",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }
    if (!isGoldenFixture(fixture) || fixture.id !== entry.id) {
      throw new KillSwitchOrchestratorError(
        `golden fixture schema/id mismatch: ${entry.id}`,
        {
          obligation: "kill_switch.golden_schema_violation",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }
    if (
      input.subjectId !== null &&
      fixture.subjectId !== input.subjectId
    ) {
      throw new KillSwitchOrchestratorError(
        `golden fixture ${entry.id} crosses subject scope`,
        {
          obligation: "kill_switch.cross_subject_denied",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }
    fixtures.push(fixture);
  }

  emit(input.onTelemetry, {
    event: "learning.kill_switch.orchestrator",
    outcome: "ok",
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    action: "golden_load",
    goldenTurnCount: fixtures.length,
  });
  return fixtures;
}

async function executeGoldenTurn(input: {
  fixture: KillSwitchGoldenTurnFixture;
  surface: KillSwitchOperatorSurface;
  executor: KillSwitchGoldenTurnExecutor;
  timeoutMs: number;
}): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = Promise.resolve()
    .then(() =>
      input.executor(
        structuredClone(input.fixture),
        structuredClone(input.surface),
      ),
    )
    .then(
      (value) => ({ kind: "ok" as const, value }),
      (error: unknown) => ({ kind: "err" as const, error }),
    );
  try {
    const raced = await Promise.race([
      guarded,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), input.timeoutMs);
      }),
    ]);
    if (raced.kind === "timeout") {
      throw new KillSwitchOrchestratorError(
        `golden replay timed out after ${input.timeoutMs}ms`,
        {
          obligation: "kill_switch.downstream_timeout",
          subjectId: input.surface.subjectId,
          deviceId: input.surface.deviceId,
        },
      );
    }
    if (raced.kind === "err") {
      throw new KillSwitchOrchestratorError(
        `golden executor failed: ${
          raced.error instanceof Error ? raced.error.message : "unknown"
        }`,
        {
          obligation: "kill_switch.golden_executor_failed",
          subjectId: input.surface.subjectId,
          deviceId: input.surface.deviceId,
        },
      );
    }
    const output = raced.value;
    let canonicalJson: string;
    if (typeof output === "string") {
      canonicalJson = output;
    } else if (Array.isArray(output)) {
      canonicalJson = canonicalizeKillSwitchGoldenFrames(output);
    } else if (
      output !== null &&
      typeof output === "object" &&
      "ok" in output
    ) {
      const result = output as {
        ok: boolean;
        canonicalJson?: string;
        failureClass?: string;
      };
      if (!result.ok || typeof result.canonicalJson !== "string") {
        throw new KillSwitchOrchestratorError(
          `golden executor rejected: ${result.failureClass ?? "unknown"}`,
          {
            obligation: "kill_switch.golden_executor_failed",
            subjectId: input.surface.subjectId,
            deviceId: input.surface.deviceId,
          },
        );
      }
      canonicalJson = result.canonicalJson;
    } else {
      throw new KillSwitchOrchestratorError(
        "golden executor returned an invalid result",
        {
          obligation: "kill_switch.golden_executor_failed",
          subjectId: input.surface.subjectId,
          deviceId: input.surface.deviceId,
        },
      );
    }
    if (
      Buffer.byteLength(canonicalJson, "utf8") >
      KILL_SWITCH_GOLDEN_BYTES_LIMIT
    ) {
      throw new KillSwitchOrchestratorError(
        "golden executor output exceeds byte budget",
        {
          obligation: "kill_switch.section_limit",
          subjectId: input.surface.subjectId,
          deviceId: input.surface.deviceId,
        },
      );
    }
    return canonicalJson;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Drill learned-on → kill-switch → production-path golden replay.
 *
 * The executor is injected to preserve dependency direction: the runtime
 * harness depends on learning, so learning cannot import the harness. Operators
 * pass its replayGoldenTurn implementation; this contract loads the committed
 * protocol corpus and enforces byte-identical output after reversion.
 */
export async function runKillSwitchGoldenRestorationDrill(input: {
  repoRoot: string;
  operationId: string;
  store: KillSwitchOrchestratorStore;
  subjectId: string | null;
  deviceId: string;
  executor: KillSwitchGoldenTurnExecutor;
  timeoutMs?: number;
  now?: () => string;
  onTelemetry?: (e: KillSwitchTelemetryEvent) => void;
}): Promise<KillSwitchGoldenRestorationReport> {
  const before = input.store.get(input.subjectId);
  if (before === undefined || isKillSwitchOrchestratorBaseline(before)) {
    throw new KillSwitchOrchestratorError(
      "golden drill must start with learned components enabled",
      {
        obligation: "kill_switch.invalid_input",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }

  const fixtures = await loadKillSwitchGoldenTurns({
    repoRoot: input.repoRoot,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  const reverted = await runKillSwitchOrchestrator({
    operationId: input.operationId,
    store: input.store,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (!isKillSwitchOrchestratorBaseline(reverted.surface)) {
    throw new KillSwitchOrchestratorError(
      "golden replay forbidden before complete baseline reversion",
      {
        obligation: "kill_switch.partial",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }

  const timeoutMs = input.timeoutMs ?? KILL_SWITCH_ORCHESTRATOR_TIMEOUT_MS;
  const proofs: KillSwitchGoldenTurnProof[] = [];
  for (const fixture of fixtures) {
    const expected = canonicalizeKillSwitchGoldenFrames(fixture.expectedFrames);
    const actual = await executeGoldenTurn({
      fixture,
      surface: reverted.surface,
      executor: input.executor,
      timeoutMs,
    });
    const expectedHash = sha256(expected);
    const actualHash = sha256(actual);
    if (actual !== expected) {
      emit(input.onTelemetry, {
        event: "learning.kill_switch.orchestrator",
        outcome: "rejected",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        action: "golden_replay",
        operationId: input.operationId,
        turnId: fixture.id,
        expectedHash,
        actualHash,
        failureClass: "kill_switch.golden_mismatch",
      });
      throw new KillSwitchOrchestratorError(
        `post-reversion golden mismatch: ${fixture.id}`,
        {
          obligation: "kill_switch.golden_mismatch",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }
    proofs.push({
      turnId: fixture.id,
      expectedHash,
      actualHash,
      byteMatch: true,
    });
    emit(input.onTelemetry, {
      event: "learning.kill_switch.orchestrator",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "golden_replay",
      operationId: input.operationId,
      turnId: fixture.id,
      expectedHash,
      actualHash,
    });
  }

  emit(input.onTelemetry, {
    event: "learning.kill_switch.orchestrator",
    outcome: "ok",
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    action: "golden_drill",
    operationId: input.operationId,
    goldenTurnCount: proofs.length,
  });
  return {
    ok: true,
    operationId: input.operationId,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    killSwitchAudit: reverted.audit,
    goldenTurnCount: proofs.length,
    byteMatch: true,
    proofs: Object.freeze(proofs),
  };
}

/** Clear orchestrator receipts + locks (tests only). */
export function resetKillSwitchOrchestratorReceipts(): void {
  operationReceipts.clear();
  subjectLocks.clear();
}

export { KILL_SWITCH_LEARNED_FLAGS };
