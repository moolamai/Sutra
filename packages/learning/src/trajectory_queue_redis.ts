/**
 * Redis-stream transport seam for the trajectory queue (C4).
 *
 * Feature-flagged optional backend with the same enqueue/dequeue API as the
 * local encrypted queue. Connection failure → advisory + local fallback.
 * Client is injectable (in-memory for CI; compose Redis probed separately).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { createConnection } from "node:net";
import {
  TRAJECTORY_QUEUE_DEFAULT_MAX_DEPTH,
  TRAJECTORY_QUEUE_DEQUEUE_BATCH_LIMIT,
  TRAJECTORY_QUEUE_MAX_DEPTH_CAP,
  TrajectoryQueueContractError,
  buildTrajectoryQueueRecord,
  openLocalEncryptedTrajectoryQueue,
  type TrajectoryQueueConsentGateOptions,
  type TrajectoryQueueFailureClass,
  type TrajectoryQueueIndexEntry,
  type TrajectoryQueueRecord,
  type TrajectoryQueueTelemetryEvent,
  type TrajectoryQueueTransport,
} from "./trajectory_queue.js";
import type { TurnTrajectoryRecord } from "./trajectory_schema.js";

/** Env feature flag — 1|true|yes prefers Redis-stream when opening transport. */
export const TRAJECTORY_QUEUE_REDIS_FEATURE_FLAG =
  "SUTRA_TRAJECTORY_QUEUE_REDIS_STREAM" as const;

export const TRAJECTORY_QUEUE_REDIS_URL_ENV = "SUTRA_REDIS_URL" as const;

export type TrajectoryQueueRedisStreamEntry = {
  id: string;
  fields: Record<string, string>;
};

/**
 * Minimal Redis Streams seam — sync so the queue transport API stays sync.
 * Learning never hard-depends on a Redis npm package.
 */
export type TrajectoryQueueRedisStreamClient = {
  ping(): "PONG";
  xLen(key: string): number;
  xAdd(key: string, id: string, fields: Record<string, string>): string;
  xRange(
    key: string,
    start: string,
    end: string,
    count: number,
  ): TrajectoryQueueRedisStreamEntry[];
  xDel(key: string, ...ids: string[]): number;
  hGet(key: string, field: string): string | null;
  hSet(key: string, field: string, value: string): number;
  hDel(key: string, ...fields: string[]): number;
  quit(): void;
};

export type RedisStreamTrajectoryQueue = TrajectoryQueueTransport & {
  readonly kind: "redis-stream";
  readonly streamKey: string;
};

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

export function isTrajectoryQueueRedisStreamEnabled(opts?: {
  enableRedisStream?: boolean;
  preferRedis?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (opts?.enableRedisStream === true || opts?.preferRedis === true) {
    return true;
  }
  if (opts?.enableRedisStream === false) return false;
  const env = opts?.env ?? process.env;
  const v = (env[TRAJECTORY_QUEUE_REDIS_FEATURE_FLAG] ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * In-memory Redis Streams stand-in for unit/CI (compose-shaped semantics).
 */
export function createInMemoryRedisStreamClient(): TrajectoryQueueRedisStreamClient {
  const streams = new Map<
    string,
    { seq: number; entries: TrajectoryQueueRedisStreamEntry[] }
  >();
  const hashes = new Map<string, Map<string, string>>();
  let closed = false;

  function assertOpen(): void {
    if (closed) {
      throw new TrajectoryQueueContractError("redis stream client is closed", {
        obligation: "queue.redis_unavailable",
      });
    }
  }

  function stream(key: string) {
    let s = streams.get(key);
    if (!s) {
      s = { seq: 0, entries: [] };
      streams.set(key, s);
    }
    return s;
  }

  return {
    ping() {
      assertOpen();
      return "PONG";
    },
    xLen(key) {
      assertOpen();
      return stream(key).entries.length;
    },
    xAdd(key, id, fields) {
      assertOpen();
      const s = stream(key);
      s.seq += 1;
      const entryId = id === "*" ? `${Date.now()}-${s.seq}` : id;
      s.entries.push({ id: entryId, fields: { ...fields } });
      return entryId;
    },
    xRange(key, _start, _end, count) {
      assertOpen();
      const capped = Math.min(
        Math.max(1, count),
        TRAJECTORY_QUEUE_DEQUEUE_BATCH_LIMIT,
      );
      return stream(key).entries.slice(0, capped).map((e) => ({
        id: e.id,
        fields: { ...e.fields },
      }));
    },
    xDel(key, ...ids) {
      assertOpen();
      const s = stream(key);
      const remove = new Set(ids);
      const before = s.entries.length;
      s.entries = s.entries.filter((e) => !remove.has(e.id));
      return before - s.entries.length;
    },
    hGet(key, field) {
      assertOpen();
      return hashes.get(key)?.get(field) ?? null;
    },
    hSet(key, field, value) {
      assertOpen();
      let h = hashes.get(key);
      if (!h) {
        h = new Map();
        hashes.set(key, h);
      }
      const created = h.has(field) ? 0 : 1;
      h.set(field, value);
      return created;
    },
    hDel(key, ...fields) {
      assertOpen();
      const h = hashes.get(key);
      if (!h) return 0;
      let n = 0;
      for (const f of fields) {
        if (h.delete(f)) n += 1;
      }
      return n;
    },
    quit() {
      closed = true;
      streams.clear();
      hashes.clear();
    },
  };
}

/**
 * Probe TCP reachability of compose Redis (default redis://127.0.0.1:6379).
 */
export function probeRedisTcpReachable(
  redisUrl: string,
  opts?: { timeoutMs?: number },
): Promise<
  { ok: true; host: string; port: number } | { ok: false; detail: string }
> {
  let host = "127.0.0.1";
  let port = 6379;
  try {
    const u = new URL(redisUrl);
    host = u.hostname || host;
    port = u.port ? Number(u.port) : 6379;
  } catch {
    return Promise.resolve({
      ok: false,
      detail: `invalid redis url: ${redisUrl}`,
    });
  }

  const timeoutMs = opts?.timeoutMs ?? 400;
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, detail: `redis tcp timeout ${host}:${port}` });
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve({ ok: true, host, port });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    });
  });
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

