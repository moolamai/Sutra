/**
 * MemoryInterface obligations and violation fixtures (003).
 *
 * CK-02.1 — `remember` MUST be durable before resolving (probed via resolve →
 * factory re-instantiation → recall — never via store internals).
 * CK-02.2 — `recall` MUST apply kind-aware decay: "correction" items never decay.
 * CK-02.3 — concurrent subjects MUST NOT observe each other's entries.
 *
 * Fixtures (each fails exactly one MUST)
 *   async-write-after-resolve → CK-02.1
 *   decaying-corrections      → CK-02.2
 *   shared-subject-store      → CK-02.3
 */

import type {
  MemoryInterface,
  MemoryItem,
  MemoryQuery,
  ScoredMemoryItem,
} from "@moolam/contracts";

import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
  type ObligationContext,
} from "../registry.js";

/** Verbatim MUST sentences from `packages/contracts/src/memory.ts`. */
export const MUST_REMEMBER_DURABLE =
  "`remember` MUST be durable before resolving.";

export const MUST_KIND_AWARE_DECAY =
  '`recall` MUST apply kind-aware decay: "correction" items never decay.';

export const MUST_CONCURRENT_SUBJECTS =
  "Implementations MUST be safe under concurrent subjects (multi-tenant).";

/** MCE-03 episodic half-life (30 days), mirrored by edge/cloud stores. */
export const EPISODIC_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

export const MEMORY_OBLIGATION_IDS = {
  durability: "CK-02.1",
  decay: "CK-02.2",
  concurrentSubjects: "CK-02.3",
} as const;

/**
 * Conformance surface for memory backends.
 * `reinstantiate` simulates process crash + reopen against the durable substrate.
 * Injected clock drives CK-02.2 decay probes.
 */
export interface MemoryConformanceHarness {
  memory: MemoryInterface;
  /** Discard volatile handles; return a fresh API over durable state. */
  reinstantiate(): Promise<MemoryInterface>;
  /** Wall clock (ms) used by kind-aware decay on recall. */
  nowMs(): number;
  setNowMs(ms: number): void;
}

function topicProbeToken(ctx: ObligationContext): string {
  return `topic.ck02.${ctx.subjectId.replace(/[^A-Za-z0-9._-]/g, ".")}`;
}

