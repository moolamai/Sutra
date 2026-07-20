/**
 * Trajectory queue — record schema + local encrypted transport (C4).
 *
 * Bounded FIFO between rollout workers and the GRPO trainer.
 * Sovereign default: filesystem queue with AES-256-GCM at-rest encryption
 * (SQLite-shaped layout: meta + ordered index + encrypted payload blobs).
 *
 * Every record carries policyCheckpointHash + enqueuedAt (staleness).
 * Enqueue applies the B9 consent-class gate — no trajectory enters without a
 * recorded consent class matching the export tier.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  evaluateTrajectoryConsent,
  type ConsentClass,
  type SubjectConsentLedger,
} from "./consent_gate.js";
import {
  TRAJECTORY_HASH_LIMIT,
  TRAJECTORY_ID_LIMIT,
  TRAJECTORY_SCHEMA_VERSION,
  parseTurnTrajectoryRecord,
  type TrajectoryConsent,
  type TrajectoryConsentClass,
  type TrajectoryLocality,
  type TurnTrajectoryRecord,
} from "./trajectory_schema.js";
import {
  isTrajectoryQueueRedisStreamEnabled,
  openRedisStreamTrajectoryQueue,
  type TrajectoryQueueRedisStreamClient,
} from "./trajectory_queue_redis.js";

export const TRAJECTORY_QUEUE_RECORD_SCHEMA_VERSION =
  "trajectory.queue-record.v1" as const;
export const TRAJECTORY_QUEUE_META_SCHEMA_VERSION =
  "trajectory.queue-meta.v1" as const;

export const TRAJECTORY_QUEUE_DEFAULT_MAX_DEPTH = 256;
export const TRAJECTORY_QUEUE_MAX_DEPTH_CAP = 4096;
export const TRAJECTORY_QUEUE_DEQUEUE_BATCH_LIMIT = 32;

export const TRAJECTORY_QUEUE_TRANSPORT_RELPATH =
  "training/pipeline/queue_transport.ts" as const;
export const TRAJECTORY_QUEUE_LOCAL_DIR_RELPATH =
  "training/pipeline/local_queue" as const;

const policyCheckpointHashSchema = z
  .string()
  .min(8)
  .max(TRAJECTORY_HASH_LIMIT)
  .regex(/^[A-Za-z0-9:_+-]+$/, "policyCheckpointHash must be opaque hash id")
  .refine(
    (h) => h.toLowerCase() !== "latest",
    "policyCheckpointHash must bind an exact checkpoint — not floating 'latest'",
  );

export const trajectoryQueueRecordSchema = z
  .object({
    schemaVersion: z.literal(TRAJECTORY_QUEUE_RECORD_SCHEMA_VERSION),
    queueRecordId: z.string().min(1).max(TRAJECTORY_ID_LIMIT),
    subjectId: z.string().min(1).max(TRAJECTORY_ID_LIMIT),
    deviceId: z.string().min(1).max(TRAJECTORY_ID_LIMIT),
    enqueuedAt: z.string().min(1).max(TRAJECTORY_HASH_LIMIT),
    policyCheckpointHash: policyCheckpointHashSchema,
    consentClass: z.enum(["research", "product-improve", "personal"]),
    locality: z.enum(["on-device", "self-hosted"]),
    trajectorySchemaVersion: z.literal(TRAJECTORY_SCHEMA_VERSION),
    trajectory: z.unknown(),
  })
  .strict();

export type TrajectoryQueueRecord = {
  schemaVersion: typeof TRAJECTORY_QUEUE_RECORD_SCHEMA_VERSION;
  queueRecordId: string;
  subjectId: string;
  deviceId: string;
  enqueuedAt: string;
  policyCheckpointHash: string;
  consentClass: TrajectoryConsentClass;
  locality: TrajectoryLocality;
  trajectorySchemaVersion: typeof TRAJECTORY_SCHEMA_VERSION;
  trajectory: TurnTrajectoryRecord;
};

export type TrajectoryQueueFailureClass =
  | "queue.schema_violation"
  | "queue.missing_consent_class"
  | "queue.consent_denied"
  | "queue.unknown_consent_class"
  | "queue.consent_tier_mismatch"
  | "queue.consent_revoked"
  | "queue.consent_mismatch"
  | "queue.missing_checkpoint_hash"
  | "queue.floating_checkpoint"
  | "queue.full"
  | "queue.empty"
  | "queue.subject_scope"
  | "queue.decrypt_failed"
  | "queue.corrupt_index"
  | "queue.idempotent_conflict"
  | "queue.section_limit"
  | "queue.redis_unavailable";

export type TrajectoryQueueConsentGateOptions = {
  /** When set, only these B9 classes may enter the training queue. */
  allowedConsentClasses?: readonly TrajectoryConsentClass[];
  /** Teacher distillation involving third-party frontier APIs. */
  requiresThirdPartyProcessing?: boolean;
  /** Subject revocation ledger — revoked subjects cannot enqueue. */
  ledger?: SubjectConsentLedger;
};

