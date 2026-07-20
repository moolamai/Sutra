# Sutra fastapi-adapter integration template

Custom `/v1/sync` FastAPI target plus a TypeScript `SyncTransport` client. The adapter uses self-contained wire models — it does **not** import `sutra-orchestrator` internals or fork the package. Point production transports at the published orchestrator when ready.

## Layout

| Path | Role |
|------|------|
| `app/main.py` | FastAPI `/v1/sync` + `/v1/health` |
| `app/wire_models.py` | Wire-compatible Pydantic models |
| `app/sync_store.py` | Subject-scoped in-memory store (idempotent by `syncAttemptId`) |
| `transport/http_sync_transport.ts` | `sutra-sdk` SyncTransport client |

## Quickstart

```bash
# Python adapter
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
python scripts/smoke.py

# TypeScript SyncTransport
pnpm install
pnpm typecheck
pnpm smoke
```

## Sovereignty

- `x-sutra-subject-id` header must match `edgeState.subjectId` (403 otherwise).
- Transport client rejects cross-subject payloads before the network call.
- Replay of the same `syncAttemptId` returns the cached merge (idempotent).
