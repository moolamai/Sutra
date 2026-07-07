# Architecture Decision Records

Short, dated records of the decisions that shaped the system. An ADR captures the context at decision time, the options weighed, and the consequences accepted. ADRs are immutable once accepted; a reversed decision gets a new ADR that supersedes the old one.

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-monorepo.md) | One monorepo for contracts, core, hosts, and domains | Accepted |
| [0002](0002-edge-cloud.md) | Edge and cloud as peer runtimes, not client and server | Accepted |
| [0003](0003-sync-protocol.md) | CRDT state documents with HLC ordering for sync | Accepted |
| [0004](0004-memory-model.md) | Kind-tagged memories with kind-driven decay | Accepted |
| [0005](0005-runtime.md) | Runtime as contracts with in-process reference implementations | Accepted |

## Writing one

Copy the section structure of any existing ADR (Status, Context, Decision, Options considered, Consequences). Keep it under two pages. Propose it in a PR; acceptance follows the governance process in the repository root. Contract-changing decisions need an RFC first; the ADR then records the outcome.
