/**
 * Local encrypted trajectory queue — published path (C4).
 *
 * SQLite-shaped filesystem layout with AES-256-GCM payload blobs.
 * Enqueue applies the B9 consent-class gate (opt-out / unknown-class reject).
 * Prefer importing via ../queue_transport.ts for the full transport API.
 */
export {
  TRAJECTORY_QUEUE_DEFAULT_MAX_DEPTH,
  TRAJECTORY_QUEUE_LOCAL_DIR_RELPATH,
  TRAJECTORY_QUEUE_MAX_DEPTH_CAP,
  TRAJECTORY_QUEUE_REDIS_FEATURE_FLAG,
  assertTrajectoryQueueEnqueueConsent,
  createInMemoryRedisStreamClient,
  isTrajectoryQueueRedisStreamEnabled,
  openLocalEncryptedTrajectoryQueue,
  openRedisStreamTrajectoryQueue,
  type TrajectoryQueueConsentGateOptions,
  type TrajectoryQueueTransport,
} from "@moolam/learning";
