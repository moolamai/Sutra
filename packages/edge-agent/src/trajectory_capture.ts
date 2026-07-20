/**
 * Edge-owned trajectory writer.
 *
 * The adapter binds the shared write-ahead queue to exactly one subject and
 * one sovereign locality. Loop-hook integration is intentionally separate.
 */

import type { StorageDriver } from "@moolam/contracts";
import {
  TrajectoryWriteAheadQueue,
  type CaptureTrajectoryResult,
  type TrajectoryCaptureConsent,
  type TrajectoryWriterEvent,
} from "@moolam/telemetry";
import type {
  HLCTimestamp,
  TurnTrajectoryV1,
} from "@moolam/sync-protocol";

const TRAJECTORY_CONTENT_HASH_MAX_BYTES = 64_000;

export type EdgeTrajectoryCaptureWriterOptions = {
  storage: StorageDriver;
  subjectId: string;
  deviceId: string;
  locality?: TurnTrajectoryV1["locality"];
  /** Resolve the current active record; null means capture is disabled. */
  resolveActiveConsentRecordId: () => string | null | undefined;
  resolveConsent: (
    consentRecordId: string,
  ) => TrajectoryCaptureConsent | null | undefined;
  capacity?: number;
  storageTimeoutMs?: number;
  maxRetries?: number;
  onTelemetry?: (event: TrajectoryWriterEvent) => void;
  onHookTelemetry?: (event: EdgeTrajectoryCaptureHookEvent) => void;
};

export type EdgeTrajectoryCaptureHookInput = {
  turnId: string;
  subjectId: string;
  deviceId: string;
  sessionId: string;
  capturedAt: HLCTimestamp;
  utterance: string;
  reply: string;
  modelId: string;
  declined: boolean;
};

export type EdgeTrajectoryCaptureHookEvent = {
  event: "edge_agent.trajectory_capture";
  outcome: "scheduled" | "skipped" | "queued" | "rejected";
  subjectId: string;
  deviceId: string;
  turnId: string;
  failureClass?:
    | "consent_missing"
    | "consent_resolve_failed"
    | "cross_subject"
    | "cross_device"
    | "content_too_large"
    | "hash_failed"
    | string;
};

export type ScheduleTrajectoryCaptureResult =
  | { scheduled: true; subjectId: string; turnId: string }
  | {
      scheduled: false;
      subjectId: string;
      turnId: string;
      failureClass: string;
    };

/**
 * Subject-scoped SQLite trajectory persistence for an edge installation.
 *
 * `captureTrajectory` is synchronous: it only admits to the bounded queue.
 * Durable write-ahead and final inserts run in the background.
 */
export class EdgeTrajectoryCaptureWriter {
  private readonly queue: TrajectoryWriteAheadQueue;
  private readonly subjectId: string;
  private readonly deviceId: string;
  private readonly locality: TurnTrajectoryV1["locality"];
  private readonly resolveActiveConsentRecordId: EdgeTrajectoryCaptureWriterOptions["resolveActiveConsentRecordId"];
  private readonly onHookTelemetry:
    | ((event: EdgeTrajectoryCaptureHookEvent) => void)
    | undefined;
  private readonly pendingBuilds = new Set<Promise<void>>();

  constructor(options: EdgeTrajectoryCaptureWriterOptions) {
    this.subjectId = options.subjectId.trim();
    this.deviceId = options.deviceId.trim();
    this.locality = options.locality ?? "on-device";
    if (!this.deviceId) {
      throw new Error("edge trajectory writer deviceId is required");
    }
    this.resolveActiveConsentRecordId = options.resolveActiveConsentRecordId;
    this.onHookTelemetry = options.onHookTelemetry;
    this.queue = new TrajectoryWriteAheadQueue({
      driver: options.storage,
      subjectId: this.subjectId,
      locality: this.locality,
      resolveConsent: options.resolveConsent,
      ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
      ...(options.storageTimeoutMs === undefined
        ? {}
        : { storageTimeoutMs: options.storageTimeoutMs }),
      ...(options.maxRetries === undefined
        ? {}
        : { maxRetries: options.maxRetries }),
      ...(options.onTelemetry === undefined
        ? {}
        : { onTelemetry: options.onTelemetry }),
    });
  }

  async initialize(): Promise<void> {
    await this.queue.initialize();
  }

  captureTrajectory(input: unknown): CaptureTrajectoryResult {
    return this.queue.captureTrajectory(input);
  }