function findById(
  results: ScoredMemoryItem[],
  id: string,
): ScoredMemoryItem | undefined {
  return results.find((r) => r.item.id === id);
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

/** MCE-03 / CK-02.2 decay factor: corrections (and non-episodic) stay at 1.0. */
export function kindAwareDecayFactor(
  kind: MemoryItem["kind"],
  createdAt: string,
  nowMs: number,
  halfLifeMs: number = EPISODIC_HALF_LIFE_MS,
): number {
  if (kind !== "episodic") return 1;
  const ageMs = Math.max(0, nowMs - parseCreatedAtMs(createdAt));
  if (ageMs === 0) return 1;
  return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
}

export function defineMemoryDurabilityObligation(): Obligation<MemoryConformanceHarness> {
  return defineObligation({
    id: MEMORY_OBLIGATION_IDS.durability,
    contract: "MemoryInterface",
    mustText: MUST_REMEMBER_DURABLE,
    specIds: ["CK-02", "MCE-03"],
    async check(impl, ctx) {
      const topicId = topicProbeToken(ctx);
      const createdAt = "000000001000000:000001:conformance";
      const remembered = await impl.memory.remember({
        subjectId: ctx.subjectId,
        topicId,
        // Metadata token only — never raw learner content.
        text: "probe.durable.token",
        kind: "episodic",
        createdAt,
      });

      // Crash-simulating re-instantiation BEFORE recall (async-write mocks fail here).
      const reopened = await impl.reinstantiate();
      const hits = await reopened.recall({
        subjectId: ctx.subjectId,
        query: "probe.durable.token",
        topicId,
        limit: 8,
      });

      const found = findById(hits, remembered.id);
      if (!found) {
        throw new ObligationViolation({
          obligationId: MEMORY_OBLIGATION_IDS.durability,
          mustText: MUST_REMEMBER_DURABLE,
          contract: "MemoryInterface",
          message:
            "remembered item missing after reinstantiate+recall (not durable before resolve)",
        });
      }
      if (found.item.subjectId !== ctx.subjectId) {
        throw new ObligationViolation({
          obligationId: MEMORY_OBLIGATION_IDS.durability,
          mustText: MUST_REMEMBER_DURABLE,
          contract: "MemoryInterface",
          message: "durable item returned under wrong subjectId",
        });
      }
    },
  });
}

export function defineMemoryDecayObligation(): Obligation<MemoryConformanceHarness> {
  return defineObligation({
    id: MEMORY_OBLIGATION_IDS.decay,
    contract: "MemoryInterface",
    mustText: MUST_KIND_AWARE_DECAY,
    specIds: ["CK-02", "MCE-03"],
    async check(impl, ctx) {
      const topicId = topicProbeToken(ctx);
      const t0 = 1_700_000_000_000;
      impl.setNowMs(t0);
      const createdAt = new Date(t0).toISOString();

      const correction = await impl.memory.remember({
        subjectId: ctx.subjectId,
        topicId,
        text: "probe.decay.correction",
        kind: "correction",
        createdAt,
      });
      const episodic = await impl.memory.remember({
        subjectId: ctx.subjectId,
        topicId,
        text: "probe.decay.episodic",
        kind: "episodic",
        createdAt,
      });

      const atWrite = await impl.memory.recall({
        subjectId: ctx.subjectId,
        query: "probe.decay",
        topicId,
        limit: 8,
      });
      const corrAtWrite = findById(atWrite, correction.id);
      const epiAtWrite = findById(atWrite, episodic.id);
      if (!corrAtWrite || !epiAtWrite) {
        throw new ObligationViolation({
          obligationId: MEMORY_OBLIGATION_IDS.decay,
          mustText: MUST_KIND_AWARE_DECAY,
          contract: "MemoryInterface",
          message: "correction or episodic missing immediately after remember",
        });
      }

      // Simulate time passage (>> 30-day half-life) via injected clock.
      impl.setNowMs(t0 + 2 * EPISODIC_HALF_LIFE_MS);
      const after = await impl.memory.recall({
        subjectId: ctx.subjectId,
        query: "probe.decay",
        topicId,
        limit: 8,
      });
      const corrAfter = findById(after, correction.id);
      const epiAfter = findById(after, episodic.id);
      if (!corrAfter) {
        throw new ObligationViolation({
          obligationId: MEMORY_OBLIGATION_IDS.decay,
          mustText: MUST_KIND_AWARE_DECAY,
          contract: "MemoryInterface",
          message: "correction disappeared after time passage (must never decay away)",
        });
      }
      if (!epiAfter) {
        throw new ObligationViolation({
          obligationId: MEMORY_OBLIGATION_IDS.decay,
          mustText: MUST_KIND_AWARE_DECAY,
          contract: "MemoryInterface",
          message: "episodic missing after time passage (expected decayed, not deleted)",
        });
      }

      // Correction never decays: score must not drop.
      if (corrAfter.score + 1e-9 < corrAtWrite.score) {
        throw new ObligationViolation({
          obligationId: MEMORY_OBLIGATION_IDS.decay,
          mustText: MUST_KIND_AWARE_DECAY,
          contract: "MemoryInterface",
          message: `correction score decayed (${corrAtWrite.score} → ${corrAfter.score})`,
        });
      }
      // Episodic must lose score under aging.
      if (epiAfter.score >= epiAtWrite.score - 1e-9) {
        throw new ObligationViolation({
          obligationId: MEMORY_OBLIGATION_IDS.decay,
          mustText: MUST_KIND_AWARE_DECAY,
          contract: "MemoryInterface",
          message: `episodic score did not decay after aging (${epiAtWrite.score} → ${epiAfter.score})`,
        });
      }
      // Kind-aware ordering: aged episodic ranks below equal-relevance correction.
      if (corrAfter.score <= epiAfter.score) {
        throw new ObligationViolation({
          obligationId: MEMORY_OBLIGATION_IDS.decay,
          mustText: MUST_KIND_AWARE_DECAY,
          contract: "MemoryInterface",
          message: `correction (${corrAfter.score}) must outrank aged episodic (${epiAfter.score})`,
        });
      }
      if (corrAfter.item.subjectId !== ctx.subjectId) {
        throw new ObligationViolation({
          obligationId: MEMORY_OBLIGATION_IDS.decay,
          mustText: MUST_KIND_AWARE_DECAY,
          contract: "MemoryInterface",
          message: "decay probe returned wrong subjectId",
        });
      }
    },
  });
}

export function defineMemoryConcurrentSubjectsObligation(): Obligation<MemoryConformanceHarness> {
  return defineObligation({
    id: MEMORY_OBLIGATION_IDS.concurrentSubjects,
    contract: "MemoryInterface",
    mustText: MUST_CONCURRENT_SUBJECTS,
    specIds: ["CK-02", "MCE-03"],
    async check(impl, ctx) {
      const subjectA = ctx.subjectId;
      const subjectB = `${ctx.subjectId}::peer`;
      const topicId = topicProbeToken(ctx);

      const a = await impl.memory.remember({
        subjectId: subjectA,
        topicId,
        text: "probe.subject.a",
        kind: "preference",
        createdAt: "000000001000000:000002:conformance",
      });
      const b = await impl.memory.remember({
        subjectId: subjectB,
        topicId,
        text: "probe.subject.b",
        kind: "preference",
        createdAt: "000000001000000:000003:conformance",
      });

      const recallA = await impl.memory.recall({
        subjectId: subjectA,
        query: "probe",
        topicId,
        limit: 16,
      });
      const recallB = await impl.memory.recall({
        subjectId: subjectB,
        query: "probe",
        topicId,
        limit: 16,
      });

      if (!findById(recallA, a.id)) {
        throw new ObligationViolation({
          obligationId: MEMORY_OBLIGATION_IDS.concurrentSubjects,
          mustText: MUST_CONCURRENT_SUBJECTS,
          contract: "MemoryInterface",
          message: "subject A cannot recall its own entry",
        });
      }
      if (findById(recallA, b.id)) {
        throw new ObligationViolation({
          obligationId: MEMORY_OBLIGATION_IDS.concurrentSubjects,
          mustText: MUST_CONCURRENT_SUBJECTS,
          contract: "MemoryInterface",
          message: "subject A observed subject B's entry (isolation breach)",
        });
      }
      if (!findById(recallB, b.id)) {
        throw new ObligationViolation({
          obligationId: MEMORY_OBLIGATION_IDS.concurrentSubjects,
          mustText: MUST_CONCURRENT_SUBJECTS,
          contract: "MemoryInterface",
          message: "subject B cannot recall its own entry",
        });
      }
      if (findById(recallB, a.id)) {
        throw new ObligationViolation({
          obligationId: MEMORY_OBLIGATION_IDS.concurrentSubjects,
          mustText: MUST_CONCURRENT_SUBJECTS,
          contract: "MemoryInterface",
          message: "subject B observed subject A's entry (isolation breach)",
        });
      }
    },
  });
}

export function registerMemoryDurabilityAndIsolationObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineMemoryDurabilityObligation());
  registry.register(defineMemoryConcurrentSubjectsObligation());
  return registry;
}

