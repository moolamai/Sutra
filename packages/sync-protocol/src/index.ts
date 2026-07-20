/**
 * @moolam/sync-protocol — The Contract.
 *
 * Framework-agnostic API boundary + CRDT reconciliation for the
 * Hybrid Cognitive Sync Protocol. Both harnesses (edge TypeScript SDK
 * and any contract-compliant cloud engine) build against this package.
 */

export * from "./aggregation.js";
export * from "./contract.js";
export * from "./crdt_harness_resolver.js";
export * from "./degradation_registry.js";
export * from "./deprecation.js";
export * from "./golden_turns.js";
export * from "./harness_frames.js";
export * from "./hlc_clock.js";
export * from "./metering.js";
export * from "./sync_engine.js";
export * from "./tool_envelope.js";
export * from "./trajectory.js";
