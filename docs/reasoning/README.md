# Reasoning

The reasoning contract (`ReasoningInterface` in `@moolam/contracts`) exists to make deliberation auditable. A conclusion without a trace is a liability in every serious domain; the contract makes the trace structural rather than optional.

## The shape of a reasoning run

A run takes a question, grounding passages (from knowledge retrieval), recalled memories, and a set of `constraints`. It returns:

| Field | Purpose |
|---|---|
| `conclusion` | The answer, in the agent's voice |
| `trace` | Ordered steps, each typed (`inference`, `verification`, `counterargument`, `assumption`, `retrieval`) |
| `confidence` | Calibrated scalar the caller can threshold on |
| `unresolvedConstraints` | Constraints the engine could not verify; surfaced, never dropped |

## Constraints are the safety channel

Callers push domain invariants in as constraints: a drug contraindication, a standard clause, a jurisdiction boundary. The engine either verifies them (a `verification` step appears in the trace) or returns them in `unresolvedConstraints`. Downstream policy decides what an unresolved constraint means; the contract guarantees it is visible.

## Step kinds earn their keep per domain

- `counterargument` is opposing-counsel analysis for the lawyer domain and the mandatory bear case for finance
- `verification` is the arithmetic check in education and the clause check in engineering
- `assumption` steps make thesis drift visible in finance and undocumented design assumptions visible in engineering

## Engines are replaceable

Chain-of-thought over a single model, a verifier loop over two models, a symbolic checker wrapped around an LLM: all fit behind the same contract. The reference expectation is that traces are honest (steps reflect what actually happened, not a post-hoc rationalization) and that confidence is calibrated against outcomes over time. Implementation philosophy lives in [`design/reasoning.md`](../../design/reasoning.md).
