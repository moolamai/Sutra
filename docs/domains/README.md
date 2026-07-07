# Domains (documentation guide)

Domain modules live in the top-level [`domains/`](../../domains/README.md) directory, not here. This page explains the model; the modules themselves are the reference.

## What a domain is

A domain is configuration bound to the platform contracts:

- an `AgentProfile` (charter, refusals, languages)
- a task graph (the prerequisite DAG the router walks)
- knowledge corpora behind `KnowledgeConnectorInterface`
- a tool pack with risk classes
- memory-kind semantics (what a `correction` means in this profession)

No domain adds cognitive machinery. The loop, the memory model, the sync protocol, and the runtime are identical across professions; that identity is the platform's core claim.

## What a domain is not

- Not a package under `packages/` (infrastructure never depends on domains)
- Not a fork of the loop with custom prompts baked into platform code
- Not allowed to import another domain

## Current domain specifications

| Domain | Companion |
|---|---|
| [`domains/teacher/`](../../domains/teacher/README.md) | Autonomous cognitive teacher (reference domain) |
| [`domains/lawyer/`](../../domains/lawyer/README.md) | Autonomous legal companion |
| [`domains/doctor/`](../../domains/doctor/README.md) | Clinical cognitive assistant |
| [`domains/engineering/`](../../domains/engineering/README.md) | Engineering design companion |
| [`domains/finance/`](../../domains/finance/README.md) | Financial analyst companion |

The architecture supports further domains (research, manufacturing, robotics, agriculture, governance, accessibility) without structural change: each is a new configuration, authored the same way.

## Building one

Start from the five-file template described in [`domains/README.md`](../../domains/README.md), pair it with a runnable example under `examples/`, and validate against the contracts test suite. Contract changes are almost never needed; if you believe one is, that is an RFC ([`rfcs/`](../../rfcs/README.md)), not a domain PR.
