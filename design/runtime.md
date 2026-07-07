# Design: runtime

## The stance

The runtime layer is deliberately boring. Its job is to make the interesting parts (the loop, memory, sync) portable, and portability dies through accumulation of clever host features. Every proposed runtime capability faces the question: does the loop need it on a phone, a server, and a test runner alike? If not, it belongs in a host.

## Lifecycle strictness

Transitions are one-way except suspend/resume, and there is no partial-startup state: a component that fails during `initializing` lands in `failed`, and the host decides what that means. This strictness exists because half-initialized cognitive components produce the worst class of bug, namely plausible-looking turns with missing bindings. Fail at the boundary, loudly.

## Scheduling minimalism

The scheduler contract supports deferred and periodic tasks, nothing else. No cron grammar, no priorities, no distributed coordination. The platform's own needs (memory compaction, sync retries, plan review ticks) fit this surface, and every richer feature is a host integration. `InProcessScheduler` uses plain timers; hosts with real job systems adapt them behind the same contract.

## Event discipline

The bus is for observations, not control flow. Components publish facts (turn completed, sync adopted, friction spike); subscribers react. The design rule: no component may require that a subscriber exists for correctness. If removing every subscriber breaks a flow, that flow was control logic wearing an event costume and should be a direct call.

## Storage driver

`StorageDriver` exists because "the filesystem" is not a portable assumption. It is a key-value seam, intentionally too small to become a database: range queries, transactions, and indexes are the memory system's business, behind its own contract.

## Suspension

Suspend/resume exists for mobile hosts and must stay cheap: suspended components hold memory but schedule nothing. The test for any new runtime feature is whether it complicates suspension; if it does, redesign it.
