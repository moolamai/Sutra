/**
 * Trajectory queue transport — published path (C4).
 *
 * Local AES-256-GCM queue + optional Redis-stream seam (feature flag).
 * Source: packages/learning/src/trajectory_queue.ts · trajectory_queue_redis.ts
 */
export {
  TRAJECTORY_QUEUE_DEFAULT_MAX_DEPTH,
  TRAJECTORY_QUEUE_DEQUEUE_BATCH_LIMIT,
  TRAJECTORY_QUEUE_LOCAL_DIR_RELPATH,
  TRAJECTORY_QUEUE_MAX_DEPTH_CAP,
  TRAJECTORY_QUEUE_META_SCHEMA_VERSION,
  TRAJECTORY_QUEUE_RECORD_SCHEMA_VERSION,
  TRAJECTORY_QUEUE_REDIS_FEATURE_FLAG,
  TRAJECTORY_QUEUE_REDIS_URL_ENV,
  TRAJECTORY_QUEUE_TRANSPORT_RELPATH,
  TrajectoryQueueContractError,
  assertTrajectoryQueueEnqueueConsent,
  buildTrajectoryQueueRecord,
  createInMemoryRedisStreamClient,
  isTrajectoryQueueRedisStreamEnabled,
  openLocalEncryptedTrajectoryQueue,
  openRedisStreamTrajectoryQueue,
  openTrajectoryQueueTransport,
  probeRedisTcpReachable,
  proveRedisStreamQueueSeam,
  proveTrajectoryQueueMicroRun,
  trajectoryQueueRecordSchema,
  type RedisStreamTrajectoryQueue,
  type TrajectoryQueueConsentGateOptions,
  type TrajectoryQueueFailureClass,
  type TrajectoryQueueIndexEntry,
  type TrajectoryQueueRecord,
  type TrajectoryQueueRedisStreamClient,
  type TrajectoryQueueTelemetryEvent,
  type TrajectoryQueueTransport,
} from "@moolam/learning";
