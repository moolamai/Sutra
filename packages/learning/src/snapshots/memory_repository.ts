/**
 * In-memory snapshot store — default for tests.
 * Optional durableDir enables write → restart → read integration proves.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  assertSnapshotBounds,
  cloneCognitiveSnapshot,
  genesisCognitiveSnapshot,
  isSnapshotEmpty,
  stateVectorsEqual,
} from "./deep_clone.js";
import { runTeardownAtTerminal } from "./discard_teardown.js";
import type {
  CloneAtResetInput,
  CloneAtResetResult,
  CognitiveRolloutSnapshot,
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

function emit(
  onTelemetry: ((e: SnapshotTelemetry) => void) | undefined,
  e: Omit<SnapshotTelemetry, "event">,
): void {
  onTelemetry?.({ event: "learning.snapshot_store", ...e });
}

function slotKey(subjectId: string, episodeId: string): string {
  return `${subjectId}\n${episodeId}`;
}

export type InMemorySnapshotStoreOptions = {
  /**
   * When set, put/clone persist JSON under this directory so a new process
   * (or new store instance) can reload committed snapshots.
   */
  durableDir?: string;
  deviceId?: string;
};

export class InMemorySnapshotStore implements SnapshotStoreRepository {
  readonly backendId = "memory" as const;
  private readonly slots = new Map<string, CognitiveRolloutSnapshot>();
  private readonly durableDir: string | undefined;
  private readonly defaultDeviceId: string;

  constructor(options: InMemorySnapshotStoreOptions = {}) {
    this.durableDir = options.durableDir?.trim() || undefined;
    this.defaultDeviceId = options.deviceId?.trim() || "dev-snapshot-memory";
    if (this.durableDir) {
      mkdirSync(this.durableDir, { recursive: true });
      this.hydrateFromDisk();
    }
  }

  cloneAtReset(input: CloneAtResetInput): CloneAtResetResult {
    const subjectId = input.subjectId.trim();
    const deviceId = input.deviceId.trim() || this.defaultDeviceId;
    const episodeId = input.episodeId.trim();

    if (!subjectId) {
      emit(input.onTelemetry, {
        op: "clone",
        outcome: "error",
        subjectId: null,
        deviceId,
        failureClass: "missing_subject",
        detail: "subjectId required for snapshot clone",
        backend: this.backendId,
      });
      return {
        ok: false,
        failureClass: "missing_subject",
        detail: "subjectId required for snapshot clone",
        subjectId: "",
        deviceId,
      };
    }
    if (!episodeId) {
      emit(input.onTelemetry, {
        op: "clone",
        outcome: "error",
        subjectId,
        deviceId,
        failureClass: "schema_violation",
        detail: "episodeId required for snapshot clone",
        backend: this.backendId,
      });
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "episodeId required for snapshot clone",
        subjectId,
        deviceId,
      };
    }

    if (input.template && input.template.subjectId !== subjectId) {
      emit(input.onTelemetry, {
        op: "clone",
        outcome: "error",
        subjectId,
        deviceId,
        episodeId,
        failureClass: "cross_subject",
        detail: "template subjectId diverged from clone bind",
        backend: this.backendId,
      });
      return {
        ok: false,
        failureClass: "cross_subject",
        detail: "template subjectId diverged from clone bind",
        subjectId,
        deviceId,
      };
    }

    const snapshot = input.template
      ? cloneCognitiveSnapshot(input.template, {
          subjectId,
          deviceId,
          episodeId,
        })
      : genesisCognitiveSnapshot({ subjectId, deviceId, episodeId });

    const bounds = assertSnapshotBounds(snapshot);
    if (!bounds.ok) {
      emit(input.onTelemetry, {
        op: "clone",
        outcome: "error",
        subjectId,
        deviceId,
        episodeId,
        failureClass: "section_limit",
        detail: bounds.detail,
        backend: this.backendId,
      });
      return {
        ok: false,
        failureClass: "section_limit",
        detail: bounds.detail,
        subjectId,
        deviceId,
      };
    }

    this.slots.set(slotKey(subjectId, episodeId), snapshot);
    this.persistSlot(subjectId, episodeId, snapshot);

