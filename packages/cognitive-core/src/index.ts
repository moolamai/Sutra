/**
 * @moolam/cognitive-core - the cognitive core.
 *
 * Domain-agnostic composition of the cognitive primitives into one
 * agent loop. The core contains no domain logic, no prompts beyond the
 * caller-supplied charter, and no vendor imports: bind any memory store,
 * any model, any reasoning engine, any speech or vision stack, any tools,
 * any planner, any knowledge source.
 *
 * The domain changes; the cognitive primitives stay the same.
 */

export * from "./harness.js";