function encryptPayload(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decryptPayload(key: Buffer, b64: string): string {
  const blob = Buffer.from(b64, "base64");
  if (blob.length < 12 + 16 + 1) {
    throw new TrajectoryQueueContractError("encrypted redis blob too short", {
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
      "redis stream decrypt failed (wrong key or corrupt payload)",
      { obligation: "queue.decrypt_failed" },
    );
  }
}

/**
 * Redis-stream queue with identical API to the local encrypted transport.
 */
export function openRedisStreamTrajectoryQueue(opts: {
  client: TrajectoryQueueRedisStreamClient;
  keyMaterial: string | Buffer;
  streamKey?: string;
  rootDir: string;
  maxDepth?: number;
  consentGate?: TrajectoryQueueConsentGateOptions;
  onTelemetry?: (e: TrajectoryQueueTelemetryEvent) => void;
}): RedisStreamTrajectoryQueue {
  const maxDepth = assertFiniteDepth(
    opts.maxDepth ?? TRAJECTORY_QUEUE_DEFAULT_MAX_DEPTH,
  );
  const streamKey = opts.streamKey ?? "sutra:trajectory-queue:stream";
  const idHashKey = `${streamKey}:ids`;
  const saltKey = `${streamKey}:salt`;
  const onTelemetry = opts.onTelemetry;
  const defaultConsentGate = opts.consentGate;
  const client = opts.client;

  let closed = false;
  let nextSeq = 1;
  let encKey: Buffer | null = null;

  function ensureKey(): Buffer {
    if (encKey) return encKey;
    let saltHex = client.hGet(saltKey, "salt");
    if (!saltHex) {
      saltHex = randomBytes(16).toString("hex");
      client.hSet(saltKey, "salt", saltHex);
    }
    encKey = deriveKey(opts.keyMaterial, Buffer.from(saltHex, "hex"));
    return encKey;
  }

  function assertOpen(): void {
    if (closed) {
      throw new TrajectoryQueueContractError("redis trajectory queue is closed", {
        obligation: "queue.schema_violation",
      });
    }
  }

  const transport: RedisStreamTrajectoryQueue = {
    kind: "redis-stream",
    rootDir: opts.rootDir,
    maxDepth,
    streamKey,

    depth() {
      assertOpen();
      client.ping();
      return client.xLen(streamKey);
    },

    enqueue(input) {
      assertOpen();
      client.ping();
      const key = ensureKey();
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

      const existingId = client.hGet(idHashKey, queueRecordId);
      if (existingId) {
        const depth = client.xLen(streamKey);
        onTelemetry?.({
          event: "learning.trajectory_queue.enqueue",
          outcome: "ok",
          subjectId: record.subjectId,
          deviceId: record.deviceId,
          queueRecordId,
          policyCheckpointHash: record.policyCheckpointHash,
          consentClass: record.consentClass,
          depth,
          maxDepth,
          transport: "redis-stream",
          idempotentReplay: true,
        });
        return {
          queued: true as const,
          record,
          depth,
          idempotentReplay: true,
        };
      }

      const len = client.xLen(streamKey);
      if (len >= maxDepth) {
        onTelemetry?.({
          event: "learning.trajectory_queue.stall",
          outcome: "fail",
          subjectId: record.subjectId,
          deviceId: record.deviceId,
          depth: len,
          maxDepth,
          transport: "redis-stream",
          failureClass: "queue.full",
        });
        throw new TrajectoryQueueContractError(
          `redis trajectory queue full (depth=${len}, maxDepth=${maxDepth}) — backpressure; consented trajectory not dropped`,
          {
            obligation: "queue.full",
            subjectId: record.subjectId,
            deviceId: record.deviceId,
          },
        );
      }

      const seq = nextSeq++;
      const payload = encryptPayload(key, JSON.stringify(record));
      client.xAdd(streamKey, "*", {
        queueRecordId: record.queueRecordId,
        subjectId: record.subjectId,
        deviceId: record.deviceId,
        enqueuedAt: record.enqueuedAt,
        policyCheckpointHash: record.policyCheckpointHash,
        consentClass: record.consentClass,
        locality: record.locality,
        seq: String(seq),
        payload,
        payloadHash: createHash("sha256")
          .update(payload)
          .digest("hex")
          .slice(0, 16),
      });
      client.hSet(idHashKey, queueRecordId, record.queueRecordId);
      const depth = len + 1;

      onTelemetry?.({
        event: "learning.trajectory_queue.enqueue",
        outcome: "ok",
        subjectId: record.subjectId,
        deviceId: record.deviceId,
        queueRecordId: record.queueRecordId,
        policyCheckpointHash: record.policyCheckpointHash,
        consentClass: record.consentClass,
        depth,
        maxDepth,
        transport: "redis-stream",
      });

      return {
        queued: true as const,
        record,
        depth,
        idempotentReplay: false,
      };
    },

    dequeue(optsDeq) {
      assertOpen();
      client.ping();
      const key = ensureKey();
      const batch = client.xRange(
        streamKey,
        "-",
        "+",
        TRAJECTORY_QUEUE_DEQUEUE_BATCH_LIMIT,
      );
      if (batch.length === 0) {
        onTelemetry?.({
          event: "learning.trajectory_queue.dequeue",
          outcome: "advisory",
          subjectId: optsDeq?.subjectId ?? "trajectory-queue",
          deviceId: "ci",
          depth: 0,
          maxDepth,
          transport: "redis-stream",
          failureClass: "queue.empty" as TrajectoryQueueFailureClass,
        });
        return { dequeued: false as const, reason: "empty" as const, depth: 0 };
      }

      let chosen = batch[0]!;
      if (optsDeq?.subjectId !== undefined) {
        if (!optsDeq.subjectId) {
          throw new TrajectoryQueueContractError(
            "subjectId filter must be non-empty",
            { obligation: "queue.subject_scope" },
          );
        }
        const match = batch.find(
          (e) => e.fields.subjectId === optsDeq.subjectId,
        );
        if (!match) {
          return {
            dequeued: false as const,
            reason: "empty" as const,
            depth: client.xLen(streamKey),
          };
        }
        chosen = match;
      }

      if (
        optsDeq?.subjectId !== undefined &&
        chosen.fields.subjectId !== optsDeq.subjectId
      ) {
        throw new TrajectoryQueueContractError(
          "cross-subject dequeue refused",
          {
            obligation: "queue.subject_scope",
            ...(chosen.fields.subjectId !== undefined
              ? { subjectId: chosen.fields.subjectId }
              : {}),
            failingSlice: optsDeq.subjectId,
          },
        );
      }

      const payloadB64 = chosen.fields.payload;
      if (!payloadB64) {
        throw new TrajectoryQueueContractError(
          "redis stream entry missing encrypted payload",
          {
            obligation: "queue.corrupt_index",
            ...(chosen.fields.subjectId !== undefined
              ? { subjectId: chosen.fields.subjectId }
              : {}),
            ...(chosen.fields.queueRecordId !== undefined
              ? { failingSlice: chosen.fields.queueRecordId }
              : {}),
          },
        );
      }

      const plaintext = decryptPayload(key, payloadB64);
      const parsed = JSON.parse(plaintext) as TrajectoryQueueRecord;
      const rebuilt = buildTrajectoryQueueRecord({
        trajectory: parsed.trajectory,
        queueRecordId: chosen.fields.queueRecordId ?? parsed.queueRecordId,
        enqueuedAt: chosen.fields.enqueuedAt ?? parsed.enqueuedAt,
        deviceId: chosen.fields.deviceId ?? parsed.deviceId,
        ...(defaultConsentGate ?? {}),
      });

      client.xDel(streamKey, chosen.id);
      client.hDel(idHashKey, rebuilt.queueRecordId);
      const depth = client.xLen(streamKey);

      onTelemetry?.({
        event: "learning.trajectory_queue.dequeue",
        outcome: "ok",
        subjectId: rebuilt.subjectId,
        deviceId: rebuilt.deviceId,
        queueRecordId: rebuilt.queueRecordId,
        policyCheckpointHash: rebuilt.policyCheckpointHash,
        consentClass: rebuilt.consentClass,
        depth,
        maxDepth,
        transport: "redis-stream",
      });

      return { dequeued: true as const, record: rebuilt, depth };
    },

    peekMeta(limit = 16) {
      assertOpen();
      client.ping();
      const capped = Math.min(
        Math.max(1, limit),
        TRAJECTORY_QUEUE_DEQUEUE_BATCH_LIMIT,
      );
      return client.xRange(streamKey, "-", "+", capped).map((e, i) => ({
        seq: Number(e.fields.seq ?? i + 1),
        queueRecordId: e.fields.queueRecordId ?? e.id,
        subjectId: e.fields.subjectId ?? "unknown",
        deviceId: e.fields.deviceId ?? "unknown",
        enqueuedAt: e.fields.enqueuedAt ?? "",
        policyCheckpointHash: e.fields.policyCheckpointHash ?? "",
        consentClass: (e.fields.consentClass ??
          "research") as TrajectoryQueueIndexEntry["consentClass"],
        locality: (e.fields.locality ??
          "on-device") as TrajectoryQueueIndexEntry["locality"],
      }));
    },

    close() {
      closed = true;
      client.quit();
    },
  };

  onTelemetry?.({
    event: "learning.trajectory_queue.open",
    outcome: "ok",
    subjectId: "trajectory-queue",
    deviceId: "ci",
    depth: client.xLen(streamKey),
    maxDepth,
    transport: "redis-stream",
  });

  return transport;
}

/**
 * Integration helper: prove Redis seam micro-run (injected client) and
 * compose TCP probe outcome (advisory when Redis is down).
 */
export async function proveRedisStreamQueueSeam(opts: {
  rootDir: string;
  keyMaterial: string | Buffer;
  trajectories: TurnTrajectoryRecord[];
  redisUrl?: string;
  onTelemetry?: (e: TrajectoryQueueTelemetryEvent) => void;
}): Promise<{
  ok: true;
  redisKind: "redis-stream";
  enqueued: number;
  dequeued: number;
  composeProbe: { ok: true; host: string; port: number } | { ok: false; detail: string };
}> {
  const client = createInMemoryRedisStreamClient();
  const q = openRedisStreamTrajectoryQueue({
    client,
    keyMaterial: opts.keyMaterial,
    rootDir: opts.rootDir,
    maxDepth: Math.max(opts.trajectories.length, 4),
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  for (const trajectory of opts.trajectories) {
    q.enqueue({ trajectory });
  }
  let dequeued = 0;
  while (true) {
    const next = q.dequeue();
    if (!next.dequeued) break;
    dequeued += 1;
  }
  q.close();

  const url =
    opts.redisUrl ??
    process.env[TRAJECTORY_QUEUE_REDIS_URL_ENV] ??
    "redis://127.0.0.1:6379";
  const composeProbe = await probeRedisTcpReachable(url);

  if (!composeProbe.ok) {
    opts.onTelemetry?.({
      event: "learning.trajectory_queue.open",
      outcome: "advisory",
      subjectId: "trajectory-queue",
      deviceId: "ci",
      transport: "redis-stream",
      failureClass: "queue.redis_unavailable",
    });
  }

  return {
    ok: true,
    redisKind: "redis-stream",
    enqueued: opts.trajectories.length,
    dequeued,
    composeProbe,
  };
}
