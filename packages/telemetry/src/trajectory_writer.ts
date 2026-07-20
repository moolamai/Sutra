/**
 * Subject-scoped, bounded trajectory write-ahead queue.
 *
 * Admission is synchronous and never awaits storage. The background worker
 * durably inserts a pending row before the idempotent final trajectory row.
 * Consent is checked at admission and again immediately before persistence.
 */

import type { StorageDriver } from "@moolam/contracts";
import {
  parseTurnTrajectoryV1,
  type TrajectoryFailureClass,
  type TurnTrajectoryV1,
} from "@moolam/sync-protocol";

export const TRAJECTORY_WRITE_QUEUE_DEFAULT_CAPACITY = 128;
export const TRAJECTORY_WRITE_QUEUE_MAX_CAPACITY = 4_096;
export const TRAJECTORY_WRITE_DEFAULT_TIMEOUT_MS = 5_000;
export const TRAJECTORY_WRITE_DEFAULT_MAX_RETRIES = 2;

export const TRAJECTORY_WRITE_AHEAD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trajectory_write_ahead (
  subject_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  consent_record_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  PRIMARY KEY (subject_id, turn_id)
)`;

export const TRAJECTORY_WRITE_AHEAD_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_trajectory_write_ahead_subject_enqueued
ON trajectory_write_ahead (subject_id, enqueued_at ASC, turn_id ASC)`;