export function registerMemoryDecayObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineMemoryDecayObligation());
  return registry;
}

/** CK-02.1 + CK-02.2 + CK-02.3 */
export function registerMemoryObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registerMemoryDurabilityAndIsolationObligations(registry);
  registerMemoryDecayObligation(registry);
  return registry;
}

export function createMemoryDurabilityIsolationRegistry(): ObligationRegistry {
  return registerMemoryDurabilityAndIsolationObligations(new ObligationRegistry());
}

export function createMemoryDecayObligationRegistry(): ObligationRegistry {
  return registerMemoryDecayObligation(new ObligationRegistry());
}

export function createMemoryObligationsRegistry(): ObligationRegistry {
  return registerMemoryObligations(new ObligationRegistry());
}

/* ── Reference / violation harness factories (contract-surface only) ── */

type StoreRow = MemoryItem;

function matchesQuery(item: MemoryItem, query: MemoryQuery): boolean {
  if (item.subjectId !== query.subjectId) return false;
  if (query.topicId !== undefined && item.topicId !== query.topicId) return false;
  if (query.kinds !== undefined && !query.kinds.includes(item.kind)) return false;
  return true;
}

function stubRest(api: Pick<MemoryInterface, "remember" | "recall">): MemoryInterface {
  return {
    remember: api.remember,
    recall: api.recall,
    async associate() {
      /* vector stores may no-op */
    },
    async forget() {
      /* unused by these obligations */
    },
    async compact() {
      return 0;
    },
  };
}

function createClock(initialMs: number = 1_700_000_000_000) {
  let now = initialMs;
  return {
    nowMs: () => now,
    setNowMs: (ms: number) => {
      now = ms;
    },
  };
}

type DecayMode = "kind-aware" | "none" | "uniform-episodic";

function scoreItem(
  item: MemoryItem,
  nowMs: number,
  mode: DecayMode,
): number {
  const base = 1;
  if (mode === "none") return base;
  if (mode === "uniform-episodic") {
    // BUG for CK-02.2: treat corrections like episodics.
    return base * kindAwareDecayFactor("episodic", item.createdAt, nowMs);
  }
  return base * kindAwareDecayFactor(item.kind, item.createdAt, nowMs);
}