export type TrajectoryQueueTelemetryEvent = {
  event:
    | "learning.trajectory_queue.enqueue"
    | "learning.trajectory_queue.dequeue"
    | "learning.trajectory_queue.open"
    | "learning.trajectory_queue.stall"
    | "learning.trajectory_queue.consent_gate";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  queueRecordId?: string;
  policyCheckpointHash?: string;
  consentClass?: TrajectoryConsentClass;
  depth?: number;
  maxDepth?: number;
  transport?: "local-encrypted" | "redis-stream";
  failureClass?: TrajectoryQueueFailureClass;
  idempotentReplay?: boolean;
};

export class TrajectoryQueueContractError extends Error {
  readonly obligation: TrajectoryQueueFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: TrajectoryQueueFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "TrajectoryQueueContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

export type TrajectoryQueueIndexEntry = {
  seq: number;
  queueRecordId: string;
  subjectId: string;
  deviceId: string;
  enqueuedAt: string;
  policyCheckpointHash: string;
  consentClass: TrajectoryConsentClass;
  locality: TrajectoryLocality;
};

type QueueMeta = {
  schemaVersion: typeof TRAJECTORY_QUEUE_META_SCHEMA_VERSION;
  maxDepth: number;
  nextSeq: number;
  saltHex: string;
  keyFingerprint: string;
  transport: "local-encrypted";
};

export type TrajectoryQueueTransport = {
  readonly kind: "local-encrypted" | "redis-stream";
  readonly rootDir: string;
  readonly maxDepth: number;
  depth(): number;
  enqueue(input: {
    trajectory: TurnTrajectoryRecord;
    queueRecordId?: string;
    enqueuedAt?: string;
    deviceId?: string;
  } & TrajectoryQueueConsentGateOptions): {
    queued: true;
    record: TrajectoryQueueRecord;
    depth: number;
    idempotentReplay: boolean;
  };
  dequeue(opts?: { subjectId?: string }):
    | { dequeued: true; record: TrajectoryQueueRecord; depth: number }
    | { dequeued: false; reason: "empty"; depth: number };
  peekMeta(limit?: number): TrajectoryQueueIndexEntry[];
  close(): void;
};

function mapConsentFailureToQueueObligation(
  failureClass: string,
): TrajectoryQueueFailureClass {
  switch (failureClass) {
    case "missing_consent":
      return "queue.missing_consent_class";
    case "consent_denied":
      return "queue.consent_denied";
    case "unknown_consent_class":
      return "queue.unknown_consent_class";
    case "third_party_excluded":
      return "queue.consent_tier_mismatch";
    case "consent_revoked":
      return "queue.consent_revoked";
    case "cross_subject":
    case "missing_subject":
      return "queue.subject_scope";
    default:
      return "queue.missing_consent_class";
  }
}

/**
 * B9 consent-class gate for trajectory queue enqueue.
 * Rejects missing consent, opt-out, unknown class, revoked subjects, and
 * mismatched training tiers. Runs before any durable queue write.
 */
export function assertTrajectoryQueueEnqueueConsent(
  input: {
    subjectId: string;
    consent: TrajectoryConsent | null | undefined;
    deviceId?: string;
  } & TrajectoryQueueConsentGateOptions,
  opts?: {
    onTelemetry?: (e: TrajectoryQueueTelemetryEvent) => void;
  },
): { ok: true; consentClass: ConsentClass } {
  const deviceId = input.deviceId ?? "unknown";
  const gate = evaluateTrajectoryConsent(
    {
      subjectId: input.subjectId,
      consent: input.consent,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input.requiresThirdPartyProcessing !== undefined
        ? {
            requiresThirdPartyProcessing: input.requiresThirdPartyProcessing,
          }
        : {}),
      ...(input.ledger !== undefined ? { ledger: input.ledger } : {}),
    },
    {
      subjectId: input.subjectId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    },
  );

