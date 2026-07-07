/**
 * @module runtime
 *
 * Runtime contracts - the execution environment seams shared by edge and
 * cloud. An agent runs the same cognitive loop whether it is hosted in a
 * phone app, a server process, or a test harness; these contracts are what
 * the host must provide. Reference in-process implementations live in
 * `@moolam/runtime`.
 */

/** Lifecycle phases every hosted agent moves through. Transitions are one-way except suspend/resume. */
export type LifecycleState =
  | "created"
  | "initializing"
  | "ready"
  | "running"
  | "suspended"
  | "stopped"
  | "failed";

/**
 * Contract for components that participate in host lifecycle.
 *
 * Contract requirements:
 *  1. `initialize` MUST be idempotent; hosts may call it defensively.
 *  2. `dispose` MUST flush durable state before resolving; a disposed
 *     component that lost acknowledged writes is a contract violation.
 */
export interface LifecycleAware {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
}

/** One unit of deferred work owned by the runtime scheduler. */
export interface ScheduledTask {
  taskId: string;
  name: string;
  /** Epoch ms at which the task becomes eligible to run. */
  runAtMs: number;
  /** Hard wall-clock budget once started; the scheduler MUST abandon on breach. */
  deadlineMs: number;
  execute(): Promise<void>;
}

/**
 * Task scheduling contract.
 *
 * Contract requirements:
 *  1. Tasks with equal `runAtMs` execute in submission order (stable).
 *  2. A failed task MUST NOT prevent later tasks from running.
 *  3. `cancel` on a running task is a no-op returning false.
 */
export interface SchedulerInterface {
  schedule(task: ScheduledTask): void;
  cancel(taskId: string): boolean;
  pendingCount(): number;
}

/** A typed runtime event. `type` is a dot-namespaced key, e.g. "sync.converged". */
export interface RuntimeEvent {
  type: string;
  /** ISO-8601 or HLC string; must be totally ordered per emitter. */
  at: string;
  payload: Record<string, unknown>;
}

/**
 * Event handling contract - how runtime components observe each other
 * without direct coupling (telemetry observes sync, hosts observe both).
 *
 * Contract requirements:
 *  1. `publish` MUST NOT throw because a subscriber threw; subscriber
 *     errors are isolated and reported through the bus's own error event.
 *  2. Delivery is at-least-once, in-process, synchronous by default.
 */
export interface EventBusInterface {
  publish(event: RuntimeEvent): void;
  /** Subscribe to an event type (or "*" for all). Returns an unsubscribe function. */
  subscribe(type: string, handler: (event: RuntimeEvent) => void): () => void;
}

/**
 * Narrow durable-storage seam shared by edge components (vector memory,
 * telemetry log). Adapters bind SQLite flavors per platform: expo-sqlite
 * (mobile), better-sqlite3 (desktop/CI), wa-sqlite/OPFS (web).
 *
 * Contract requirements:
 *  1. `execute` MUST be durable before resolving (write-ahead discipline).
 *  2. Drivers MUST be safe for interleaved async calls from one process.
 */
export interface StorageDriver {
  execute(sql: string, params?: unknown[]): Promise<void>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
