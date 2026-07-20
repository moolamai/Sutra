/**
 * Runtime contract obligations .
 *
 * RT-01.1 — `initialize` MUST be idempotent.
 * RT-01.2 — `dispose` MUST flush durable state before resolving (probed via storage).
 * RT-02.1 — Tasks with equal `runAtMs` execute in submission order (stable).
 * RT-02.2 — A failed task MUST NOT prevent later tasks from running.
 * RT-03.1 — `publish` MUST NOT throw because a subscriber threw.
 * RT-04.1 — Storage `execute` MUST be durable before resolving.
 *
 * Planning (CK-08) is ; catalog fixtures are .
 */

import type {
  EventBusInterface,
  LifecycleAware,
  RuntimeEvent,
  ScheduledTask,
  SchedulerInterface,
  StorageDriver,
} from "@moolam/contracts";

import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
  type ObligationContext,
} from "../registry.js";

export const MUST_INITIALIZE_IDEMPOTENT =
  "`initialize` MUST be idempotent; hosts may call it defensively.";

export const MUST_FLUSH_BEFORE_DISPOSE =
  "`dispose` MUST flush durable state before resolving; a disposed component that lost acknowledged writes is a contract violation.";

export const MUST_STABLE_SCHEDULER_ORDER =
  "Tasks with equal `runAtMs` MUST execute in submission order (stable).";

export const MUST_FAILED_TASK_NON_BLOCKING =
  "A failed task MUST NOT prevent later tasks from running.";

export const MUST_SUBSCRIBER_THROW_ISOLATION =
  "`publish` MUST NOT throw because a subscriber threw; subscriber errors are isolated and reported through the bus's own error event.";

export const MUST_DURABLE_BEFORE_RESOLVE =
  "`execute` MUST be durable before resolving (write-ahead discipline).";

export const RUNTIME_OBLIGATION_IDS = {
  initializeIdempotent: "RT-01.1",
  flushBeforeDispose: "RT-01.2",
  stableSchedulerOrder: "RT-02.1",
  failedTaskNonBlocking: "RT-02.2",
  subscriberThrowIsolation: "RT-03.1",
  durableBeforeResolve: "RT-04.1",
} as const;

/** Max tasks / handlers / rows inspected per probe. */
export const RUNTIME_SCAN_LIMIT = 64;

/** Bus type used when reporting isolated subscriber failures. */
export const RUNTIME_SUBSCRIBER_ERROR_TYPE = "runtime.subscriber-error";

/**
 * Aggregated conformance surface for runtime seams.
 * Harness helpers (`untilIdle`, counters, durable snapshot) are probe-only.
 */
export interface RuntimeConformanceHarness {
  lifecycle: LifecycleAware;
  scheduler: SchedulerInterface;
  bus: EventBusInterface;
  storage: StorageDriver;
  /** Drain eligible scheduled work (harness control). */
  untilIdle(): Promise<void>;
  /** How many times the initialize body actually ran. */
  initializeBodyCount(): number;
  /** Rows visible in durable storage (after flush / execute). */
  durableRows(): readonly { key: string; value: string }[];
}

function subjectToken(subjectId: string): string {
  return subjectId
    .replace(/[^A-Za-z0-9._-]/g, ".")
    .replace(/\.{2,}/g, ".");
}

export function buildRuntimeProbeKey(ctx: ObligationContext, kind: string): string {
  return `probe.rt.${kind}.${subjectToken(ctx.subjectId)}`;
}

