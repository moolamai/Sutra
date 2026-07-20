/**
 * Reference MemoryInterface — durable-before-resolve, kind-aware decay,
 * subject isolation (CK-02).
 *
 * Ported from examples/_shared/mocks.mjs with obligation-grade semantics
 * matching the conformant floor used by the conformance harness.
 *
 * @module memory
 */

import type {
  MemoryInterface,
  MemoryItem,
  MemoryKind,
  MemoryQuery,
  ScoredMemoryItem,
} from "@moolam/contracts";

import { cosineLike, embedText } from "./embed.js";
import type { ContractMockEmit } from "./events.js";

/** MCE-03 episodic half-life (30 days). */
export const EPISODIC_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Bound scans / result sets (NFR). */
export const MEMORY_SCAN_LIMIT = 4096;
export const MEMORY_RECALL_LIMIT = 64;

export type MemoryMockClock = {
  nowMs: () => number;
  setNowMs: (ms: number) => void;
};

/** Shared durable substrate — reinstantiate opens a fresh API over the same map. */
export type MemoryDurableStore = {
  readonly rows: Map<string, MemoryItem>;
  seq: number;
  clock: MemoryMockClock;
  /** Per-subject serialize chain for concurrent same-subject RMW. */
  subjectLocks: Map<string, Promise<unknown>>;
};

export type MemoryMockOptions = {
  store?: MemoryDurableStore;
  deviceId?: string;
  subjectIdDefault?: string;
  emit?: ContractMockEmit;
};

export type MemoryMockHarness = {
  memory: MemoryInterface;
  reinstantiate(): Promise<MemoryInterface>;
  nowMs(): number;
  setNowMs(ms: number): void;
  store: MemoryDurableStore;
};

function createClock(initialMs: number = 1_700_000_000_000): MemoryMockClock {
  let now = initialMs;
  return {
    nowMs: () => now,
    setNowMs: (ms: number) => {
      now = ms;
    },
  };
}

export function createMemoryDurableStore(
  clock?: MemoryMockClock,
): MemoryDurableStore {
  return {
    rows: new Map(),
    seq: 0,
    clock: clock ?? createClock(),
    subjectLocks: new Map(),
  };
}

/** Accept ISO-8601 or HLC physical prefix for age computation. */
export function parseCreatedAtMs(createdAt: string): number {
  const iso = Date.parse(createdAt);
  if (!Number.isNaN(iso)) return iso;
  const physical = Number(createdAt.slice(0, 15));
  if (!Number.isFinite(physical)) {
    throw new Error(`unparseable createdAt: ${createdAt}`);
  }
  return physical;
}

/** Corrections (and non-episodic) never decay. */
export function kindAwareDecayFactor(
  kind: MemoryKind,
  createdAt: string,
  nowMs: number,
  halfLifeMs: number = EPISODIC_HALF_LIFE_MS,
): number {
  if (kind !== "episodic") return 1;
  const ageMs = Math.max(0, nowMs - parseCreatedAtMs(createdAt));
  if (ageMs === 0) return 1;
  return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
}

function matchesQuery(item: MemoryItem, query: MemoryQuery): boolean {
  if (item.subjectId !== query.subjectId) return false;
  if (query.topicId !== undefined && item.topicId !== query.topicId) return false;
  if (query.kinds !== undefined && !query.kinds.includes(item.kind)) return false;
  return true;
}

async function withSubjectLock<T>(
  store: MemoryDurableStore,
  subjectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = store.subjectLocks.get(subjectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const next = prev.then(() => gate);
  store.subjectLocks.set(subjectId, next);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (store.subjectLocks.get(subjectId) === next) {
      store.subjectLocks.delete(subjectId);
    }
  }
}

