# Domain: Finance

The financial analyst companion: a research and monitoring partner for analysts, portfolio teams, and treasury functions. It grounds every claim in dated sources, tracks theses over quarters, and remembers which calls were wrong and why.

## Who it serves

- Equity and credit analysts building and maintaining coverage
- Portfolio and risk teams monitoring positions against theses
- Treasury and finance teams running recurring analysis on internal data

## What makes this domain distinctive

- The subject is a *coverage entity or portfolio*, tracked across quarters and cycles
- Data currency is the core correctness problem: a two-day-old number can be materially wrong, so `asOf` discipline runs through everything
- Thesis memory: the companion tracks what was believed, when, on what evidence, and what changed
- Auditability: regulated deployments need the write-ahead tool audit and reasoning traces as compliance artifacts

## Safety posture

- Analysis support, not investment advice; outputs are analyst work product for professional review (charter refusal)
- Every numeric claim carries a source and an as-of date; unsourced numbers are demoted to estimates and flagged
- Trade execution is out of scope by design; the riskiest tool in the pack is a `write`-class report publisher

## Start here

- Interfaces to bind: [`interfaces.md`](interfaces.md)
- Memory semantics: [`memory.md`](memory.md)
- Tool pack: [`tools.md`](tools.md)
- Coverage workflows: [`workflows.md`](workflows.md)
