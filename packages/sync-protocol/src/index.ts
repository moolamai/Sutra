/**
 * @moolam/sync-protocol — The Contract.
 *
 * Framework-agnostic API boundary + CRDT reconciliation for the
 * Hybrid Cognitive Sync Protocol. Both harnesses (edge TypeScript SDK
 * and any contract-compliant cloud engine) build against this package.
 */

export * from "./contract.js";
export * from "./crdt_harness_resolver.js";
export * from "./hlc_clock.js";
export * from "./sync_engine.js";
