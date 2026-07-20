/**
 * Client-safe sync-protocol surface (no sync engine / observability / Node builtins).
 */

export { CrdtHarnessResolver, type MergeResult } from "./crdt_harness_resolver.js";
export { HlcClock } from "./hlc_clock.js";
export {
  PROTOCOL_VERSION,
  type CognitiveState,
  type FrictionSample,
  type GuidanceMode,
  type HLCTimestamp,
  type SyncAdvisory,
} from "./contract.js";