function openMemoryApi(
  store: MemoryDurableStore,
  options: MemoryMockOptions,
): MemoryInterface {
  const deviceId = options.deviceId?.trim() || "dev-contract-mocks";
  const emit = options.emit;

  return {
    async remember(item) {
      const subjectId = item.subjectId.trim();
      if (!subjectId) {
        emit?.({
          event: "contract_mocks.memory",
          op: "remember",
          subjectId: "",
          deviceId,
          outcome: "error",
        });
        throw new Error("MemoryItem.subjectId is required (subject isolation)");
      }
      return withSubjectLock(store, subjectId, async () => {
        store.seq += 1;
        const id = `mem-${store.seq}`;
        const row: MemoryItem = { ...item, id, subjectId };
        // Durable BEFORE resolve (CK-02.1) — sync Map write is the flush.
        store.rows.set(id, row);
        emit?.({
          event: "contract_mocks.memory",
          op: "remember",
          subjectId,
          deviceId,
          outcome: "ok",
          itemCount: 1,
        });
        return row;
      });
    },

    async recall(query) {
      const subjectId = query.subjectId.trim();
      if (!subjectId) {
        emit?.({
          event: "contract_mocks.memory",
          op: "recall",
          subjectId: "",
          deviceId,
          outcome: "error",
        });
        throw new Error("MemoryQuery.subjectId is required (subject isolation)");
      }
      const limit = Math.min(query.limit ?? 16, MEMORY_RECALL_LIMIT);
      const now = store.clock.nowMs();
      const qVec = embedText(query.query);
      const hits: { item: MemoryItem; score: number; relevance: number }[] = [];
      let scanned = 0;
      for (const item of store.rows.values()) {
        if (scanned >= MEMORY_SCAN_LIMIT) break;
        scanned += 1;
        if (!matchesQuery(item, { ...query, subjectId })) continue;
        const relevance = Math.max(
          0,
          Math.min(1, cosineLike(qVec, embedText(item.text))),
        );
        // Score is kind-aware decay (CK-02.2); relevance only breaks ties.
        const score = kindAwareDecayFactor(item.kind, item.createdAt, now);
        hits.push({ item, score, relevance });
      }
      hits.sort(
        (a, b) =>
          b.score - a.score ||
          b.relevance - a.relevance ||
          a.item.id.localeCompare(b.item.id),
      );
      const out: ScoredMemoryItem[] = hits.slice(0, limit).map((h) => ({
        item: h.item,
        score: h.score,
      }));
      emit?.({
        event: "contract_mocks.memory",
        op: "recall",
        subjectId,
        deviceId,
        outcome: "ok",
        itemCount: out.length,
      });
      return out;
    },

    async associate(fromId, toId, _relation) {
      const from = store.rows.get(fromId);
      const to = store.rows.get(toId);
      const subjectId = from?.subjectId ?? to?.subjectId ?? "";
      if (from && to && from.subjectId !== to.subjectId) {
        emit?.({
          event: "contract_mocks.memory",
          op: "associate",
          subjectId: from.subjectId,
          deviceId,
          outcome: "error",
        });
        throw new Error("associate refuses cross-subject edges");
      }
      emit?.({
        event: "contract_mocks.memory",
        op: "associate",
        subjectId,
        deviceId,
        outcome: "ok",
      });
    },

    async forget(id) {
      const existing = store.rows.get(id);
      if (existing) store.rows.delete(id);
      emit?.({
        event: "contract_mocks.memory",
        op: "forget",
        subjectId: existing?.subjectId ?? "",
        deviceId,
        outcome: "ok",
      });
    },

    async compact(subjectId, olderThanDays) {
      const sid = subjectId.trim();
      const cutoff =
        store.clock.nowMs() - olderThanDays * 24 * 60 * 60 * 1000;
      let removed = 0;
      for (const [id, item] of store.rows) {
        if (item.subjectId !== sid) continue;
        if (item.kind !== "episodic") continue;
        if (parseCreatedAtMs(item.createdAt) >= cutoff) continue;
        store.rows.delete(id);
        removed += 1;
      }
      emit?.({
        event: "contract_mocks.memory",
        op: "compact",
        subjectId: sid,
        deviceId,
        outcome: "ok",
        itemCount: removed,
      });
      return removed;
    },
  };
}

/**
 * In-memory MemoryInterface over a durable shared store.
 * Re-opening via {@link createMemoryMock} with the same store proves durability.
 */
export function createMemoryMock(options: MemoryMockOptions = {}): MemoryInterface {
  const store = options.store ?? createMemoryDurableStore();
  return openMemoryApi(store, options);
}

/**
 * Conformance harness factory: durable substrate + crash-simulating reinstantiate
 * + injectable clock for kind-aware decay probes.
 */
export function createMemoryMockHarnessFactory(
  options: Omit<MemoryMockOptions, "store"> = {},
): () => MemoryMockHarness {
  const store = createMemoryDurableStore();
  return () => {
    const open = () => openMemoryApi(store, { ...options, store });
    return {
      memory: open(),
      async reinstantiate() {
        return open();
      },
      nowMs: () => store.clock.nowMs(),
      setNowMs: (ms: number) => store.clock.setNowMs(ms),
      store,
    };
  };
}

/** examples/_shared alias. */
export const makeMemory = createMemoryMock;