export function defineInitializeIdempotentObligation(): Obligation<RuntimeConformanceHarness> {
  return defineObligation({
    id: RUNTIME_OBLIGATION_IDS.initializeIdempotent,
    contract: "LifecycleAware",
    mustText: MUST_INITIALIZE_IDEMPOTENT,
    specIds: ["RT-01"],
    async check(impl) {
      try {
        await impl.lifecycle.initialize();
        await impl.lifecycle.initialize();
      } catch (err) {
        throw new ObligationViolation({
          obligationId: RUNTIME_OBLIGATION_IDS.initializeIdempotent,
          mustText: MUST_INITIALIZE_IDEMPOTENT,
          contract: "LifecycleAware",
          message: `initialize() must succeed when called defensively twice: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      if (impl.initializeBodyCount() !== 1) {
        throw new ObligationViolation({
          obligationId: RUNTIME_OBLIGATION_IDS.initializeIdempotent,
          mustText: MUST_INITIALIZE_IDEMPOTENT,
          contract: "LifecycleAware",
          message: `initialize body must run once across defensive re-entry (got ${impl.initializeBodyCount()})`,
        });
      }
    },
  });
}

export function defineFlushBeforeDisposeObligation(): Obligation<RuntimeConformanceHarness> {
  return defineObligation({
    id: RUNTIME_OBLIGATION_IDS.flushBeforeDispose,
    contract: "LifecycleAware",
    mustText: MUST_FLUSH_BEFORE_DISPOSE,
    specIds: ["RT-01"],
    async check(impl, ctx) {
      const key = buildRuntimeProbeKey(ctx, "flush");
      await impl.lifecycle.initialize();
      // Stage a pending write through the storage seam using a harness-only
      // convention: INSERT INTO pending — reference lifecycle flushes on dispose.
      await impl.storage.execute("PENDING", [key, `probe.rt.value.${subjectToken(ctx.subjectId)}`]);
      if (impl.durableRows().some((r) => r.key === key)) {
        throw new ObligationViolation({
          obligationId: RUNTIME_OBLIGATION_IDS.flushBeforeDispose,
          mustText: MUST_FLUSH_BEFORE_DISPOSE,
          contract: "LifecycleAware",
          message: "PENDING write unexpectedly durable before dispose (probe setup broken)",
        });
      }

      try {
        await impl.lifecycle.dispose();
      } catch (err) {
        throw new ObligationViolation({
          obligationId: RUNTIME_OBLIGATION_IDS.flushBeforeDispose,
          mustText: MUST_FLUSH_BEFORE_DISPOSE,
          contract: "LifecycleAware",
          message: `dispose() threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }

      if (!impl.durableRows().some((r) => r.key === key)) {
        throw new ObligationViolation({
          obligationId: RUNTIME_OBLIGATION_IDS.flushBeforeDispose,
          mustText: MUST_FLUSH_BEFORE_DISPOSE,
          contract: "LifecycleAware",
          message:
            "dispose resolved without flushing pending durable state (lost acknowledged write)",
        });
      }
    },
  });
}

export function defineStableSchedulerOrderObligation(): Obligation<RuntimeConformanceHarness> {
  return defineObligation({
    id: RUNTIME_OBLIGATION_IDS.stableSchedulerOrder,
    contract: "SchedulerInterface",
    mustText: MUST_STABLE_SCHEDULER_ORDER,
    specIds: ["RT-02"],
    async check(impl, ctx) {
      const tok = subjectToken(ctx.subjectId);
      const order: string[] = [];
      const runAtMs = 0;
      const ids = [`a.${tok}`, `b.${tok}`, `c.${tok}`];
      for (const id of ids.slice(0, RUNTIME_SCAN_LIMIT)) {
        const task: ScheduledTask = {
          taskId: id,
          name: id,
          runAtMs,
          deadlineMs: 1_000,
          execute: async () => {
            order.push(id);
          },
        };
        impl.scheduler.schedule(task);
      }
      await impl.untilIdle();
      if (order.length !== ids.length) {
        throw new ObligationViolation({
          obligationId: RUNTIME_OBLIGATION_IDS.stableSchedulerOrder,
          mustText: MUST_STABLE_SCHEDULER_ORDER,
          contract: "SchedulerInterface",
          message: `expected ${ids.length} task runs, got ${order.length}`,
        });
      }
      for (let i = 0; i < ids.length; i++) {
        if (order[i] !== ids[i]) {
          throw new ObligationViolation({
            obligationId: RUNTIME_OBLIGATION_IDS.stableSchedulerOrder,
            mustText: MUST_STABLE_SCHEDULER_ORDER,
            contract: "SchedulerInterface",
            message: `equal runAtMs must preserve submission order; got [${order.join(", ")}]`,
          });
        }
      }
    },
  });
}

export function defineFailedTaskNonBlockingObligation(): Obligation<RuntimeConformanceHarness> {
  return defineObligation({
    id: RUNTIME_OBLIGATION_IDS.failedTaskNonBlocking,
    contract: "SchedulerInterface",
    mustText: MUST_FAILED_TASK_NON_BLOCKING,
    specIds: ["RT-02"],
    async check(impl, ctx) {
      const tok = subjectToken(ctx.subjectId);
      const order: string[] = [];
      const runAtMs = 0;
      impl.scheduler.schedule({
        taskId: `ok1.${tok}`,
        name: "ok1",
        runAtMs,
        deadlineMs: 1_000,
        execute: async () => {
          order.push("ok1");
        },
      });
      impl.scheduler.schedule({
        taskId: `fail.${tok}`,
        name: "fail",
        runAtMs,
        deadlineMs: 1_000,
        execute: async () => {
          throw new Error("probe.rt.task-bug");
        },
      });
      impl.scheduler.schedule({
        taskId: `ok2.${tok}`,
        name: "ok2",
        runAtMs,
        deadlineMs: 1_000,
        execute: async () => {
          order.push("ok2");
        },
      });
      await impl.untilIdle();
      if (!(order.includes("ok1") && order.includes("ok2"))) {
        throw new ObligationViolation({
          obligationId: RUNTIME_OBLIGATION_IDS.failedTaskNonBlocking,
          mustText: MUST_FAILED_TASK_NON_BLOCKING,
          contract: "SchedulerInterface",
          message: `failed task blocked later work; ran [${order.join(", ")}]`,
        });
      }
      if (impl.scheduler.pendingCount() !== 0) {
        throw new ObligationViolation({
          obligationId: RUNTIME_OBLIGATION_IDS.failedTaskNonBlocking,
          mustText: MUST_FAILED_TASK_NON_BLOCKING,
          contract: "SchedulerInterface",
          message: "scheduler left pending tasks after failure drain",
        });
      }
    },
  });
}

export function defineSubscriberThrowIsolationObligation(): Obligation<RuntimeConformanceHarness> {
  return defineObligation({
    id: RUNTIME_OBLIGATION_IDS.subscriberThrowIsolation,
    contract: "EventBusInterface",
    mustText: MUST_SUBSCRIBER_THROW_ISOLATION,
    specIds: ["RT-03"],
    async check(impl, ctx) {
      const type = buildRuntimeProbeKey(ctx, "tick");
      const seen: string[] = [];
      const unsubs: Array<() => void> = [];
      try {
        unsubs.push(
          impl.bus.subscribe(type, () => {
            throw new Error("probe.rt.subscriber-boom");
          }),
        );
        unsubs.push(
          impl.bus.subscribe(type, (e) => {
            seen.push(e.type);
          }),
        );
        unsubs.push(
          impl.bus.subscribe(RUNTIME_SUBSCRIBER_ERROR_TYPE, (e) => {
            seen.push(e.type);
          }),
        );

        try {
          impl.bus.publish({
            type,
            at: "1970-01-01T00:00:00.000Z",
            payload: { subjectToken: subjectToken(ctx.subjectId) },
          });
        } catch (err) {
          throw new ObligationViolation({
            obligationId: RUNTIME_OBLIGATION_IDS.subscriberThrowIsolation,
            mustText: MUST_SUBSCRIBER_THROW_ISOLATION,
            contract: "EventBusInterface",
            message: `publish() threw because a subscriber threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }

        if (!seen.includes(type)) {
          throw new ObligationViolation({
            obligationId: RUNTIME_OBLIGATION_IDS.subscriberThrowIsolation,
            mustText: MUST_SUBSCRIBER_THROW_ISOLATION,
            contract: "EventBusInterface",
            message: "healthy subscriber did not receive the event after a peer threw",
          });
        }
        if (!seen.includes(RUNTIME_SUBSCRIBER_ERROR_TYPE)) {
          throw new ObligationViolation({
            obligationId: RUNTIME_OBLIGATION_IDS.subscriberThrowIsolation,
            mustText: MUST_SUBSCRIBER_THROW_ISOLATION,
            contract: "EventBusInterface",
            message:
              "subscriber error was not reported through the bus error event",
          });
        }
      } finally {
        for (const u of unsubs.slice(0, RUNTIME_SCAN_LIMIT)) u();
      }
    },
  });
}

export function defineDurableBeforeResolveObligation(): Obligation<RuntimeConformanceHarness> {
  return defineObligation({
    id: RUNTIME_OBLIGATION_IDS.durableBeforeResolve,
    contract: "StorageDriver",
    mustText: MUST_DURABLE_BEFORE_RESOLVE,
    specIds: ["RT-04"],
    async check(impl, ctx) {
      const key = buildRuntimeProbeKey(ctx, "durable");
      const value = `probe.rt.durable.${subjectToken(ctx.subjectId)}`;
      await impl.storage.execute("UPSERT", [key, value]);
      if (!impl.durableRows().some((r) => r.key === key && r.value === value)) {
        throw new ObligationViolation({
          obligationId: RUNTIME_OBLIGATION_IDS.durableBeforeResolve,
          mustText: MUST_DURABLE_BEFORE_RESOLVE,
          contract: "StorageDriver",
          message:
            "execute() resolved before the write was durable (query/snapshot miss)",
        });
      }
      const rows = await impl.storage.query<{ key: string; value: string }>(
        "SELECT",
        [key],
      );
      if (
        !Array.isArray(rows) ||
        !rows.slice(0, RUNTIME_SCAN_LIMIT).some((r) => r.key === key && r.value === value)
      ) {
        throw new ObligationViolation({
          obligationId: RUNTIME_OBLIGATION_IDS.durableBeforeResolve,
          mustText: MUST_DURABLE_BEFORE_RESOLVE,
          contract: "StorageDriver",
          message: "query() did not observe durable write after execute() resolved",
        });
      }
    },
  });
}

export function registerInitializeIdempotentObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineInitializeIdempotentObligation());
  return registry;
}

export function registerFlushBeforeDisposeObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineFlushBeforeDisposeObligation());
  return registry;
}

export function registerStableSchedulerOrderObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineStableSchedulerOrderObligation());
  return registry;
}

export function registerFailedTaskNonBlockingObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineFailedTaskNonBlockingObligation());
  return registry;
}

export function registerSubscriberThrowIsolationObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineSubscriberThrowIsolationObligation());
  return registry;
}

export function registerDurableBeforeResolveObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineDurableBeforeResolveObligation());
  return registry;
}

export function registerRuntimeObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registerInitializeIdempotentObligation(registry);
  registerFlushBeforeDisposeObligation(registry);
  registerStableSchedulerOrderObligation(registry);
  registerFailedTaskNonBlockingObligation(registry);
  registerSubscriberThrowIsolationObligation(registry);
  registerDurableBeforeResolveObligation(registry);
  return registry;
}

export function createInitializeIdempotentObligationRegistry(): ObligationRegistry {
  return registerInitializeIdempotentObligation(new ObligationRegistry());
}

export function createFlushBeforeDisposeObligationRegistry(): ObligationRegistry {
  return registerFlushBeforeDisposeObligation(new ObligationRegistry());
}

export function createStableSchedulerOrderObligationRegistry(): ObligationRegistry {
  return registerStableSchedulerOrderObligation(new ObligationRegistry());
}

export function createFailedTaskNonBlockingObligationRegistry(): ObligationRegistry {
  return registerFailedTaskNonBlockingObligation(new ObligationRegistry());
}

export function createSubscriberThrowIsolationObligationRegistry(): ObligationRegistry {
  return registerSubscriberThrowIsolationObligation(new ObligationRegistry());
}

export function createDurableBeforeResolveObligationRegistry(): ObligationRegistry {
  return registerDurableBeforeResolveObligation(new ObligationRegistry());
}

export function createRuntimeObligationsRegistry(): ObligationRegistry {
  return registerRuntimeObligations(new ObligationRegistry());
}

/* ── Reference / violation harness factories ── */

type RuntimeFactoryOptions = {
  /** Second initialize re-runs body (violate RT-01.1). */
  nonIdempotentInit: boolean;
  /** dispose resolves without flushing PENDING (violate RT-01.2). */
  disposeWithoutFlush: boolean;
  /** Equal runAtMs LIFO instead of submission order (violate RT-02.1). */
  unstableSchedulerOrder: boolean;
  /** Failed task stops the drain (violate RT-02.2). */
  failBlocksQueue: boolean;
  /** publish rethrows subscriber errors (violate RT-03.1). */
  publishRethrows: boolean;
  /** execute resolves before durable write (violate RT-04.1). */
  executeBeforeDurable: boolean;
};

function createRuntimeFactory(
  options: RuntimeFactoryOptions,
): () => RuntimeConformanceHarness {
  return () => {
    let initBodyCount = 0;
    let initialized = false;
    const pending: { key: string; value: string }[] = [];
    const durable: { key: string; value: string }[] = [];

    const storage: StorageDriver = {
      async execute(sql, params) {
        const key = String(params?.[0] ?? "");
        const value = String(params?.[1] ?? "");
        if (sql === "PENDING") {
          pending.push({ key, value });
          return;
        }
        if (sql === "UPSERT") {
          if (options.executeBeforeDurable) {
            // Resolve without making the write durable (violation).
            return;
          }
          durable.push({ key, value });
          return;
        }
        if (sql === "FLUSH") {
          while (pending.length > 0) {
            durable.push(pending.shift()!);
          }
          return;
        }
      },
      async query<T>(
        _sql: string,
        params?: unknown[],
      ): Promise<T[]> {
        const key = String(params?.[0] ?? "");
        return durable
          .filter((r) => r.key === key)
          .slice(0, RUNTIME_SCAN_LIMIT) as T[];
      },
    };

    const lifecycle: LifecycleAware = {
      async initialize() {
        if (initialized && !options.nonIdempotentInit) return;
        initBodyCount += 1;
        initialized = true;
      },
      async dispose() {
        if (!options.disposeWithoutFlush) {
          await storage.execute("FLUSH");
        }
        // disposeWithoutFlush: resolve with pending still unflushed.
      },
    };

    type QueueItem = ScheduledTask;
    const queue: QueueItem[] = [];
    let draining = false;
    let halted = false;

    async function drain(): Promise<void> {
      if (draining || halted) return;
      draining = true;
      try {
        while (queue.length > 0) {
          const task = options.unstableSchedulerOrder
            ? queue.pop()!
            : queue.shift()!;
          try {
            await task.execute();
          } catch {
            if (options.failBlocksQueue) {
              // Leave remaining tasks stranded (violation).
              halted = true;
              break;
            }
            // swallow and continue (contract)
          }
        }
      } finally {
        draining = false;
      }
    }

    const scheduler: SchedulerInterface = {
      schedule(task) {
        // Insertion keeps submission order for equal runAtMs when stable.
        if (options.unstableSchedulerOrder) {
          queue.push(task);
        } else {
          const index = queue.findIndex((t) => t.runAtMs > task.runAtMs);
          if (index === -1) queue.push(task);
          else queue.splice(index, 0, task);
        }
        void drain();
      },
      cancel(taskId) {
        const index = queue.findIndex((t) => t.taskId === taskId);
        if (index === -1) return false;
        queue.splice(index, 1);
        return true;
      },
      pendingCount() {
        return queue.length;
      },
    };

    const handlers = new Map<string, Set<(event: RuntimeEvent) => void>>();
    const bus: EventBusInterface = {
      publish(event) {
        for (const t of [event.type, "*"]) {
          for (const handler of handlers.get(t) ?? []) {
            try {
              handler(event);
            } catch (cause) {
              if (options.publishRethrows) {
                throw cause;
              }
              if (event.type !== RUNTIME_SUBSCRIBER_ERROR_TYPE) {
                bus.publish({
                  type: RUNTIME_SUBSCRIBER_ERROR_TYPE,
                  at: new Date().toISOString(),
                  payload: {
                    sourceType: event.type,
                    error: String(cause),
                  },
                });
              }
            }
          }
        }
      },
      subscribe(type, handler) {
        const set = handlers.get(type) ?? new Set();
        set.add(handler);
        handlers.set(type, set);
        return () => set.delete(handler);
      },
    };

    return {
      lifecycle,
      scheduler,
      bus,
      storage,
      async untilIdle() {
        let spins = 0;
        while ((draining || (!halted && queue.length > 0)) && spins < 200) {
          await new Promise((r) => setTimeout(r, 1));
          spins += 1;
          if (!halted && !draining && queue.length > 0) void drain();
        }
      },
      initializeBodyCount: () => initBodyCount,
      durableRows: () => durable.slice(0, RUNTIME_SCAN_LIMIT),
    };
  };
}

/** Known-good reference for all RT-01..04 obligations. */
export function createReferenceRuntimeHarnessFactory(): () => RuntimeConformanceHarness {
  return createRuntimeFactory({
    nonIdempotentInit: false,
    disposeWithoutFlush: false,
    unstableSchedulerOrder: false,
    failBlocksQueue: false,
    publishRethrows: false,
    executeBeforeDurable: false,
  });
}

export function createNonIdempotentInitRuntimeHarnessFactory(): () => RuntimeConformanceHarness {
  return createRuntimeFactory({
    nonIdempotentInit: true,
    disposeWithoutFlush: false,
    unstableSchedulerOrder: false,
    failBlocksQueue: false,
    publishRethrows: false,
    executeBeforeDurable: false,
  });
}

export function createDisposeWithoutFlushRuntimeHarnessFactory(): () => RuntimeConformanceHarness {
  return createRuntimeFactory({
    nonIdempotentInit: false,
    disposeWithoutFlush: true,
    unstableSchedulerOrder: false,
    failBlocksQueue: false,
    publishRethrows: false,
    executeBeforeDurable: false,
  });
}

export function createUnstableSchedulerRuntimeHarnessFactory(): () => RuntimeConformanceHarness {
  return createRuntimeFactory({
    nonIdempotentInit: false,
    disposeWithoutFlush: false,
    unstableSchedulerOrder: true,
    failBlocksQueue: false,
    publishRethrows: false,
    executeBeforeDurable: false,
  });
}

export function createFailBlocksQueueRuntimeHarnessFactory(): () => RuntimeConformanceHarness {
  return createRuntimeFactory({
    nonIdempotentInit: false,
    disposeWithoutFlush: false,
    unstableSchedulerOrder: false,
    failBlocksQueue: true,
    publishRethrows: false,
    executeBeforeDurable: false,
  });
}

export function createPublishRethrowsRuntimeHarnessFactory(): () => RuntimeConformanceHarness {
  return createRuntimeFactory({
    nonIdempotentInit: false,
    disposeWithoutFlush: false,
    unstableSchedulerOrder: false,
    failBlocksQueue: false,
    publishRethrows: true,
    executeBeforeDurable: false,
  });
}

export function createExecuteBeforeDurableRuntimeHarnessFactory(): () => RuntimeConformanceHarness {
  return createRuntimeFactory({
    nonIdempotentInit: false,
    disposeWithoutFlush: false,
    unstableSchedulerOrder: false,
    failBlocksQueue: false,
    publishRethrows: false,
    executeBeforeDurable: true,
  });
}

/** One deliberately-broken runtime harness that fails exactly one RT-* MUST. */
export interface RuntimeViolationFixture {
  fixtureId: string;
  targetObligationId: (typeof RUNTIME_OBLIGATION_IDS)[keyof typeof RUNTIME_OBLIGATION_IDS];
  mustText: string;
  summary: string;
  createFactory: () => () => RuntimeConformanceHarness;
}

/**
 * Named runtime fixtures — each fails its target and passes the others.
 */
export const RUNTIME_VIOLATION_FIXTURES = {
  nonIdempotentLifecycle: {
    fixtureId: "runtime.violation.non-idempotent-lifecycle",
    targetObligationId: RUNTIME_OBLIGATION_IDS.initializeIdempotent,
    mustText: MUST_INITIALIZE_IDEMPOTENT,
    summary: "initialize() re-runs its body on defensive re-entry",
    createFactory: createNonIdempotentInitRuntimeHarnessFactory,
  },
  disposeWithoutFlush: {
    fixtureId: "runtime.violation.dispose-without-flush",
    targetObligationId: RUNTIME_OBLIGATION_IDS.flushBeforeDispose,
    mustText: MUST_FLUSH_BEFORE_DISPOSE,
    summary: "dispose() resolves without flushing pending durable writes",
    createFactory: createDisposeWithoutFlushRuntimeHarnessFactory,
  },
  unstableSchedulerOrder: {
    fixtureId: "runtime.violation.unstable-scheduler-order",
    targetObligationId: RUNTIME_OBLIGATION_IDS.stableSchedulerOrder,
    mustText: MUST_STABLE_SCHEDULER_ORDER,
    summary: "equal runAtMs tasks run LIFO instead of submission order",
    createFactory: createUnstableSchedulerRuntimeHarnessFactory,
  },
  failBlocksQueue: {
    fixtureId: "runtime.violation.fail-blocks-queue",
    targetObligationId: RUNTIME_OBLIGATION_IDS.failedTaskNonBlocking,
    mustText: MUST_FAILED_TASK_NON_BLOCKING,
    summary: "a failed task halts the scheduler drain",
    createFactory: createFailBlocksQueueRuntimeHarnessFactory,
  },
  publishRethrows: {
    fixtureId: "runtime.violation.publish-rethrows",
    targetObligationId: RUNTIME_OBLIGATION_IDS.subscriberThrowIsolation,
    mustText: MUST_SUBSCRIBER_THROW_ISOLATION,
    summary: "publish() rethrows when a subscriber throws",
    createFactory: createPublishRethrowsRuntimeHarnessFactory,
  },
  executeBeforeDurable: {
    fixtureId: "runtime.violation.execute-before-durable",
    targetObligationId: RUNTIME_OBLIGATION_IDS.durableBeforeResolve,
    mustText: MUST_DURABLE_BEFORE_RESOLVE,
    summary: "execute() resolves without a durable write",
    createFactory: createExecuteBeforeDurableRuntimeHarnessFactory,
  },
} as const satisfies Record<string, RuntimeViolationFixture>;

export function listRuntimeViolationFixtures(): readonly RuntimeViolationFixture[] {
  return [
    RUNTIME_VIOLATION_FIXTURES.nonIdempotentLifecycle,
    RUNTIME_VIOLATION_FIXTURES.disposeWithoutFlush,
    RUNTIME_VIOLATION_FIXTURES.unstableSchedulerOrder,
    RUNTIME_VIOLATION_FIXTURES.failBlocksQueue,
    RUNTIME_VIOLATION_FIXTURES.publishRethrows,
    RUNTIME_VIOLATION_FIXTURES.executeBeforeDurable,
  ];
}
