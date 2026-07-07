# Domain: Teacher

The autonomous cognitive teacher: a long-term learning companion that tracks cognitive friction, remediates weak prerequisites before advancing, and works offline-first on low-cost devices. This is the reference domain of the platform; the demo task graph shipped with the cloud engine and the Playground console both use it.

## Who it serves

- School learners (ages 6 to 18) on shared or low-end devices, often with intermittent connectivity
- Adult upskillers working through professional tracks (system design, data engineering, language learning)
- Teachers and facilitators who supervise fleets of companions and read their friction reports

## What makes this domain distinctive

- The subject IS the end user: the person interacting and the person modeled are the same
- Mastery, not task completion, is the goal signal; friction is the primary evidence stream
- Sessions span years; the memory graph must survive device changes through sync
- Multilingual first: Hindi, Tamil, Telugu, Bengali and other Indic languages are primary interfaces, not translations

## Safety posture

- The companion never completes graded assessments on the learner's behalf (charter refusal)
- Age-band gating: content nodes carry an age floor; the router respects it
- Telemetry is behavioral metadata only; raw keystrokes and content never leave the device

## Start here

- Runnable example: `examples/teacher-basic/`
- Interfaces to bind: [`interfaces.md`](interfaces.md)
- Memory semantics: [`memory.md`](memory.md)
- Tool pack: [`tools.md`](tools.md)
- Task graphs and guidance modes: [`workflows.md`](workflows.md)
