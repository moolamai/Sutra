/**
 * Per-rollout snapshot isolation — fleet allocates one store instance per episode.
 * Rollout n cannot read or write rollout m; subjectId scoping preserved.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  deepCloneValue,
} from "./deep_clone.js";
import {
  InMemorySnapshotStore,
  type InMemorySnapshotStoreOptions,
} from "./memory_repository.js";
import type {
  CloneAtResetInput,
  CloneAtResetResult,
  DiscardSnapshotInput,
  DiscardSnapshotResult,
  GetSnapshotInput,
  GetSnapshotResult,
  PutSnapshotInput,
  PutSnapshotResult,
  SnapshotStoreRepository,
  SnapshotTelemetry,
  TeardownAtTerminalInput,
  TeardownAtTerminalResult,
} from "./types.js";
import { runTeardownAtTerminal } from "./discard_teardown.js";

/** Soft cap on concurrent allocated rollout stores (NFR). */
export const SNAPSHOT_FLEET_ROLLOUT_LIMIT = 256;

function emit(
  onTelemetry: ((e: SnapshotTelemetry) => void) | undefined,
  e: Omit<SnapshotTelemetry, "event">,
): void {
  onTelemetry?.({ event: "learning.snapshot_store", ...e });
}

function newRolloutId(): string {
  const entropy = randomBytes(8).toString("hex");
  const digest = createHash("sha256")
    .update(`rollout\n${entropy}\n${Date.now()}\n`)
    .digest("hex")
    .slice(0, 16);
  return `roll.${digest}`;
}

/**
 * Store bound to a single rollout / episode after first cloneAtReset.
 * Cross-episode or foreign-rollout access is a defect (`cross_rollout`).
 */
export class IsolatedRolloutSnapshotStore implements SnapshotStoreRepository {
  readonly backendId = "memory" as const;
  readonly rolloutId: string;
  private boundEpisodeId: string | null = null;
  private boundSubjectId: string | null = null;
  private readonly inner: InMemorySnapshotStore;
  /** Sync mutex — concurrent same-subject RMW is rejected, not interleaved. */
  private readonly subjectLocks = new Map<string, boolean>();

