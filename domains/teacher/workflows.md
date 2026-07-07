# Teacher: workflows

How the domain's practice maps onto the platform's task graphs and guidance modes.

## Task graphs

A track (e.g. "cbse-class-7-maths", "system-design-l5") is a prerequisite DAG of concept nodes. Authoring is deliberately flat: domain teams write rows (concept id, title, prerequisites, age floor), not graph code. The demo graph in `task_router.py` spans a school mathematics track and an adult system-design track to prove the same machinery serves both.

## Guidance mode mapping

| Mode | In this domain |
|---|---|
| `exploratory` | Socratic questioning: lead with questions, let the learner construct the step |
| `guided` | Worked example: demonstrate step-by-step, then fade the scaffolding |
| `reinforcement` | Spaced retrieval practice of concepts whose mastery is decaying |
| `prerequisite-remediation` | The loop-back: friction on ratios with weak fractions sends the session back to fractions |
| `diagnostic` | Calibration probing when evidence is thin (new learner, new track) |

## The canonical session loop

1. Friction sample arrives with the learner's utterance (hesitation, revisions, assistance, outcome).
2. The task router assesses: spike plus a weak prerequisite triggers remediation, possibly recursively (bounded at depth 4); consolidated mastery advances to a successor concept; otherwise hold and continue.
3. The guidance directive (concept, mode, depth) goes to whichever model is active: edge SLM offline, cloud LLM online.
4. The turn's evidence folds into mastery counters and the episodic memory log.
5. On reconnect, replicas converge through CRDT sync; the cloud's routing decisions win the session registers.

## Facilitator workflows

Facilitators read, never steer mid-turn: mastery heatmaps across a cohort, friction spike alerts, and remediation-loop reports (which prerequisites keep pulling learners back). All of these are projections of the state documents; none require new infrastructure.