function openScoredStore(
  durable: Map<string, StoreRow>,
  seq: { n: number },
  clock: { nowMs: () => number },
  decayMode: DecayMode,
  subjectFilter: boolean,
): MemoryInterface {
  return stubRest({
    async remember(item) {
      const id = `mem-${++seq.n}`;
      const row: MemoryItem = { ...item, id };
      durable.set(id, row);
      return row;
    },
    async recall(query) {
      const limit = query.limit ?? 16;
      const now = clock.nowMs();
      const hits: ScoredMemoryItem[] = [];
      for (const item of durable.values()) {
        if (subjectFilter) {
          if (!matchesQuery(item, query)) continue;
        } else if (query.topicId !== undefined && item.topicId !== query.topicId) {
          continue;
        }
        hits.push({ item, score: scoreItem(item, now, decayMode) });
      }
      hits.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
      return hits.slice(0, limit);
    },
  });
}

/**
 * Known-good reference: durable shared substrate, subject isolation,
 * kind-aware decay under an injectable clock, reinstantiate opens a new handle.
 */
export function createDurableMemoryHarnessFactory(): () => MemoryConformanceHarness {
  const durable = new Map<string, StoreRow>();
  const seq = { n: 0 };
  const clock = createClock();

  return () => {
    const open = () =>
      openScoredStore(durable, seq, clock, "kind-aware", true);
    return {
      memory: open(),
      async reinstantiate() {
        return open();
      },
      nowMs: () => clock.nowMs(),
      setNowMs: (ms: number) => clock.setNowMs(ms),
    };
  };
}

/**
 * Violation for CK-02.1: instance-local volatile map — survives resolve but
 * disappears across reinstantiate (naive in-memory-only backends).
 */
export function createVolatileMemoryHarnessFactory(): () => MemoryConformanceHarness {
  let seq = 0;
  const clock = createClock();

  return () => {
    const open = (): MemoryInterface => {
      const volatile = new Map<string, StoreRow>();
      return stubRest({
        async remember(item) {
          const id = `vol-${++seq}`;
          const row: MemoryItem = { ...item, id };
          volatile.set(id, row);
          return row;
        },
        async recall(query) {
          const limit = query.limit ?? 16;
          const now = clock.nowMs();
          const hits: ScoredMemoryItem[] = [];
          for (const item of volatile.values()) {
            if (!matchesQuery(item, query)) continue;
            hits.push({
              item,
              score: scoreItem(item, now, "kind-aware"),
            });
            if (hits.length >= limit) break;
          }
          return hits;
        },
      });
    };
    return {
      memory: open(),
      async reinstantiate() {
        return open();
      },
      nowMs: () => clock.nowMs(),
      setNowMs: (ms: number) => clock.setNowMs(ms),
    };
  };
}

/**
 * Canonical CK-02.1 fixture : `remember` resolves before the
 * durable flush. Same-process recall still sees pending rows; crash-simulating
 * reinstantiate only has the durable substrate (empty until the deferred write).
 */
export function createAsyncWriteAfterResolveMemoryHarnessFactory(): () => MemoryConformanceHarness {
  return () => {
    const durable = new Map<string, StoreRow>();
    const pending = new Map<string, StoreRow>();
    const seq = { n: 0 };
    const clock = createClock();

    const open = (includePending: boolean): MemoryInterface =>
      stubRest({
        async remember(item) {
          const id = `async-${++seq.n}`;
          const row: MemoryItem = { ...item, id };
          pending.set(id, row);
          // Resolve first; durable write is deferred past the current turn.
          const timer = setTimeout(() => {
            durable.set(id, row);
            pending.delete(id);
          }, 50);
          if (typeof timer.unref === "function") timer.unref();
          return row;
        },
        async recall(query) {
          const limit = query.limit ?? 16;
          const now = clock.nowMs();
          const pool = new Map<string, StoreRow>(durable);
          if (includePending) {
            for (const [id, row] of pending) pool.set(id, row);
          }
          const hits: ScoredMemoryItem[] = [];
          for (const item of pool.values()) {
            if (!matchesQuery(item, query)) continue;
            hits.push({ item, score: scoreItem(item, now, "kind-aware") });
          }
          hits.sort(
            (a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id),
          );
          return hits.slice(0, limit);
        },
      });

    return {
      memory: open(true),
      async reinstantiate() {
        // Crash: abandon pending backlog; only durable rows remain.
        return open(false);
      },
      nowMs: () => clock.nowMs(),
      setNowMs: (ms: number) => clock.setNowMs(ms),
    };
  };
}