  if (!gate.ok) {
    const obligation = mapConsentFailureToQueueObligation(gate.failureClass);
    opts?.onTelemetry?.({
      event: "learning.trajectory_queue.consent_gate",
      outcome: "fail",
      subjectId: gate.subjectId ?? input.subjectId ?? "unknown",
      deviceId,
      failureClass: obligation,
    });
    throw new TrajectoryQueueContractError(
      `trajectory queue consent gate rejected: ${gate.detail}`,
      {
        obligation,
        ...(gate.subjectId ? { subjectId: gate.subjectId } : {}),
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        failingSlice: gate.failureClass,
      },
    );
  }

  if (
    input.allowedConsentClasses !== undefined &&
    input.allowedConsentClasses.length > 0
  ) {
    if (input.allowedConsentClasses.length > 8) {
      throw new TrajectoryQueueContractError(
        "allowedConsentClasses exceeds section limit",
        { obligation: "queue.section_limit", subjectId: input.subjectId },
      );
    }
    if (
      !(input.allowedConsentClasses as readonly string[]).includes(
        gate.consentClass,
      )
    ) {
      opts?.onTelemetry?.({
        event: "learning.trajectory_queue.consent_gate",
        outcome: "fail",
        subjectId: input.subjectId,
        deviceId,
        consentClass: gate.consentClass,
        failureClass: "queue.consent_tier_mismatch",
      });
      throw new TrajectoryQueueContractError(
        `consent class '${gate.consentClass}' is not in the allowed training tier`,
        {
          obligation: "queue.consent_tier_mismatch",
          subjectId: input.subjectId,
          ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
          failingSlice: gate.consentClass,
        },
      );
    }
  }

  opts?.onTelemetry?.({
    event: "learning.trajectory_queue.consent_gate",
    outcome: "ok",
    subjectId: input.subjectId,
    deviceId,
    consentClass: gate.consentClass,
  });

  return { ok: true, consentClass: gate.consentClass };
}

/**
 * Build + validate a queue record wrapping a C0 trajectory.
 * Applies B9 consent-class gate; requires non-floating policyCheckpointHash.
 */
