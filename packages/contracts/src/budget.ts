/**
 * Host-side budget throttling for harness metering.
 *
 * B5 / stranger hosts implement {@link BudgetHook} so spend is gated
 * *before* overrun, not after. Decisions are a closed enum — never free-text
 * control signals or stack traces to the model.
 */

import type { HarnessMeterPayload } from "./runtime.js";

/**
 * Closed decision set returned by {@link BudgetHook.onMeterTick}.
 * Additive evolution only — new decisions are new members, never renames.
 */
export const BUDGET_DECISIONS = Object.freeze([
  "allow",
  "throttle",
  "hardStop",
] as const);

export type BudgetDecision = (typeof BUDGET_DECISIONS)[number];

/**
 * Subject-scoped meter snapshot presented to a BudgetHook.
 * Field-identical to {@link HarnessMeterPayload} (EventBus `harness.meter`
 * payload / sync-protocol `MeterEvent` + scope). Metadata only — never
 * prompt or completion text. Cached and fresh input tokens stay separate.
 */
export type BudgetMeterTick = HarnessMeterPayload;

/**
 * Host callback invoked after a meter tick is accepted.
 *
 * Semantics (normative for B5):
 * - `allow` — continue generation under current pacing
 * - `throttle` — continue but slow / shed load (host defines mechanism)
 * - `hardStop` — stop further generation for this turn/subject budget window
 *
 * Hooks MUST scope state by `event.subjectId`. Cross-subject aggregation is
 * a defect. Partial turns (`aborted: true`) still call the hook — spend is
 * accounted even when the stream aborted.
 */
export interface BudgetHook {
  onMeterTick(
    event: BudgetMeterTick,
  ): BudgetDecision | Promise<BudgetDecision>;
}

export function isBudgetDecision(value: unknown): value is BudgetDecision {
  return (
    typeof value === "string" &&
    (BUDGET_DECISIONS as readonly string[]).includes(value)
  );
}
