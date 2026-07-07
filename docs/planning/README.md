# Planning

Planning in Sutra is graph walking with evidence-driven revision, not one-shot task decomposition. The contract (`PlanningInterface` in `@moolam/contracts`) and the cloud components (`task_router.py`, `planner.py`) share one worldview: goals decompose into prerequisite DAGs, and friction evidence can send the walk backwards.

## Two cooperating components

| Component | Question it answers | Where |
|---|---|---|
| Task router | "Given this friction sample and mastery state, what is the next node and mode?" | `task_router.py` (cloud), mirrored heuristics on-device |
| Graph planner | "Given this goal, what is the step graph, and how does it revise when evidence contradicts it?" | `planner.py`, `PlanningInterface` |

## The routing decision

Each turn, the router folds the friction sample into mastery evidence and picks one of three moves:

1. **Loop back**: friction spike plus a weak prerequisite routes the session to the prerequisite (bounded recursion, default depth 4)
2. **Advance**: consolidated mastery moves to a successor node
3. **Hold**: stay on the current node, possibly switching guidance mode

The output is a guidance directive: node, mode (`exploratory`, `guided`, `reinforcement`, `prerequisite-remediation`, `diagnostic`), and depth. The directive is domain-free; domains give the modes their professional meaning (see each domain's `workflows.md`).

## Revision is the normal case

Plans are hypotheses. `revise` takes a `PlanRevisionEvent` (contradicting evidence, a failed step, an external change) and returns an updated plan with the revision recorded. A plan that never revises is either a trivial goal or a planner that is not listening.

## Task graphs are data

Graphs are authored as rows (node id, title, prerequisites, metadata), loaded by the runtime, and owned by domains. The infrastructure never hardcodes a graph; the demo graph shipped with the cloud engine exists for tests and the Playground. Implementation philosophy lives in [`design/planner.md`](../../design/planner.md).
