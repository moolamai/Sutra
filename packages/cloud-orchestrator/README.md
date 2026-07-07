# @moolam/cloud-orchestrator

The cloud engine: reference Cognitive State Machine implementation for the Hybrid Cognitive Sync Protocol. Python (FastAPI + LangGraph + pgvector). Any engine that honors the wire contract may replace this one.

## Architecture

Domain-agnostic runtime components, each isolated from HTTP concerns:

| Module | Responsibility |
|---|---|
| `agent_runtime.py` | Composes router, state store, and memory into one agent turn |
| `task_router.py` | Cyclical prerequisite-graph routing (LangGraph state machine) |
| `planner.py` | Goal decomposition and cyclic plan revision (Python twin of the planning contract) |
| `memory_graph.py` | pgvector-backed long-term subject memory (MCE) with kind-aware decay |
| `sync_service.py` | CRDT reconciliation over master state documents |
| `contract_models.py` | Pydantic mirrors of the canonical TypeScript wire contract |
| `crdt_merge.py` | Join-semilattice merge, byte-identical twin of the TS resolver |
| `main.py` | FastAPI transport: `/v1/sync`, `/v1/agent/turn`, `/v1/subjects/{id}/state`, `/v1/health` |

No module knows about any profession. Domain configuration (task graphs, charters, tool packs) lives in `domains/` and is loaded as data.

## Public API

The HTTP surface is defined by the wire contract in `packages/sync-protocol/src/contract.ts`. The Pydantic models here must stay field-for-field identical; CI compares generated JSON Schemas.

## Quick start

```bash
pip install -e ".[dev]"
uvicorn sutra_orchestrator.main:app --reload --app-dir src
# with persistence:
SUTRA_PG_DSN=postgresql://sutra:sutra@localhost:5432/sutra uvicorn sutra_orchestrator.main:app --app-dir src
```

Or via the repo root: `pnpm infra:up` (see `infra/docker-compose.yml`).

Dependency-light smoke test (pydantic only):

```bash
python smoke_test.py
```

## Contributing notes

- Never change `contract_models.py` without changing `contract.ts` in the same PR (contract-parity checklist in the PR template).
- The merge in `crdt_merge.py` must remain commutative, associative, and idempotent; the smoke test asserts this on every run.
- Keep runtime components free of domain vocabulary; see `docs/adr/0005-runtime.md`.

## Examples

`examples/cloud-sync/` exercises the same merge algebra from TypeScript; `smoke_test.py` covers the Python side including the planner.