export function buildTrajectoryQueueRecord(input: {
  trajectory: TurnTrajectoryRecord;
  queueRecordId: string;
  enqueuedAt: string;
  deviceId?: string;
  onTelemetry?: (e: TrajectoryQueueTelemetryEvent) => void;
} & TrajectoryQueueConsentGateOptions): TrajectoryQueueRecord {
  // Consent gate runs on wire-shaped consent fields before / independent of
  // full trajectory schema — so unknown-class and opt-out fail with distinct
  // obligations (not a generic schema_violation).
  const raw = input.trajectory as {
    subjectId?: string;
    consent?: TrajectoryConsent | null;
    deviceId?: string;
  };
  const gated = assertTrajectoryQueueEnqueueConsent(
    {
      subjectId: typeof raw.subjectId === "string" ? raw.subjectId : "",
      consent: raw.consent,
      ...(input.deviceId !== undefined
        ? { deviceId: input.deviceId }
        : raw.deviceId !== undefined
          ? { deviceId: raw.deviceId }
          : {}),
      ...(input.allowedConsentClasses !== undefined
        ? { allowedConsentClasses: input.allowedConsentClasses }
        : {}),
      ...(input.requiresThirdPartyProcessing !== undefined
        ? {
            requiresThirdPartyProcessing: input.requiresThirdPartyProcessing,
          }
        : {}),
      ...(input.ledger !== undefined ? { ledger: input.ledger } : {}),
    },
    {
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    },
  );

  const parsed = parseTurnTrajectoryRecord(input.trajectory);
  if (!parsed.ok) {
    throw new TrajectoryQueueContractError(
      `trajectory parse failed: ${parsed.detail}`,
      {
        obligation: "queue.schema_violation",
        failingSlice: parsed.failureClass,
        ...(parsed.subjectId ? { subjectId: parsed.subjectId } : {}),
      },
    );
  }
  const trajectory = parsed.record;
  const subjectId = trajectory.subjectId;

  if (trajectory.consent.consentClass !== gated.consentClass) {
    throw new TrajectoryQueueContractError(
      "queue consentClass must match B9 gate result",
      {
        obligation: "queue.consent_mismatch",
        subjectId,
        failingSlice: trajectory.consent.consentClass,
      },
    );
  }

  const policyCheckpointHash = trajectory.policyCheckpointHash;
  if (!policyCheckpointHash) {
    throw new TrajectoryQueueContractError(
      "policyCheckpointHash required on queued trajectory",
      { obligation: "queue.missing_checkpoint_hash", subjectId },
    );
  }
  if (policyCheckpointHash.toLowerCase() === "latest") {
    throw new TrajectoryQueueContractError(
      "floating policyCheckpointHash 'latest' is forbidden",
      { obligation: "queue.floating_checkpoint", subjectId },
    );
  }

  if (!isIsoTimestamp(input.enqueuedAt)) {
    throw new TrajectoryQueueContractError(
      "enqueuedAt must be an ISO timestamp",
      {
        obligation: "queue.schema_violation",
        subjectId,
        failingSlice: "enqueuedAt",
      },
    );
  }

  if (
    !input.queueRecordId ||
    input.queueRecordId.length === 0 ||
    input.queueRecordId.length > TRAJECTORY_ID_LIMIT
  ) {
    throw new TrajectoryQueueContractError("queueRecordId required", {
      obligation: "queue.schema_violation",
      subjectId,
    });
  }

  const deviceId =
    input.deviceId ??
    (typeof trajectory.deviceId === "string" && trajectory.deviceId.length > 0
      ? trajectory.deviceId
      : "unknown");

  const record: TrajectoryQueueRecord = {
    schemaVersion: TRAJECTORY_QUEUE_RECORD_SCHEMA_VERSION,
    queueRecordId: input.queueRecordId,
    subjectId,
    deviceId,
    enqueuedAt: input.enqueuedAt,
    policyCheckpointHash,
    consentClass: gated.consentClass,
    locality: trajectory.locality,
    trajectorySchemaVersion: TRAJECTORY_SCHEMA_VERSION,
    trajectory,
  };

  const wireCheck = trajectoryQueueRecordSchema.safeParse({
    ...record,
    trajectory: record.trajectory,
  });
  if (!wireCheck.success) {
    throw new TrajectoryQueueContractError(
      `queue record schema violation: ${wireCheck.error.issues[0]?.message ?? "invalid"}`,
      {
        obligation: "queue.schema_violation",
        subjectId,
        failingSlice: wireCheck.error.issues[0]?.path.join(".") || "record",
      },
    );
  }

  return record;
}

function assertFiniteDepth(maxDepth: number): number {
  if (
    typeof maxDepth !== "number" ||
    !Number.isInteger(maxDepth) ||
    maxDepth < 1 ||
    maxDepth > TRAJECTORY_QUEUE_MAX_DEPTH_CAP
  ) {
    throw new TrajectoryQueueContractError(
      `maxDepth must be an integer in [1, ${TRAJECTORY_QUEUE_MAX_DEPTH_CAP}]`,
      { obligation: "queue.section_limit" },
    );
  }
  return maxDepth;
}

function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function deriveKey(passphrase: string | Buffer, salt: Buffer): Buffer {
  const secret =
    typeof passphrase === "string"
      ? Buffer.from(passphrase, "utf8")
      : passphrase;
  if (secret.length < 8) {
    throw new TrajectoryQueueContractError(
      "encryption key material must be at least 8 bytes",
      { obligation: "queue.schema_violation" },
    );
  }
  return scryptSync(secret, salt, 32);
}

function encryptPayload(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

function decryptPayload(key: Buffer, blob: Buffer): string {
  if (blob.length < 12 + 16 + 1) {
    throw new TrajectoryQueueContractError("encrypted blob too short", {
      obligation: "queue.decrypt_failed",
    });
  }
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new TrajectoryQueueContractError(
      "trajectory queue decrypt failed (wrong key or corrupt blob)",
      { obligation: "queue.decrypt_failed" },
    );
  }
}

function atomicWriteFile(abs: string, data: string | Buffer): void {
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, abs);
}

function isIsoTimestamp(value: string): boolean {
  if (value.length < 10 || value.length > TRAJECTORY_HASH_LIMIT) return false;
  return Number.isFinite(Date.parse(value));
}

