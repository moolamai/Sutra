# Design: planner

## The stance

Planning is walking a prerequisite graph under uncertainty, and the interesting decision is almost never "what is the plan" but "what does this new evidence do to the plan". The router and the planner are built around revision as the common case: a plan object that cannot cheaply revise is a plan object designed for demos.

## Loop-back is the signature move

Most planning systems only move forward. Ours routes backwards when friction plus weak-prerequisite evidence says the foundation is missing, with bounded recursion (default depth 4) so a pathological graph cannot trap a session. The bound is a policy parameter, not a constant to inline; deployments tune it.

## Evidence folding before routing

Every routing decision starts by folding the new friction sample into mastery evidence, then reads the updated posterior. Routing on stale posteriors makes loop-back oscillate (remediate, bounce back, remediate again). The fold-then-route order is an invariant; tests assert it.

## Graphs are data, and stay small

Task graphs load from rows. There is no graph DSL, no conditional edges, no embedded scripts, because every one of those features moves domain logic into infrastructure. If a domain needs conditional structure, it authors multiple graphs and switches between them at the plan level. The demo graph exists for tests and the Playground; production graphs are domain artifacts.

## Rationale strings

Every routing decision emits a human-readable rationale. This started as a debugging aid and became load-bearing: the rationale is the file note in legal, the review comment in engineering, the facilitator explanation in education. Treat rationale quality as an interface obligation, not logging.

## What stays out

- Plan optimization (shortest-path scheduling, resource allocation): a host or domain concern
- Multi-agent negotiation: out of scope for the platform
- Learned routing policies: welcome behind the contract, never as the default reference
