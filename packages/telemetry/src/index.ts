/**
 * @moolam/telemetry - cognitive friction telemetry.
 *
 * Observes raw interaction events and folds them into durable,
 * protocol-level friction samples. Used by the edge agent on-device and
 * reusable by any host that speaks the sync protocol.
 */

export * from "./aggregation.js";
export * from "./collector.js";
export * from "./trajectory_format.js";
export * from "./trajectory_writer.js";