export const TURN_TRAJECTORIES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS turn_trajectories (
  subject_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  consent_record_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  locality TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (subject_id, turn_id)
)`;

export type TrajectoryCaptureConsent = {
  consentRecordId: string;
  subjectId: string;
  scope: "trajectory";
  optedIn: boolean;
  active: boolean;
};

export type TrajectoryWriterFailureClass =
  | TrajectoryFailureClass
  | "not_initialized"
  | "locality_mismatch"
  | "consent_scope_invalid"
  | "consent_resolve_failed"
  | "queue_full"
  | "storage_timeout"
  | "storage_failed"
  | "recovery_invalid";

export type TrajectoryWriterEvent = {
  event: "telemetry.trajectory.capture";
  outcome:
    | "queued"
    | "duplicate"
    | "recovered"
    | "retrying"
    | "persisted"
    | "rejected"
    | "dropped";
  subjectId: string;
  deviceId?: string;
  turnId?: string;
  failureClass?: TrajectoryWriterFailureClass;
  queueDepth?: number;
  retryCount?: number;
};

export type CaptureTrajectoryResult =
  | {
      queued: true;
      duplicate: boolean;
      subjectId: string;
      turnId: string;
      queueDepth: number;
    }
  | {
      queued: false;
      failureClass: TrajectoryWriterFailureClass;
      subjectId: string | null;
      detail: string;
    };

export type TrajectoryWriteAheadQueueOptions = {
  driver: StorageDriver;
  /** This queue and its storage are exclusively bound to this subject. */
  subjectId: string;
  locality: TurnTrajectoryV1["locality"];
  resolveConsent: (
    consentRecordId: string,
  ) => TrajectoryCaptureConsent | null | undefined;
  capacity?: number;
  storageTimeoutMs?: number;
  maxRetries?: number;
  onTelemetry?: (event: TrajectoryWriterEvent) => void;
};

type QueueItem = {
  record: TurnTrajectoryV1;
  recovered: boolean;
};

type ConsentCheck =
  | { ok: true }
  | {
      ok: false;
      failureClass: TrajectoryWriterFailureClass;
      detail: string;
    };

class TrajectoryStorageError extends Error {
  constructor(
    readonly failureClass: "storage_timeout" | "storage_failed",
    message: string,
  ) {
    super(message);
    this.name = "TrajectoryStorageError";
  }
}

/**
 * Bounded admission queue with durable write-ahead and idempotent final insert.
 *
 * `captureTrajectory` performs only validation, consent lookup, and an
 * in-memory enqueue. It returns before any durable write starts.
 */
export class TrajectoryWriteAheadQueue {
  private readonly driver: StorageDriver;
  private readonly boundSubjectId: string;
  private readonly locality: TurnTrajectoryV1["locality"];
  private readonly resolveConsent: TrajectoryWriteAheadQueueOptions["resolveConsent"];
  private readonly capacity: number;
  private readonly storageTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly onTelemetry:
    | ((event: TrajectoryWriterEvent) => void)
    | undefined;

  private readonly queue: QueueItem[] = [];
  private readonly admittedKeys = new Set<string>();
  private initialized = false;
  private draining = false;
  private inFlight = false;
  private dropped = 0;
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: TrajectoryWriteAheadQueueOptions) {
    const subjectId = options.subjectId.trim();
    if (!subjectId) throw new Error("trajectory writer subjectId is required");
    const requestedCapacity =
      options.capacity ?? TRAJECTORY_WRITE_QUEUE_DEFAULT_CAPACITY;
    if (
      !Number.isInteger(requestedCapacity) ||
      requestedCapacity < 1 ||
      requestedCapacity > TRAJECTORY_WRITE_QUEUE_MAX_CAPACITY
    ) {
      throw new Error(
        `trajectory queue capacity must be 1..${TRAJECTORY_WRITE_QUEUE_MAX_CAPACITY}`,
      );
    }
    const timeout =
      options.storageTimeoutMs ?? TRAJECTORY_WRITE_DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout < 1) {
      throw new Error("trajectory storageTimeoutMs must be positive");
    }
    const retries =
      options.maxRetries ?? TRAJECTORY_WRITE_DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
      throw new Error("trajectory maxRetries must be 0..10");
    }

    this.driver = options.driver;
    this.boundSubjectId = subjectId;
    this.locality = options.locality;
    this.resolveConsent = options.resolveConsent;
    this.capacity = requestedCapacity;
    this.storageTimeoutMs = timeout;
    this.maxRetries = retries;
    this.onTelemetry = options.onTelemetry;
  }

  /** Create SQLite tables and recover one bounded pending batch for this subject. */
  async initialize(): Promise<void> {
    await this.storage(
      this.driver.execute(TRAJECTORY_WRITE_AHEAD_SCHEMA_SQL),
      "initialize write-ahead table",
    );
    await this.storage(
      this.driver.execute(TRAJECTORY_WRITE_AHEAD_INDEX_SQL),
      "initialize write-ahead index",
    );
    await this.storage(
      this.driver.execute(TURN_TRAJECTORIES_SCHEMA_SQL),
      "initialize trajectory table",
    );
    this.initialized = true;
    await this.recoverPending();
  }

  /** Current admitted work, including the record being persisted. */
  get queueDepth(): number {
    return this.queue.length + (this.inFlight ? 1 : 0);
  }

  /** Cumulative records refused because the bounded admission queue was full. */
  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * Validate and enqueue without awaiting durable storage.
   * Invalid, cross-subject, wrong-locality, or unconsented records fail closed.
   */
  captureTrajectory(input: unknown): CaptureTrajectoryResult {
    if (!this.initialized) {
      return this.reject(
        "not_initialized",
        null,
        undefined,
        "trajectory writer must be initialized before capture",
      );
    }

    const parsed = parseTurnTrajectoryV1(input);
    if (!parsed.ok) {
      return this.reject(
        parsed.failureClass,
        parsed.subjectId,
        undefined,
        parsed.detail,
      );
    }
    const record = parsed.record;
    if (record.subjectId !== this.boundSubjectId) {
      return this.reject(
        "cross_subject",
        record.subjectId,
        record,
        `writer is bound to '${this.boundSubjectId}'`,
      );
    }
    if (record.locality !== this.locality) {
      return this.reject(
        "locality_mismatch",
        record.subjectId,
        record,
        `writer locality '${this.locality}' does not match record`,
      );
    }

    const consent = this.checkConsent(record);
    if (!consent.ok) {
      return this.reject(
        consent.failureClass,
        record.subjectId,
        record,
        consent.detail,
      );
    }

    const key = this.key(record);
    if (this.admittedKeys.has(key)) {
      this.emit({
        outcome: "duplicate",
        record,
        queueDepth: this.queueDepth,
      });
      return {
        queued: true,
        duplicate: true,
        subjectId: record.subjectId,
        turnId: record.turnId,
        queueDepth: this.queueDepth,
      };
    }
    if (this.queueDepth >= this.capacity) {
      this.dropped++;
      this.emit({
        outcome: "dropped",
        record,
        failureClass: "queue_full",
        queueDepth: this.queueDepth,
      });
      return {
        queued: false,
        failureClass: "queue_full",
        subjectId: record.subjectId,
        detail: `trajectory queue capacity ${this.capacity} reached`,
      };
    }

    this.admit(record, false);
    return {
      queued: true,
      duplicate: false,
      subjectId: record.subjectId,
      turnId: record.turnId,
      queueDepth: this.queueDepth,
    };
  }

  /** Wait for admitted in-memory work only; returns false on bounded timeout. */
  async flush(timeoutMs = this.storageTimeoutMs * (this.maxRetries + 1)): Promise<boolean> {
    if (this.queueDepth === 0) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        resolve(value);
      };
      const onIdle = (): void => finish(true);
      const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
      this.idleWaiters.add(onIdle);
    });
  }

  private admit(record: TurnTrajectoryV1, recovered: boolean): void {
    this.admittedKeys.add(this.key(record));
    this.queue.push({ record, recovered });
    this.emit({
      outcome: recovered ? "recovered" : "queued",
      record,
      queueDepth: this.queueDepth,
    });
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) break;
        this.inFlight = true;
        try {
          await this.persist(item.record);
        } catch (error: unknown) {
          this.emit({
            outcome: "rejected",
            record: item.record,
            failureClass:
              error instanceof TrajectoryStorageError
                ? error.failureClass
                : "storage_failed",
          });
        } finally {
          this.inFlight = false;
          this.admittedKeys.delete(this.key(item.record));
        }
      }
    } finally {
      this.inFlight = false;
      this.draining = false;
      if (this.queue.length > 0) {
        this.scheduleDrain();
      } else {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  private async persist(record: TurnTrajectoryV1): Promise<void> {
    let lastFailure: TrajectoryStorageError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const beforeWrite = this.checkConsent(record);
      if (!beforeWrite.ok) {
        this.emit({
          outcome: "rejected",
          record,
          failureClass: beforeWrite.failureClass,
          retryCount: attempt,
        });
        return;
      }

      try {
        await this.storage(
          this.driver.execute(
            `INSERT OR IGNORE INTO trajectory_write_ahead
             (subject_id, turn_id, device_id, consent_record_id, payload_json, enqueued_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              record.subjectId,
              record.turnId,
              record.deviceId,
              record.consentRecordId,
              JSON.stringify(record),
              record.capturedAt,
            ],
          ),
          "persist trajectory write-ahead",
        );

        const afterWriteAhead = this.checkConsent(record);
        if (!afterWriteAhead.ok) {
          await this.storage(
            this.driver.execute(
              `DELETE FROM trajectory_write_ahead
               WHERE subject_id = ? AND turn_id = ?`,
              [record.subjectId, record.turnId],
            ),
            "discard revoked trajectory",
          );
          this.emit({
            outcome: "rejected",
            record,
            failureClass: afterWriteAhead.failureClass,
            retryCount: attempt,
          });
          return;
        }

        await this.storage(
          this.driver.execute(
            `INSERT OR IGNORE INTO turn_trajectories
             (subject_id, turn_id, device_id, consent_record_id, captured_at, locality, payload_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              record.subjectId,
              record.turnId,
              record.deviceId,
              record.consentRecordId,
              record.capturedAt,
              record.locality,
              JSON.stringify(record),
            ],
          ),
          "persist final trajectory",
        );
        await this.storage(
          this.driver.execute(
            `DELETE FROM trajectory_write_ahead
             WHERE subject_id = ? AND turn_id = ?`,
            [record.subjectId, record.turnId],
          ),
          "complete trajectory write-ahead",
        );
        this.emit({
          outcome: "persisted",
          record,
          retryCount: attempt,
        });
        return;
      } catch (error: unknown) {
        lastFailure =
          error instanceof TrajectoryStorageError
            ? error
            : new TrajectoryStorageError(
                "storage_failed",
                error instanceof Error ? error.name : "unknown storage failure",
              );
        if (attempt < this.maxRetries) {
          this.emit({
            outcome: "retrying",
            record,
            failureClass: lastFailure.failureClass,
            retryCount: attempt + 1,
          });
        }
      }
    }

    this.emit({
      outcome: "rejected",
      record,
      failureClass: lastFailure?.failureClass ?? "storage_failed",
      retryCount: this.maxRetries,
    });
  }

  private async recoverPending(): Promise<void> {
    const rows = await this.storage(
      this.driver.query<{ payload_json: string }>(
        `SELECT payload_json FROM trajectory_write_ahead
         WHERE subject_id = ? ORDER BY enqueued_at ASC LIMIT ?`,
        [this.boundSubjectId, this.capacity],
      ),
      "recover trajectory write-ahead",
    );
    for (const row of rows) {
      if (this.queueDepth >= this.capacity) break;
      let raw: unknown;
      try {
        raw = JSON.parse(row.payload_json);
      } catch {
        this.emit({
          outcome: "rejected",
          subjectId: this.boundSubjectId,
          failureClass: "recovery_invalid",
        });
        continue;
      }
      const parsed = parseTurnTrajectoryV1(raw);
      if (!parsed.ok || parsed.record.subjectId !== this.boundSubjectId) {
        this.emit({
          outcome: "rejected",
          subjectId: this.boundSubjectId,
          failureClass:
            parsed.ok === false ? parsed.failureClass : "cross_subject",
        });
        continue;
      }
      if (parsed.record.locality !== this.locality) {
        this.emit({
          outcome: "rejected",
          record: parsed.record,
          failureClass: "locality_mismatch",
        });
        continue;
      }
      if (!this.admittedKeys.has(this.key(parsed.record))) {
        this.admit(parsed.record, true);
      }
    }
  }

  private checkConsent(record: TurnTrajectoryV1): ConsentCheck {
    let consent: TrajectoryCaptureConsent | null | undefined;
    try {
      consent = this.resolveConsent(record.consentRecordId);
    } catch (error: unknown) {
      return {
        ok: false,
        failureClass: "consent_resolve_failed",
        detail:
          error instanceof Error
            ? `consent resolver failed: ${error.name}`
            : "consent resolver failed",
      };
    }
    if (!consent || consent.consentRecordId !== record.consentRecordId) {
      return {
        ok: false,
        failureClass: "consent_missing",
        detail: "trajectory consent record not found",
      };
    }
    if (consent.subjectId !== record.subjectId) {
      return {
        ok: false,
        failureClass: "cross_subject",
        detail: "trajectory consent subject does not match record",
      };
    }
    if (consent.scope !== "trajectory") {
      return {
        ok: false,
        failureClass: "consent_scope_invalid",
        detail: "trajectory consent scope required",
      };
    }
    if (!consent.active || !consent.optedIn) {
      return {
        ok: false,
        failureClass: "consent_denied",
        detail: "trajectory capture requires active opt-in",
      };
    }
    return { ok: true };
  }

  private reject(
    failureClass: TrajectoryWriterFailureClass,
    subjectId: string | null,
    record: TurnTrajectoryV1 | undefined,
    detail: string,
  ): CaptureTrajectoryResult {
    this.emit({
      outcome: "rejected",
      subjectId: subjectId ?? this.boundSubjectId,
      ...(record === undefined ? {} : { record }),
      failureClass,
    });
    return { queued: false, failureClass, subjectId, detail };
  }

  private key(record: TurnTrajectoryV1): string {
    return `${record.subjectId}\u0000${record.turnId}`;
  }

  private emit(
    input:
      | {
          outcome: TrajectoryWriterEvent["outcome"];
          record: TurnTrajectoryV1;
          failureClass?: TrajectoryWriterFailureClass;
          queueDepth?: number;
          retryCount?: number;
        }
      | {
          outcome: TrajectoryWriterEvent["outcome"];
          subjectId: string;
          failureClass?: TrajectoryWriterFailureClass;
          queueDepth?: number;
          retryCount?: number;
        },
  ): void {
    if (!this.onTelemetry) return;
    const hasRecord = "record" in input;
    const record = hasRecord ? input.record : undefined;
    const subjectId = hasRecord ? input.record.subjectId : input.subjectId;
    const event: TrajectoryWriterEvent = {
      event: "telemetry.trajectory.capture",
      outcome: input.outcome,
      subjectId,
      ...(record === undefined
        ? {}
        : {
            deviceId: record.deviceId,
            turnId: record.turnId,
          }),
      ...(input.failureClass === undefined
        ? {}
        : { failureClass: input.failureClass }),
      ...(input.queueDepth === undefined
        ? {}
        : { queueDepth: input.queueDepth }),
      ...(input.retryCount === undefined
        ? {}
        : { retryCount: input.retryCount }),
    };
    try {
      this.onTelemetry(event);
    } catch (error: unknown) {
      console.error(
        JSON.stringify({
          event: "telemetry.trajectory.capture.observer",
          outcome: "rejected",
          subjectId,
          deviceId: event.deviceId,
          failureClass:
            error instanceof Error ? error.name.slice(0, 64) : "observer_failed",
        }),
      );
    }
  }

  private async storage<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation.catch((error: unknown) => {
          throw new TrajectoryStorageError(
            "storage_failed",
            `${label}: ${error instanceof Error ? error.name : "unknown error"}`,
          );
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new TrajectoryStorageError(
                  "storage_timeout",
                  `${label} timed out after ${this.storageTimeoutMs}ms`,
                ),
              ),
            this.storageTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