function parseIndex(raw: string): TrajectoryQueueIndexEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TrajectoryQueueContractError("queue index is not valid JSON", {
      obligation: "queue.corrupt_index",
    });
  }
  if (!Array.isArray(parsed)) {
    throw new TrajectoryQueueContractError("queue index must be an array", {
      obligation: "queue.corrupt_index",
    });
  }
  if (parsed.length > TRAJECTORY_QUEUE_MAX_DEPTH_CAP) {
    throw new TrajectoryQueueContractError("queue index exceeds section limit", {
      obligation: "queue.section_limit",
    });
  }
  return parsed as TrajectoryQueueIndexEntry[];
}

/**
 * Open (or create) a local AES-256-GCM encrypted trajectory queue.
 */
export function openLocalEncryptedTrajectoryQueue(opts: {
  rootDir: string;
  keyMaterial: string | Buffer;
  maxDepth?: number;
  /** Default B9 consent-class gate options applied on every enqueue. */
  consentGate?: TrajectoryQueueConsentGateOptions;
  onTelemetry?: (e: TrajectoryQueueTelemetryEvent) => void;
}): TrajectoryQueueTransport {
  const rootDir = path.resolve(opts.rootDir);
  const maxDepth = assertFiniteDepth(
    opts.maxDepth ?? TRAJECTORY_QUEUE_DEFAULT_MAX_DEPTH,
  );
  const onTelemetry = opts.onTelemetry;
  const defaultConsentGate = opts.consentGate;

  mkdirSync(path.join(rootDir, "records"), { recursive: true });

  const metaPath = path.join(rootDir, "queue.meta.json");
  const indexPath = path.join(rootDir, "queue.index.json");

  let meta: QueueMeta;
  let key: Buffer;

  if (existsSync(metaPath)) {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as QueueMeta;
    if (meta.schemaVersion !== TRAJECTORY_QUEUE_META_SCHEMA_VERSION) {
      throw new TrajectoryQueueContractError(
        "unsupported trajectory queue meta schema",
        { obligation: "queue.schema_violation" },
      );
    }
    meta = { ...meta, maxDepth };
    atomicWriteFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    const salt = Buffer.from(meta.saltHex, "hex");
    key = deriveKey(opts.keyMaterial, salt);
    if (keyFingerprint(key) !== meta.keyFingerprint) {
      throw new TrajectoryQueueContractError(
        "encryption key fingerprint mismatch",
        { obligation: "queue.decrypt_failed" },
      );
    }
  } else {
    const salt = randomBytes(16);
    key = deriveKey(opts.keyMaterial, salt);
    meta = {
      schemaVersion: TRAJECTORY_QUEUE_META_SCHEMA_VERSION,
      maxDepth,
      nextSeq: 1,
      saltHex: salt.toString("hex"),
      keyFingerprint: keyFingerprint(key),
      transport: "local-encrypted",
    };
    atomicWriteFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    atomicWriteFile(indexPath, "[]\n");
  }

  if (!existsSync(indexPath)) {
    atomicWriteFile(indexPath, "[]\n");
  }

  let closed = false;
  const subjectLocks = new Map<string, number>();

  function readIndex(): TrajectoryQueueIndexEntry[] {
    return parseIndex(readFileSync(indexPath, "utf8"));
  }

  function writeIndex(entries: TrajectoryQueueIndexEntry[]): void {
    atomicWriteFile(indexPath, `${JSON.stringify(entries)}\n`);
  }

  function writeMeta(next: QueueMeta): void {
    meta = next;
    atomicWriteFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  }

  function assertOpen(): void {
    if (closed) {
      throw new TrajectoryQueueContractError("trajectory queue is closed", {
        obligation: "queue.schema_violation",
      });
    }
  }

  function withSubjectLockSync<T>(subjectId: string, work: () => T): T {
    const depth = subjectLocks.get(subjectId) ?? 0;
    subjectLocks.set(subjectId, depth + 1);
    try {
      return work();
    } finally {
      const next = (subjectLocks.get(subjectId) ?? 1) - 1;
      if (next <= 0) subjectLocks.delete(subjectId);
      else subjectLocks.set(subjectId, next);
    }
  }

  const transport: TrajectoryQueueTransport = {
    kind: "local-encrypted",
    rootDir,
    maxDepth,

    depth(): number {
      assertOpen();
      return readIndex().length;
    },

    enqueue(input) {
      assertOpen();
      const enqueuedAt = input.enqueuedAt ?? new Date().toISOString();
      const queueRecordId =
        input.queueRecordId ??
        `qr.${Date.now().toString(36)}.${randomBytes(4).toString("hex")}`;

      const record = buildTrajectoryQueueRecord({
        trajectory: input.trajectory,
        queueRecordId,
        enqueuedAt,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        ...(onTelemetry !== undefined ? { onTelemetry } : {}),
        ...(input.allowedConsentClasses !== undefined
          ? { allowedConsentClasses: input.allowedConsentClasses }
          : defaultConsentGate?.allowedConsentClasses !== undefined
            ? {
                allowedConsentClasses: defaultConsentGate.allowedConsentClasses,
              }
            : {}),
        ...(input.requiresThirdPartyProcessing !== undefined
          ? {
              requiresThirdPartyProcessing: input.requiresThirdPartyProcessing,
            }
          : defaultConsentGate?.requiresThirdPartyProcessing !== undefined
            ? {
                requiresThirdPartyProcessing:
                  defaultConsentGate.requiresThirdPartyProcessing,
              }
            : {}),
        ...(input.ledger !== undefined
          ? { ledger: input.ledger }
          : defaultConsentGate?.ledger !== undefined
            ? { ledger: defaultConsentGate.ledger }
            : {}),
      });

      return withSubjectLockSync(record.subjectId, () => {
        const index = readIndex();
        const existing = index.find((e) => e.queueRecordId === queueRecordId);
        if (existing) {
          if (
            existing.subjectId !== record.subjectId ||
            existing.policyCheckpointHash !== record.policyCheckpointHash
          ) {
            onTelemetry?.({
              event: "learning.trajectory_queue.enqueue",
              outcome: "fail",
              subjectId: record.subjectId,
              deviceId: record.deviceId,
              queueRecordId,
              failureClass: "queue.idempotent_conflict",
            });
            throw new TrajectoryQueueContractError(
              `idempotent enqueue conflict for ${queueRecordId}`,
              {
                obligation: "queue.idempotent_conflict",
                subjectId: record.subjectId,
                deviceId: record.deviceId,
                failingSlice: queueRecordId,
              },
            );
          }
          onTelemetry?.({
            event: "learning.trajectory_queue.enqueue",
            outcome: "ok",
            subjectId: record.subjectId,
            deviceId: record.deviceId,
            queueRecordId,
            policyCheckpointHash: record.policyCheckpointHash,
            consentClass: record.consentClass,
            depth: index.length,
            maxDepth,
            transport: "local-encrypted",
            idempotentReplay: true,
          });
          return {
            queued: true as const,
            record,
            depth: index.length,
            idempotentReplay: true,
          };
        }

        if (index.length >= maxDepth) {
          onTelemetry?.({
            event: "learning.trajectory_queue.stall",
            outcome: "fail",
            subjectId: record.subjectId,
            deviceId: record.deviceId,
            depth: index.length,
            maxDepth,
            transport: "local-encrypted",
            failureClass: "queue.full",
          });
          throw new TrajectoryQueueContractError(
            `trajectory queue full (depth=${index.length}, maxDepth=${maxDepth}) — backpressure; consented trajectory not dropped`,
            {
              obligation: "queue.full",
              subjectId: record.subjectId,
              deviceId: record.deviceId,
            },
          );
        }

        const seq = meta.nextSeq;
        const blobPath = path.join(rootDir, "records", `${queueRecordId}.enc`);
        atomicWriteFile(blobPath, encryptPayload(key, JSON.stringify(record)));

        index.push({
          seq,
          queueRecordId: record.queueRecordId,
          subjectId: record.subjectId,
          deviceId: record.deviceId,
          enqueuedAt: record.enqueuedAt,
          policyCheckpointHash: record.policyCheckpointHash,
          consentClass: record.consentClass,
          locality: record.locality,
        });
        writeIndex(index);
        writeMeta({ ...meta, nextSeq: seq + 1, maxDepth });

        onTelemetry?.({
          event: "learning.trajectory_queue.enqueue",
          outcome: "ok",
          subjectId: record.subjectId,
          deviceId: record.deviceId,
          queueRecordId: record.queueRecordId,
          policyCheckpointHash: record.policyCheckpointHash,
          consentClass: record.consentClass,
          depth: index.length,
          maxDepth,
          transport: "local-encrypted",
        });

        return {
          queued: true as const,
          record,
          depth: index.length,
          idempotentReplay: false,
        };
      });
    },

    dequeue(opts) {
      assertOpen();
      const index = readIndex();
      if (index.length === 0) {
        onTelemetry?.({
          event: "learning.trajectory_queue.dequeue",
          outcome: "advisory",
          subjectId: opts?.subjectId ?? "trajectory-queue",
          deviceId: "ci",
          depth: 0,
          maxDepth,
          transport: "local-encrypted",
          failureClass: "queue.empty",
        });
        return { dequeued: false as const, reason: "empty" as const, depth: 0 };
      }

      let idx = 0;
      if (opts?.subjectId !== undefined) {
        if (!opts.subjectId) {
          throw new TrajectoryQueueContractError(
            "subjectId filter must be non-empty",
            { obligation: "queue.subject_scope" },
          );
        }
        idx = index.findIndex((e) => e.subjectId === opts.subjectId);
        if (idx < 0) {
          return {
            dequeued: false as const,
            reason: "empty" as const,
            depth: index.length,
          };
        }
      }

      const entry = index[idx]!;
      const blobPath = path.join(
        rootDir,
        "records",
        `${entry.queueRecordId}.enc`,
      );
      let blob: Buffer;
      try {
        blob = readFileSync(blobPath);
      } catch {
        throw new TrajectoryQueueContractError(
          `missing encrypted payload for ${entry.queueRecordId}`,
          {
            obligation: "queue.corrupt_index",
            subjectId: entry.subjectId,
            failingSlice: entry.queueRecordId,
          },
        );
      }

      const plaintext = decryptPayload(key, blob);
      let parsed: unknown;
      try {
        parsed = JSON.parse(plaintext);
      } catch {
        throw new TrajectoryQueueContractError(
          "decrypted queue record is not JSON",
          {
            obligation: "queue.decrypt_failed",
            subjectId: entry.subjectId,
          },
        );
      }

      const rebuilt = buildTrajectoryQueueRecord({
        trajectory: (parsed as TrajectoryQueueRecord).trajectory,
        queueRecordId: entry.queueRecordId,
        enqueuedAt: entry.enqueuedAt,
        deviceId: entry.deviceId,
      });

      if (
        opts?.subjectId !== undefined &&
        rebuilt.subjectId !== opts.subjectId
      ) {
        throw new TrajectoryQueueContractError(
          "cross-subject dequeue refused",
          {
            obligation: "queue.subject_scope",
            subjectId: rebuilt.subjectId,
            failingSlice: opts.subjectId,
          },
        );
      }

      index.splice(idx, 1);
      writeIndex(index);
      try {
        unlinkSync(blobPath);
      } catch {
        onTelemetry?.({
          event: "learning.trajectory_queue.dequeue",
          outcome: "advisory",
          subjectId: rebuilt.subjectId,
          deviceId: rebuilt.deviceId,
          queueRecordId: rebuilt.queueRecordId,
          depth: index.length,
          maxDepth,
          transport: "local-encrypted",
          failureClass: "queue.corrupt_index",
        });
      }

      onTelemetry?.({
        event: "learning.trajectory_queue.dequeue",
        outcome: "ok",
        subjectId: rebuilt.subjectId,
        deviceId: rebuilt.deviceId,
        queueRecordId: rebuilt.queueRecordId,
        policyCheckpointHash: rebuilt.policyCheckpointHash,
        consentClass: rebuilt.consentClass,
        depth: index.length,
        maxDepth,
        transport: "local-encrypted",
      });

      return {
        dequeued: true as const,
        record: rebuilt,
        depth: index.length,
      };
    },

    peekMeta(limit = 16) {
      assertOpen();
      const capped = Math.min(
        Math.max(1, limit),
        TRAJECTORY_QUEUE_DEQUEUE_BATCH_LIMIT,
      );
      return readIndex().slice(0, capped);
    },

    close() {
      closed = true;
    },
  };

  onTelemetry?.({
    event: "learning.trajectory_queue.open",
    outcome: "ok",
    subjectId: "trajectory-queue",
    deviceId: "ci",
    depth: transport.depth(),
    maxDepth,
    transport: "local-encrypted",
  });

  return transport;
}