    emit(input.onTelemetry, {
      op: "clone",
      outcome: "ok",
      subjectId,
      deviceId,
      episodeId,
      backend: this.backendId,
      detail: "cognitive snapshot cloned at reset",
    });

    return { ok: true, snapshot, backend: this.backendId };
  }

  get(input: GetSnapshotInput): GetSnapshotResult {
    const subjectId = input.subjectId.trim();
    const deviceId = input.deviceId.trim() || this.defaultDeviceId;
    const episodeId = input.episodeId.trim();

    if (!subjectId) {
      emit(input.onTelemetry, {
        op: "get",
        outcome: "error",
        subjectId: null,
        deviceId,
        failureClass: "missing_subject",
        detail: "subjectId required for snapshot get",
        backend: this.backendId,
      });
      return {
        ok: false,
        failureClass: "missing_subject",
        detail: "subjectId required for snapshot get",
        subjectId: "",
        deviceId,
      };
    }

    const key = slotKey(subjectId, episodeId);
    let snapshot = this.slots.get(key);
    if (!snapshot && this.durableDir) {
      snapshot = this.loadFromDisk(subjectId, episodeId) ?? undefined;
      if (snapshot) this.slots.set(key, snapshot);
    }

    if (!snapshot) {
      emit(input.onTelemetry, {
        op: "get",
        outcome: "error",
        subjectId,
        deviceId,
        episodeId,
        failureClass: "not_found",
        detail: "snapshot episode slot not found",
        backend: this.backendId,
      });
      return {
        ok: false,
        failureClass: "not_found",
        detail: "snapshot episode slot not found",
        subjectId,
        deviceId,
      };
    }

    const empty = isSnapshotEmpty(snapshot);
    emit(input.onTelemetry, {
      op: "get",
      outcome: "ok",
      subjectId,
      deviceId,
      episodeId,
      backend: this.backendId,
      detail: empty ? "empty snapshot" : "snapshot loaded",
    });

    return {
      ok: true,
      empty,
      snapshot,
      backend: this.backendId,
    };
  }

  put(input: PutSnapshotInput): PutSnapshotResult {
    const subjectId = input.subjectId.trim();
    const deviceId = input.deviceId.trim() || this.defaultDeviceId;
    const episodeId = input.episodeId.trim();

    if (!subjectId) {
      return {
        ok: false,
        failureClass: "missing_subject",
        detail: "subjectId required for snapshot put",
        subjectId: "",
        deviceId,
      };
    }
    if (input.snapshot.subjectId !== subjectId) {
      emit(input.onTelemetry, {
        op: "put",
        outcome: "error",
        subjectId,
        deviceId,
        episodeId,
        failureClass: "cross_subject",
        detail: "put snapshot subjectId diverged",
        backend: this.backendId,
      });
      return {
        ok: false,
        failureClass: "cross_subject",
        detail: "put snapshot subjectId diverged",
        subjectId,
        deviceId,
      };
    }

    const key = slotKey(subjectId, episodeId);
    let existing = this.slots.get(key);
    if (!existing) {
      existing = this.loadFromDisk(subjectId, episodeId) ?? undefined;
      if (existing) this.slots.set(key, existing);
    }
    if (!existing) {
      emit(input.onTelemetry, {
        op: "put",
        outcome: "error",
        subjectId,
        deviceId,
        episodeId,
        failureClass: "not_found",
        detail: "cannot put — episode slot not found (clone at reset first)",
        backend: this.backendId,
      });
      return {
        ok: false,
        failureClass: "not_found",
        detail: "cannot put — episode slot not found (clone at reset first)",
        subjectId,
        deviceId,
      };
    }

    if (!stateVectorsEqual(existing.stateVector, input.expectedStateVector)) {
      emit(input.onTelemetry, {
        op: "put",
        outcome: "error",
        subjectId,
        deviceId,
        episodeId,
        failureClass: "stale_state_vector",
        detail: "stale state-vector write rejected",
        backend: this.backendId,
      });
      return {
        ok: false,
        failureClass: "stale_state_vector",
        detail: "stale state-vector write rejected",
        subjectId,
        deviceId,
      };
    }

    const bounds = assertSnapshotBounds(input.snapshot);
    if (!bounds.ok) {
      return {
        ok: false,
        failureClass: "section_limit",
        detail: bounds.detail,
        subjectId,
        deviceId,
      };
    }

    // Store a deep clone so callers cannot mutate the repository slot.
    const stored = cloneCognitiveSnapshot(input.snapshot, {
      subjectId,
      deviceId,
      episodeId,
    });
    this.slots.set(key, stored);
    this.persistSlot(subjectId, episodeId, stored);

    emit(input.onTelemetry, {
      op: "put",
      outcome: "ok",
      subjectId,
      deviceId,
      episodeId,
      backend: this.backendId,
      detail: "snapshot put committed",
    });

    return { ok: true, snapshot: stored, backend: this.backendId };
  }

  discard(input: DiscardSnapshotInput): DiscardSnapshotResult {
    const subjectId = input.subjectId.trim();
    const deviceId = input.deviceId.trim() || this.defaultDeviceId;
    const episodeId = input.episodeId.trim();

    if (!subjectId) {
      emit(input.onTelemetry, {
        op: "discard",
        outcome: "error",
        subjectId: null,
        deviceId,
        failureClass: "missing_subject",
        detail: "subjectId required for snapshot discard",
        backend: this.backendId,
      });
      return {
        ok: false,
        failureClass: "missing_subject",
        detail: "subjectId required for snapshot discard",
        subjectId: "",
        deviceId,
      };
    }
    if (!episodeId) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "episodeId required for snapshot discard",
        subjectId,
        deviceId,
      };
    }

    const key = slotKey(subjectId, episodeId);
    const hadMemory = this.slots.delete(key);
    const hadDisk = this.unlinkDurable(subjectId, episodeId);
    const alreadyDiscarded = !hadMemory && !hadDisk;

    emit(input.onTelemetry, {
      op: "discard",
      outcome: "ok",
      subjectId,
      deviceId,
      episodeId,
      backend: this.backendId,
      detail: alreadyDiscarded
        ? "idempotent discard — slot already absent"
        : "snapshot episode slot discarded",
    });

    return {
      ok: true,
      discarded: true,
      alreadyDiscarded,
      backend: this.backendId,
    };
  }

  teardownAtTerminal(input: TeardownAtTerminalInput): TeardownAtTerminalResult {
    return runTeardownAtTerminal({
      backendId: this.backendId,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      episodeId: input.episodeId,
      ...(input.consent !== undefined ? { consent: input.consent } : {}),
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
      discard: (d) => this.discard(d),
      get: (g) => {
        const got = this.get(g);
        if (!got.ok) return got;
        return { ok: true, snapshot: got.snapshot };
      },
    });
  }

  private filePath(subjectId: string, episodeId: string): string {
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_");
    return path.join(
      this.durableDir!,
      `${safe(subjectId)}__${safe(episodeId)}.json`,
    );
  }

  private persistSlot(
    subjectId: string,
    episodeId: string,
    snapshot: CognitiveRolloutSnapshot,
  ): void {
    if (!this.durableDir) return;
    mkdirSync(this.durableDir, { recursive: true });
    writeFileSync(
      this.filePath(subjectId, episodeId),
      `${JSON.stringify(snapshot)}\n`,
      "utf8",
    );
  }

  private unlinkDurable(subjectId: string, episodeId: string): boolean {
    if (!this.durableDir) return false;
    const p = this.filePath(subjectId, episodeId);
    if (!existsSync(p)) return false;
    try {
      unlinkSync(p);
      return true;
    } catch {
      return false;
    }
  }

  private loadFromDisk(
    subjectId: string,
    episodeId: string,
  ): CognitiveRolloutSnapshot | null {
    if (!this.durableDir) return null;
    const p = this.filePath(subjectId, episodeId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as CognitiveRolloutSnapshot;
    } catch {
      return null;
    }
  }

  private hydrateFromDisk(): void {
    if (!this.durableDir || !existsSync(this.durableDir)) return;
    // Lazy: get/loadFromDisk reads files on demand; no unbounded scan.
  }
}