  constructor(
    options: InMemorySnapshotStoreOptions & { rolloutId?: string } = {},
  ) {
    this.rolloutId = options.rolloutId?.trim() || newRolloutId();
    this.inner = new InMemorySnapshotStore({
      ...(options.durableDir !== undefined
        ? { durableDir: options.durableDir }
        : {}),
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
  }

  private withSubjectLock<T extends { ok: boolean; failureClass?: string }>(
    subjectId: string,
    deviceId: string,
    onTelemetry: ((e: SnapshotTelemetry) => void) | undefined,
    op: "clone" | "get" | "put" | "discard" | "teardown",
    episodeId: string,
    fn: () => T,
  ): T {
    if (this.subjectLocks.get(subjectId)) {
      emit(onTelemetry, {
        op,
        outcome: "error",
        subjectId,
        deviceId,
        episodeId,
        rolloutId: this.rolloutId,
        failureClass: "concurrent_subject",
        detail: "concurrent same-subject snapshot RMW rejected",
        backend: this.backendId,
      });
      return {
        ok: false,
        failureClass: "concurrent_subject",
        detail: "concurrent same-subject snapshot RMW rejected",
        subjectId,
        deviceId,
      } as unknown as T;
    }
    this.subjectLocks.set(subjectId, true);
    try {
      return fn();
    } finally {
      this.subjectLocks.set(subjectId, false);
    }
  }

  private assertBound(
    subjectId: string,
    episodeId: string,
    deviceId: string,
    onTelemetry: ((e: SnapshotTelemetry) => void) | undefined,
    op: "clone" | "get" | "put" | "discard" | "teardown",
  ):
    | { ok: true }
    | {
        ok: false;
        failureClass: "cross_rollout" | "cross_subject";
        detail: string;
        subjectId: string;
        deviceId: string;
      } {
    if (this.boundEpisodeId === null) {
      return { ok: true };
    }
    if (this.boundSubjectId !== null && subjectId !== this.boundSubjectId) {
      emit(onTelemetry, {
        op,
        outcome: "error",
        subjectId,
        deviceId,
        episodeId,
        rolloutId: this.rolloutId,
        failureClass: "cross_subject",
        detail: "rollout store subjectId diverged from bind",
        backend: this.backendId,
      });
      return {
        ok: false,
        failureClass: "cross_subject",
        detail: "rollout store subjectId diverged from bind",
        subjectId,
        deviceId,
      };
    }
    if (episodeId !== this.boundEpisodeId) {
      emit(onTelemetry, {
        op,
        outcome: "error",
        subjectId,
        deviceId,
        episodeId,
        rolloutId: this.rolloutId,
        failureClass: "cross_rollout",
        detail: `rollout ${this.rolloutId} cannot access episode ${episodeId}`,
        backend: this.backendId,
      });
      return {
        ok: false,
        failureClass: "cross_rollout",
        detail: `rollout ${this.rolloutId} cannot access episode ${episodeId}`,
        subjectId,
        deviceId,
      };
    }
    return { ok: true };
  }

  cloneAtReset(input: CloneAtResetInput): CloneAtResetResult {
    const subjectId = input.subjectId.trim();
    const deviceId = input.deviceId.trim();
    const episodeId = input.episodeId.trim();

    return this.withSubjectLock(
      subjectId || "__missing__",
      deviceId,
      input.onTelemetry,
      "clone",
      episodeId,
      () => {
        if (!subjectId) {
          return this.inner.cloneAtReset(input);
        }

        const gate = this.assertBound(
          subjectId,
          episodeId,
          deviceId,
          input.onTelemetry,
          "clone",
        );
        if (!gate.ok) return gate;

        // Idempotent: same episode re-clone returns stored snapshot (no double-apply).
        if (
          this.boundEpisodeId === episodeId &&
          this.boundSubjectId === subjectId
        ) {
          const existing = this.inner.get({
            subjectId,
            deviceId,
            episodeId,
          });
          if (existing.ok) {
            emit(input.onTelemetry, {
              op: "clone",
              outcome: "ok",
              subjectId,
              deviceId,
              episodeId,
              rolloutId: this.rolloutId,
              backend: this.backendId,
              detail: "idempotent cloneAtReset for bound episode",
            });
            return {
              ok: true,
              snapshot: deepCloneValue(existing.snapshot),
              backend: this.backendId,
            };
          }
        }

        const cloned = this.inner.cloneAtReset(input);
        if (cloned.ok) {
          this.boundEpisodeId = episodeId;
          this.boundSubjectId = subjectId;
          emit(input.onTelemetry, {
            op: "clone",
            outcome: "ok",
            subjectId,
            deviceId,
            episodeId,
            rolloutId: this.rolloutId,
            backend: this.backendId,
            detail: "rollout store bound at cloneAtReset",
          });
        }
        return cloned;
      },
    );
  }

  get(input: GetSnapshotInput): GetSnapshotResult {
    const subjectId = input.subjectId.trim();
    const deviceId = input.deviceId.trim();
    const episodeId = input.episodeId.trim();
    if (!subjectId) {
      return this.inner.get(input);
    }
    const gate = this.assertBound(
      subjectId,
      episodeId,
      deviceId,
      input.onTelemetry,
      "get",
    );
    if (!gate.ok) return gate;
    return this.inner.get(input);
  }

  put(input: PutSnapshotInput): PutSnapshotResult {
    const subjectId = input.subjectId.trim();
    const deviceId = input.deviceId.trim();
    const episodeId = input.episodeId.trim();

    return this.withSubjectLock(
      subjectId || "__missing__",
      deviceId,
      input.onTelemetry,
      "put",
      episodeId,
      () => {
        if (!subjectId) {
          return this.inner.put(input);
        }
        const gate = this.assertBound(
          subjectId,
          episodeId,
          deviceId,
          input.onTelemetry,
          "put",
        );
        if (!gate.ok) return gate;
        return this.inner.put(input);
      },
    );
  }

  discard(input: DiscardSnapshotInput): DiscardSnapshotResult {
    const subjectId = input.subjectId.trim();
    const deviceId = input.deviceId.trim();
    const episodeId = input.episodeId.trim();

    return this.withSubjectLock(
      subjectId || "__missing__",
      deviceId,
      input.onTelemetry,
      "discard",
      episodeId,
      () => {
        if (!subjectId) {
          return this.inner.discard(input);
        }
        const gate = this.assertBound(
          subjectId,
          episodeId,
          deviceId,
          input.onTelemetry,
          "discard",
        );
        if (!gate.ok) {
          return {
            ok: false as const,
            failureClass: gate.failureClass,
            detail: gate.detail,
            subjectId: gate.subjectId,
            deviceId: gate.deviceId,
          };
        }
        const dropped = this.inner.discard(input);
        if (dropped.ok) {
          this.boundEpisodeId = null;
          this.boundSubjectId = null;
          emit(input.onTelemetry, {
            op: "discard",
            outcome: "ok",
            subjectId,
            deviceId,
            episodeId,
            rolloutId: this.rolloutId,
            backend: this.backendId,
            detail: dropped.alreadyDiscarded
              ? "idempotent discard — rollout unbound"
              : "rollout snapshot discarded and unbound",
          });
        }
        return dropped;
      },
    );
  }

  teardownAtTerminal(input: TeardownAtTerminalInput): TeardownAtTerminalResult {
    const subjectId = input.subjectId.trim();
    const deviceId = input.deviceId.trim();
    const episodeId = input.episodeId.trim();

    return this.withSubjectLock(
      subjectId || "__missing__",
      deviceId,
      input.onTelemetry,
      "teardown",
      episodeId,
      () => {
        if (!subjectId) {
          return this.inner.teardownAtTerminal(input);
        }
        const gate = this.assertBound(
          subjectId,
          episodeId,
          deviceId,
          input.onTelemetry,
          "teardown",
        );
        if (!gate.ok) {
          return {
            ok: false as const,
            failureClass: gate.failureClass,
            detail: gate.detail,
            subjectId: gate.subjectId,
            deviceId: gate.deviceId,
          };
        }

        const result = runTeardownAtTerminal({
          backendId: this.backendId,
          subjectId,
          deviceId,
          episodeId,
          ...(input.consent !== undefined ? { consent: input.consent } : {}),
          ...(input.onTelemetry !== undefined
            ? { onTelemetry: input.onTelemetry }
            : {}),
          rolloutId: this.rolloutId,
          discard: (d) => this.inner.discard(d),
          get: (g) => {
            const got = this.inner.get(g);
            if (!got.ok) return got;
            return { ok: true, snapshot: got.snapshot };
          },
        });

        if (result.ok && result.discarded) {
          this.boundEpisodeId = null;
          this.boundSubjectId = null;
        }
        return result;
      },
    );
  }

  /** Bound episode after successful clone (observability / tests). */
  getBoundEpisodeId(): string | null {
    return this.boundEpisodeId;
  }

  getBoundSubjectId(): string | null {
    return this.boundSubjectId;
  }
}

export type AllocateRolloutStoreInput = {
  deviceId?: string;
  durableDir?: string;
  onTelemetry?: (e: SnapshotTelemetry) => void;
};

export type AllocateRolloutStoreResult =
  | {
      ok: true;
      store: IsolatedRolloutSnapshotStore;
      rolloutId: string;
    }
  | {
      ok: false;
      failureClass: "fleet_limit" | "config";
      detail: string;
    };

/**
 * Fleet that assigns a unique store instance per rollout episode.
 */
export class SnapshotStoreFleet {
  private allocated = 0;
  private readonly active = new Map<string, IsolatedRolloutSnapshotStore>();
  private readonly limit: number;

  constructor(options: { limit?: number } = {}) {
    this.limit = options.limit ?? SNAPSHOT_FLEET_ROLLOUT_LIMIT;
  }

  get allocatedCount(): number {
    return this.allocated;
  }

  allocateRolloutStore(
    input: AllocateRolloutStoreInput = {},
  ): AllocateRolloutStoreResult {
    const deviceId = input.deviceId?.trim() || "dev-snapshot-fleet";
    if (this.allocated >= this.limit) {
      emit(input.onTelemetry, {
        op: "allocate",
        outcome: "error",
        subjectId: null,
        deviceId,
        failureClass: "fleet_limit",
        detail: `rollout store fleet exceeds ${this.limit}`,
        backend: "memory",
      });
      return {
        ok: false,
        failureClass: "fleet_limit",
        detail: `rollout store fleet exceeds ${this.limit}`,
      };
    }

    const store = new IsolatedRolloutSnapshotStore({
      deviceId,
      ...(input.durableDir !== undefined
        ? { durableDir: input.durableDir }
        : {}),
    });
    this.active.set(store.rolloutId, store);
    this.allocated += 1;

    emit(input.onTelemetry, {
      op: "allocate",
      outcome: "ok",
      subjectId: null,
      deviceId,
      rolloutId: store.rolloutId,
      backend: "memory",
      detail: "unique store instance allocated for rollout",
    });

    return { ok: true, store, rolloutId: store.rolloutId };
  }

  /** Drop tracking entry and free a fleet slot (no orphan after burst). */
  releaseRolloutStore(rolloutId: string): boolean {
    const id = rolloutId.trim();
    if (!this.active.has(id)) return false;
    this.active.delete(id);
    this.allocated = Math.max(0, this.allocated - 1);
    return true;
  }

  get activeCount(): number {
    return this.active.size;
  }

  getRolloutStore(rolloutId: string): IsolatedRolloutSnapshotStore | null {
    return this.active.get(rolloutId.trim()) ?? null;
  }
}

/** Default gym fleet — each GymEnv allocates a unique store. */
const defaultFleet = new SnapshotStoreFleet();

export function getDefaultSnapshotStoreFleet(): SnapshotStoreFleet {
  return defaultFleet;
}

/**
 * Allocate a per-rollout isolated store (fleet). Prefer this over sharing
 * one InMemorySnapshotStore across episodes.
 */
export function allocatePerRolloutSnapshotStore(
  input: AllocateRolloutStoreInput = {},
): AllocateRolloutStoreResult {
  return defaultFleet.allocateRolloutStore(input);
}

/** Prove helper: two stores cannot cross-read. */
export function assertNoCrossRolloutRead(input: {
  storeA: SnapshotStoreRepository;
  storeB: SnapshotStoreRepository;
  subjectId: string;
  deviceId: string;
  episodeA: string;
  episodeB: string;
}): { ok: boolean; detail: string } {
  const a = input.storeA.cloneAtReset({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    episodeId: input.episodeA,
  });
  const b = input.storeB.cloneAtReset({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    episodeId: input.episodeB,
  });
  if (!a.ok || !b.ok) {
    return { ok: false, detail: "clone setup failed" };
  }

  // Mutate A only.
  const putA = input.storeA.put({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    episodeId: input.episodeA,
    snapshot: {
      ...a.snapshot,
      knowledge: { connectorIds: ["only-a"], orderedIds: ["only-a"] },
      stateVector: { session: "000000000000009:000009:dev" },
    },
    expectedStateVector: a.snapshot.stateVector,
  });
  if (!putA.ok) {
    return { ok: false, detail: "put A failed" };
  }

  const crossFromB = input.storeB.get({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    episodeId: input.episodeA,
  });
  if (crossFromB.ok) {
    return {
      ok: false,
      detail: "store B could read store A episode (isolation broken)",
    };
  }
  if (
    crossFromB.failureClass !== "not_found" &&
    crossFromB.failureClass !== "cross_rollout"
  ) {
    return {
      ok: false,
      detail: `unexpected cross-read failureClass=${crossFromB.failureClass}`,
    };
  }

  const stillB = input.storeB.get({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    episodeId: input.episodeB,
  });
  if (!stillB.ok || stillB.snapshot.knowledge.connectorIds.includes("only-a")) {
    return { ok: false, detail: "store B snapshot contaminated by A" };
  }

  // Distinct instances
  if (
    input.storeA.rolloutId &&
    input.storeB.rolloutId &&
    input.storeA.rolloutId === input.storeB.rolloutId
  ) {
    return { ok: false, detail: "rolloutIds are not unique" };
  }

  return { ok: true, detail: "no cross-rollout read" };
}

/**
 * Terminal teardown + fleet release — no orphan active stores after a burst.
 */
export function teardownAndReleaseRolloutStore(input: {
  store: SnapshotStoreRepository;
  subjectId: string;
  deviceId: string;
  episodeId: string;
  consent?: TeardownAtTerminalInput["consent"];
  fleet?: SnapshotStoreFleet;
  onTelemetry?: (e: SnapshotTelemetry) => void;
}): TeardownAtTerminalResult & { released: boolean } {
  const fleet = input.fleet ?? defaultFleet;
  const torn = input.store.teardownAtTerminal({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    episodeId: input.episodeId,
    ...(input.consent !== undefined ? { consent: input.consent } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  let released = false;
  if (input.store.rolloutId) {
    released = fleet.releaseRolloutStore(input.store.rolloutId);
    if (released) {
      emit(input.onTelemetry, {
        op: "release",
        outcome: "ok",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        episodeId: input.episodeId,
        rolloutId: input.store.rolloutId,
        backend: input.store.backendId,
        detail: "fleet slot released after episode terminal",
      });
    }
  }

  if (!torn.ok) {
    return { ...torn, released };
  }
  return { ...torn, released };
}

/**
 * Prove: after N allocate → teardown+release cycles, fleet has zero active stores.
 */
export function assertNoOrphanStoresAfterBurst(input: {
  subjectId: string;
  deviceId: string;
  burstSize?: number;
  fleet?: SnapshotStoreFleet;
}): { ok: boolean; detail: string; activeCount: number } {
  const fleet = input.fleet ?? new SnapshotStoreFleet({ limit: 64 });
  const n = input.burstSize ?? 8;
  for (let i = 0; i < n; i += 1) {
    const allocated = fleet.allocateRolloutStore({
      deviceId: input.deviceId,
    });
    if (!allocated.ok) {
      return {
        ok: false,
        detail: `allocate failed at ${i}: ${allocated.detail}`,
        activeCount: fleet.activeCount,
      };
    }
    const ep = `ep.burst.${i}`;
    const cloned = allocated.store.cloneAtReset({
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      episodeId: ep,
    });
    if (!cloned.ok) {
      return {
        ok: false,
        detail: `clone failed at ${i}`,
        activeCount: fleet.activeCount,
      };
    }
    const torn = teardownAndReleaseRolloutStore({
      store: allocated.store,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      episodeId: ep,
      fleet,
      consent: null,
    });
    if (!torn.ok || !torn.discarded) {
      return {
        ok: false,
        detail: `teardown did not discard at ${i}`,
        activeCount: fleet.activeCount,
      };
    }
  }
  if (fleet.activeCount !== 0 || fleet.allocatedCount !== 0) {
    return {
      ok: false,
      detail: `orphan stores remain active=${fleet.activeCount} allocated=${fleet.allocatedCount}`,
      activeCount: fleet.activeCount,
    };
  }
  return {
    ok: true,
    detail: "no orphan stores after fleet burst",
    activeCount: 0,
  };
}

