/**
 * Reference runtime seams — LifecycleAware, Scheduler, EventBus, StorageDriver
 * aligned with the obligation registry (RT-01..04).
 *
 * Implemented in-package (CK-01: no dependency beyond @moolam/contracts).
 * These are the mock-floor re-exports of the reference runtime shapes used by
 * the conformance gate; @moolam/runtime remains the production host package.
 *
 * @module runtime
 */

import type {
  EventBusInterface,
  LifecycleAware,
  RuntimeEvent,
  ScheduledTask,
  SchedulerInterface,
  StorageDriver,
} from "@moolam/contracts";

import type { ContractMockEmit } from "./events.js";

export const RUNTIME_SCAN_LIMIT = 64;
export const RUNTIME_SUBSCRIBER_ERROR_TYPE = "runtime.subscriber-error";

export type RuntimeMockOptions = {
  deviceId?: string;
  subjectId?: string;
  emit?: ContractMockEmit;
};

export type RuntimeMockHarness = {
  lifecycle: LifecycleAware;
  scheduler: SchedulerInterface;
  bus: EventBusInterface;
  storage: StorageDriver;
  untilIdle(): Promise<void>;
  initializeBodyCount(): number;
  durableRows(): readonly { key: string; value: string }[];
};

/** Durable in-memory StorageDriver — execute flushes before resolve. */
export function createMemoryStorageDriver(
  options: RuntimeMockOptions = {},
): StorageDriver & {
  durableRows(): readonly { key: string; value: string }[];
  pendingRows(): readonly { key: string; value: string }[];
} {
  const deviceId = options.deviceId?.trim() || "dev-contract-mocks";
  const subjectId = options.subjectId?.trim() || "subj.contract-mocks";
  const emit = options.emit;
  const pending: { key: string; value: string }[] = [];
  const durable: { key: string; value: string }[] = [];

  return {
    durableRows: () => durable.slice(0, RUNTIME_SCAN_LIMIT),
    pendingRows: () => pending.slice(0, RUNTIME_SCAN_LIMIT),

    async execute(sql, params) {
      const key = String(params?.[0] ?? "");
      const value = String(params?.[1] ?? "");
      try {
        if (sql === "PENDING") {
          pending.push({ key, value });
        } else if (sql === "UPSERT") {
          // Durable BEFORE resolve (RT-04.1).
          durable.push({ key, value });
        } else if (sql === "FLUSH") {
          while (pending.length > 0) {
            durable.push(pending.shift()!);
          }
        }
        emit?.({
          event: "contract_mocks.runtime",
          op: "execute",
          subjectId,
          deviceId,
          outcome: "ok",
        });
      } catch (err) {
        emit?.({
          event: "contract_mocks.runtime",
          op: "execute",
          subjectId,
          deviceId,
          outcome: "error",
        });
        throw err;
      }
    },

    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      void sql;
      const key = String(params?.[0] ?? "");
      return durable
        .filter((r) => r.key === key)
        .slice(0, RUNTIME_SCAN_LIMIT) as T[];
    },
  };
}

/**
 * Lifecycle that flushes storage on dispose; initialize is idempotent.
 */
export function createLifecycleMock(
  storage: StorageDriver,
  options: RuntimeMockOptions = {},
): LifecycleAware & { initializeBodyCount(): number } {
  const deviceId = options.deviceId?.trim() || "dev-contract-mocks";
  const subjectId = options.subjectId?.trim() || "subj.contract-mocks";
  const emit = options.emit;
  let initialized = false;
  let initBodyCount = 0;

  return {
    initializeBodyCount: () => initBodyCount,

    async initialize() {
      if (initialized) {
        emit?.({
          event: "contract_mocks.runtime",
          op: "initialize",
          subjectId,
          deviceId,
          outcome: "ok",
        });
        return;
      }
      initBodyCount += 1;
      initialized = true;
      emit?.({
        event: "contract_mocks.runtime",
        op: "initialize",
        subjectId,
        deviceId,
        outcome: "ok",
      });
    },

    async dispose() {
      await storage.execute("FLUSH");
      emit?.({
        event: "contract_mocks.runtime",
        op: "dispose",
        subjectId,
        deviceId,
        outcome: "ok",
      });
    },
  };
}

