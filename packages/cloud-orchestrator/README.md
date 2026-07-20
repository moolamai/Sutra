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
| `main.py` | FastAPI transport: `/v1/sync`, `/v1/agent/turn`, `/v1/agent/turn/stream` (SSE), `/v1/subjects/{id}/state`, `/v1/subjects/{id}/sync-audit`, `/v1/health` |
| `auth.py` | Pluggable `AuthVerifier` seam + reference API-key / permissive-dev verifiers |

No module knows about any profession. Domain configuration (task graphs, charters, tool packs) lives in `domains/` and is loaded as data.

## AuthN / AuthZ (pluggable)

Default-deny on `/v1/*` except `/v1/health`. Self-hosters inject an `AuthVerifier` at startup — Sutra does not ship an IdP.

**Operator guide:** [docs/pluggable-auth-deployment.md](./docs/pluggable-auth-deployment.md) (API-key setup, JWT sketch, mTLS-at-proxy pattern).

Quick API-key mode:

```bash
export SUTRA_AUTH_VERIFIER=api_key
export SUTRA_API_KEYS_JSON='{"sk_demo":{"principalId":"ops-1","subjectScope":"*"}}'
uvicorn sutra_orchestrator.main:app --app-dir src
```

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

### Task graph pack (production)

Boot loads a versioned JSON pack via `resolve_production_task_graph` (not an inline demo graph):

```bash
# Optional override (compose sets this to the bundled pack path):
export TASK_GRAPH_PACK=/path/to/task-graph.v1.json
uvicorn sutra_orchestrator.main:app --app-dir src
```

When unset, the bundled `sutra_orchestrator/packs/teacher-cbse-slice.json` is used (same bytes as `@moolam/domain-loader` / playground). Override with `TASK_GRAPH_PACK` for alternate packs (e.g. `demo-math-sd-slice.json`). Postgres row injection is supported by the same resolver (`pack_row=…`) with threshold fallback when the row omits thresholds.

**Operator runbooks:**

- [Local dev and compose bring-up](../../docs/operations/runbooks/local-dev-compose-bring-up.md) — `pnpm install`, Python venv, compose up, `smoke_test.py`, playground at `http://localhost:3000`
- [Sync audit query (SYNC-06)](../../docs/operations/runbooks/sync-audit-query-sync-06.md) — SQL + API listing advisories by subject / device / code, remediation table, seeded fixture
- [Incident triage basics](../../docs/operations/runbooks/incident-triage-basics.md) — `X-Request-Id` correlation; sync storm vs turn latency metrics; quarantined vs exhausted

Live verification (compose): `bash packages/cloud-orchestrator/scripts/verify_operator_surfaces_compose.sh` (HEALMETREN-003 + OPERRUNB-004).

All three link metrics (`/v1/metrics`) and the [event catalog](../observability/docs/event-catalog.md).

Dependency-light smoke test (pydantic only):

```bash
python smoke_test.py
```

## Versioning

Distribution semver and the wire `PROTOCOL_VERSION` constant move together at
release. See [`docs/protocol/VERSION-LOCKSTEP.md`](../../docs/protocol/VERSION-LOCKSTEP.md)
for the file list, bump procedure, and PyPI/npm alignment rules.

## Contributing notes

- Never change `contract_models.py` without changing `contract.ts` in the same PR (contract-parity checklist in the PR template).
- The merge in `crdt_merge.py` must remain commutative, associative, and idempotent; the smoke test asserts this on every run.
- Keep runtime components free of domain vocabulary; see `docs/adr/0005-runtime.md`.

## Examples

`examples/cloud-sync/` exercises the same merge algebra from TypeScript; `smoke_test.py` covers the Python side including the planner.