/**
 * Violation for CK-02.3 / shared-subject-store fixture: ignore subjectId on recall.
 */
export function createLeakySubjectMemoryHarnessFactory(): () => MemoryConformanceHarness {
  const durable = new Map<string, StoreRow>();
  const seq = { n: 0 };
  const clock = createClock();

  return () => {
    const open = () =>
      openScoredStore(durable, seq, clock, "kind-aware", false);
    return {
      memory: open(),
      async reinstantiate() {
        return open();
      },
      nowMs: () => clock.nowMs(),
      setNowMs: (ms: number) => clock.setNowMs(ms),
    };
  };
}

/** Alias — shared-subject-store fixture. */
export const createSharedSubjectStoreMemoryHarnessFactory =
  createLeakySubjectMemoryHarnessFactory;

/**
 * Violation for CK-02.2 / decaying-corrections fixture: episodic decay on all kinds.
 */
export function createUniformDecayMemoryHarnessFactory(): () => MemoryConformanceHarness {
  const durable = new Map<string, StoreRow>();
  const seq = { n: 0 };
  const clock = createClock();

  return () => {
    const open = () =>
      openScoredStore(durable, seq, clock, "uniform-episodic", true);
    return {
      memory: open(),
      async reinstantiate() {
        return open();
      },
      nowMs: () => clock.nowMs(),
      setNowMs: (ms: number) => clock.setNowMs(ms),
    };
  };
}

/** Alias — decaying-corrections fixture. */
export const createDecayingCorrectionsMemoryHarnessFactory =
  createUniformDecayMemoryHarnessFactory;

/**
 * Violation for CK-02.2: no decay at all — aged episodic stays tied with correction.
 */
export function createNoDecayMemoryHarnessFactory(): () => MemoryConformanceHarness {
  const durable = new Map<string, StoreRow>();
  const seq = { n: 0 };
  const clock = createClock();

  return () => {
    const open = () => openScoredStore(durable, seq, clock, "none", true);
    return {
      memory: open(),
      async reinstantiate() {
        return open();
      },
      nowMs: () => clock.nowMs(),
      setNowMs: (ms: number) => clock.setNowMs(ms),
    };
  };
}

/** One deliberately-broken memory that fails exactly one CK-02.* MUST. */
export interface MemoryViolationFixture {
  fixtureId: string;
  targetObligationId: (typeof MEMORY_OBLIGATION_IDS)[keyof typeof MEMORY_OBLIGATION_IDS];
  mustText: string;
  summary: string;
  createFactory: () => () => MemoryConformanceHarness;
}

/**
 * Named catalog — each fixture fails its target and passes the others.
 */
export const MEMORY_VIOLATION_FIXTURES = {
  asyncWriteAfterResolve: {
    fixtureId: "memory.violation.async-write-after-resolve",
    targetObligationId: MEMORY_OBLIGATION_IDS.durability,
    mustText: MUST_REMEMBER_DURABLE,
    summary:
      "remember() resolves before durable flush; reinstantiate recalls empty",
    createFactory: createAsyncWriteAfterResolveMemoryHarnessFactory,
  },
  decayingCorrections: {
    fixtureId: "memory.violation.decaying-corrections",
    targetObligationId: MEMORY_OBLIGATION_IDS.decay,
    mustText: MUST_KIND_AWARE_DECAY,
    summary: "corrections decay like episodics (uniform episodic half-life)",
    createFactory: createDecayingCorrectionsMemoryHarnessFactory,
  },
  sharedSubjectStore: {
    fixtureId: "memory.violation.shared-subject-store",
    targetObligationId: MEMORY_OBLIGATION_IDS.concurrentSubjects,
    mustText: MUST_CONCURRENT_SUBJECTS,
    summary: "recall ignores subjectId — shared cross-tenant store",
    createFactory: createSharedSubjectStoreMemoryHarnessFactory,
  },
} as const satisfies Record<string, MemoryViolationFixture>;

export function listMemoryViolationFixtures(): readonly MemoryViolationFixture[] {
  return [
    MEMORY_VIOLATION_FIXTURES.asyncWriteAfterResolve,
    MEMORY_VIOLATION_FIXTURES.decayingCorrections,
    MEMORY_VIOLATION_FIXTURES.sharedSubjectStore,
  ];
}