/** Stable-order scheduler; failed tasks do not halt the queue. */
export function createSchedulerMock(
  options: RuntimeMockOptions = {},
): SchedulerInterface & { untilIdle(): Promise<void> } {
  const deviceId = options.deviceId?.trim() || "dev-contract-mocks";
  const subjectId = options.subjectId?.trim() || "subj.contract-mocks";
  const emit = options.emit;
  const queue: ScheduledTask[] = [];
  let draining = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const task = queue.shift()!;
        try {
          await task.execute();
        } catch {
          // Failed task MUST NOT block later tasks (RT-02.2).
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    schedule(task) {
      const index = queue.findIndex((t) => t.runAtMs > task.runAtMs);
      if (index === -1) queue.push(task);
      else queue.splice(index, 0, task);
      emit?.({
        event: "contract_mocks.runtime",
        op: "schedule",
        subjectId,
        deviceId,
        outcome: "ok",
      });
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

    async untilIdle() {
      let spins = 0;
      while ((draining || queue.length > 0) && spins < 200) {
        await new Promise((r) => setTimeout(r, 1));
        spins += 1;
        if (!draining && queue.length > 0) void drain();
      }
    },
  };
}

/** Event bus with subscriber-throw isolation. */
export function createEventBusMock(
  options: RuntimeMockOptions = {},
): EventBusInterface {
  const deviceId = options.deviceId?.trim() || "dev-contract-mocks";
  const subjectId = options.subjectId?.trim() || "subj.contract-mocks";
  const emit = options.emit;
  const handlers = new Map<string, Set<(event: RuntimeEvent) => void>>();

  const bus: EventBusInterface = {
    publish(event) {
      try {
        for (const t of [event.type, "*"]) {
          for (const handler of handlers.get(t) ?? []) {
            try {
              handler(event);
            } catch (cause) {
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
        emit?.({
          event: "contract_mocks.runtime",
          op: "publish",
          subjectId,
          deviceId,
          outcome: "ok",
        });
      } catch {
        emit?.({
          event: "contract_mocks.runtime",
          op: "publish",
          subjectId,
          deviceId,
          outcome: "error",
        });
        // Never rethrow subscriber / publish isolation failures.
      }
    },

    subscribe(type, handler) {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
      return () => set.delete(handler);
    },
  };

  return bus;
}

/**
 * Full runtime conformance harness factory (RT-01..04 known-good).
 */
export function createRuntimeMockHarnessFactory(
  options: RuntimeMockOptions = {},
): () => RuntimeMockHarness {
  return () => {
    const storage = createMemoryStorageDriver(options);
    const lifecycle = createLifecycleMock(storage, options);
    const scheduler = createSchedulerMock(options);
    const bus = createEventBusMock(options);
    return {
      lifecycle,
      scheduler,
      bus,
      storage,
      untilIdle: () => scheduler.untilIdle(),
      initializeBodyCount: () => lifecycle.initializeBodyCount(),
      durableRows: () => storage.durableRows(),
    };
  };
}

/** Compose reference runtime mocks for hosts that need all four seams. */
export function createRuntimeMock(options: RuntimeMockOptions = {}): {
  lifecycle: LifecycleAware;
  scheduler: SchedulerInterface;
  bus: EventBusInterface;
  storage: StorageDriver;
} {
  const harness = createRuntimeMockHarnessFactory(options)();
  return {
    lifecycle: harness.lifecycle,
    scheduler: harness.scheduler,
    bus: harness.bus,
    storage: harness.storage,
  };
}