/**
 * Open queue transport. Redis-stream is behind feature flag / preferRedis;
 * connection or missing client → advisory fallback to local encrypted queue.
 */
export function openTrajectoryQueueTransport(opts: {
  rootDir: string;
  keyMaterial: string | Buffer;
  maxDepth?: number;
  /** Feature flag override (also reads SUTRA_TRAJECTORY_QUEUE_REDIS_STREAM). */
  enableRedisStream?: boolean;
  /** @deprecated alias for enableRedisStream */
  preferRedis?: boolean;
  /** Injected Redis Streams client — required to actually use the redis path. */
  redisClient?: TrajectoryQueueRedisStreamClient;
  streamKey?: string;
  consentGate?: TrajectoryQueueConsentGateOptions;
  onTelemetry?: (e: TrajectoryQueueTelemetryEvent) => void;
}): TrajectoryQueueTransport {
  const enabled = isTrajectoryQueueRedisStreamEnabled({
    ...(opts.enableRedisStream !== undefined
      ? { enableRedisStream: opts.enableRedisStream }
      : {}),
    ...(opts.preferRedis !== undefined ? { preferRedis: opts.preferRedis } : {}),
  });

  const openLocal = () =>
    openLocalEncryptedTrajectoryQueue({
      rootDir: opts.rootDir,
      keyMaterial: opts.keyMaterial,
      ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
      ...(opts.consentGate !== undefined
        ? { consentGate: opts.consentGate }
        : {}),
      ...(opts.onTelemetry !== undefined
        ? { onTelemetry: opts.onTelemetry }
        : {}),
    });

  if (!enabled) {
    return openLocal();
  }

  if (!opts.redisClient) {
    opts.onTelemetry?.({
      event: "learning.trajectory_queue.open",
      outcome: "advisory",
      subjectId: "trajectory-queue",
      deviceId: "ci",
      transport: "redis-stream",
      failureClass: "queue.redis_unavailable",
    });
    return openLocal();
  }

  try {
    opts.redisClient.ping();
  } catch {
    opts.onTelemetry?.({
      event: "learning.trajectory_queue.open",
      outcome: "advisory",
      subjectId: "trajectory-queue",
      deviceId: "ci",
      transport: "redis-stream",
      failureClass: "queue.redis_unavailable",
    });
    return openLocal();
  }

  return openRedisStreamTrajectoryQueue({
    client: opts.redisClient,
    keyMaterial: opts.keyMaterial,
    rootDir: opts.rootDir,
    ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
    ...(opts.streamKey !== undefined ? { streamKey: opts.streamKey } : {}),
    ...(opts.consentGate !== undefined
      ? { consentGate: opts.consentGate }
      : {}),
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
}

/**
 * Micro-run: enqueue → dequeue round-trip with lineage fields asserted.
 */
export function proveTrajectoryQueueMicroRun(opts: {
  rootDir: string;
  keyMaterial: string | Buffer;
  trajectories: TurnTrajectoryRecord[];
  maxDepth?: number;
  onTelemetry?: (e: TrajectoryQueueTelemetryEvent) => void;
}): {
  ok: true;
  enqueued: number;
  dequeued: number;
  policyCheckpointHashes: string[];
  consentClasses: TrajectoryConsentClass[];
} {
  const q = openLocalEncryptedTrajectoryQueue({
    rootDir: opts.rootDir,
    keyMaterial: opts.keyMaterial,
    maxDepth: opts.maxDepth ?? Math.max(opts.trajectories.length, 4),
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  const hashes: string[] = [];
  const classes: TrajectoryConsentClass[] = [];

  try {
    for (const trajectory of opts.trajectories) {
      const r = q.enqueue({ trajectory });
      hashes.push(r.record.policyCheckpointHash);
      classes.push(r.record.consentClass);
    }

    let dequeued = 0;
    while (true) {
      const next = q.dequeue();
      if (!next.dequeued) break;
      dequeued += 1;
      if (!next.record.policyCheckpointHash || !next.record.enqueuedAt) {
        throw new TrajectoryQueueContractError(
          "dequeued record missing staleness fields",
          { obligation: "queue.schema_violation" },
        );
      }
    }

    if (dequeued !== opts.trajectories.length) {
      throw new TrajectoryQueueContractError(
        `micro-run dequeue count mismatch (${dequeued} vs ${opts.trajectories.length})`,
        { obligation: "queue.schema_violation" },
      );
    }

    return {
      ok: true,
      enqueued: opts.trajectories.length,
      dequeued,
      policyCheckpointHashes: hashes,
      consentClasses: classes,
    };
  } finally {
    q.close();
  }
}