  /**
   * Completion hook invoked only after CognitiveCore's reflect stage resolves.
   *
   * Consent is resolved before hashing. Hashing and queue persistence continue
   * asynchronously, so the completed turn never awaits trajectory I/O.
   */
  captureAfterReflect(
    input: EdgeTrajectoryCaptureHookInput,
  ): ScheduleTrajectoryCaptureResult {
    if (input.subjectId !== this.subjectId) {
      return this.rejectHook(input, "cross_subject");
    }
    if (input.deviceId !== this.deviceId) {
      return this.rejectHook(input, "cross_device");
    }

    let consentRecordId: string;
    try {
      consentRecordId = this.resolveActiveConsentRecordId()?.trim() ?? "";
    } catch {
      return this.rejectHook(input, "consent_resolve_failed");
    }
    if (!consentRecordId) {
      this.emitHook(input, "skipped", "consent_missing");
      return {
        scheduled: false,
        subjectId: input.subjectId,
        turnId: input.turnId,
        failureClass: "consent_missing",
      };
    }

    const promptBytes = new TextEncoder().encode(input.utterance);
    const responseBytes = new TextEncoder().encode(input.reply);
    if (
      promptBytes.byteLength > TRAJECTORY_CONTENT_HASH_MAX_BYTES ||
      responseBytes.byteLength > TRAJECTORY_CONTENT_HASH_MAX_BYTES
    ) {
      return this.rejectHook(input, "content_too_large");
    }

    const build = Promise.all([
      sha256Hex(promptBytes),
      sha256Hex(responseBytes),
    ])
      .then(([promptHash, responseHash]) => {
        const record: TurnTrajectoryV1 = {
          trajectoryFormatVersion: "trajectory.v1",
          turnId: input.turnId,
          subjectId: input.subjectId,
          deviceId: input.deviceId,
          sessionId: input.sessionId,
          capturedAt: input.capturedAt,
          locality: this.locality,
          consentRecordId,
          stages: [
            { stage: "perceive", status: "ok", chunkIndex: 0 },
            { stage: "reason", status: "ok", chunkIndex: 0 },
            {
              stage: "act",
              status: input.declined ? "skipped" : "ok",
              chunkIndex: 0,
            },
          ],
          toolCalls: [],
          outcomes: {
            status: "completed",
            terminalStage: input.declined ? "reason" : "act",
          },
          modelId: input.modelId,
          promptHash,
          responseHash,
          promptByteLength: promptBytes.byteLength,
          responseByteLength: responseBytes.byteLength,
        };
        const result = this.queue.captureTrajectory(record);
        this.emitHook(
          input,
          result.queued ? "queued" : "rejected",
          result.queued ? undefined : result.failureClass,
        );
      })
      .catch(() => {
        this.emitHook(input, "rejected", "hash_failed");
      })
      .finally(() => {
        this.pendingBuilds.delete(build);
      });
    this.pendingBuilds.add(build);
    this.emitHook(input, "scheduled");
    return {
      scheduled: true,
      subjectId: input.subjectId,
      turnId: input.turnId,
    };
  }

  async flush(timeoutMs?: number): Promise<boolean> {
    await Promise.allSettled([...this.pendingBuilds]);
    return timeoutMs === undefined
      ? await this.queue.flush()
      : await this.queue.flush(timeoutMs);
  }

  get queueDepth(): number {
    return this.queue.queueDepth;
  }

  get droppedCount(): number {
    return this.queue.droppedCount;
  }

  private rejectHook(
    input: EdgeTrajectoryCaptureHookInput,
    failureClass: string,
  ): ScheduleTrajectoryCaptureResult {
    this.emitHook(input, "rejected", failureClass);
    return {
      scheduled: false,
      subjectId: input.subjectId,
      turnId: input.turnId,
      failureClass,
    };
  }

  private emitHook(
    input: EdgeTrajectoryCaptureHookInput,
    outcome: EdgeTrajectoryCaptureHookEvent["outcome"],
    failureClass?: string,
  ): void {
    if (!this.onHookTelemetry) return;
    const event: EdgeTrajectoryCaptureHookEvent = {
      event: "edge_agent.trajectory_capture",
      outcome,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      turnId: input.turnId,
      ...(failureClass === undefined ? {} : { failureClass }),
    };
    try {
      this.onHookTelemetry(event);
    } catch (error: unknown) {
      console.error(
        JSON.stringify({
          event: "edge_agent.trajectory_capture.observer",
          outcome: "rejected",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
          failureClass:
            error instanceof Error ? error.name.slice(0, 64) : "observer_failed",
        }),
      );
    }
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
