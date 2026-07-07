"""FastAPI ingress of the cloud engine (reference implementation).

A thin transport layer over the runtime components:

    POST /v1/sync                 — CRDT reconciliation (SyncService)
    POST /v1/agent/turn           — routed agent turn (AgentRuntime)
    GET  /v1/subjects/{id}/state  — read the master cognitive state
    GET  /v1/health               — liveness/readiness for orchestration

State stores:
    Postgres+pgvector — long-term memory (MCE) and master state documents
    Redis             — session cache + LangGraph checkpoints (wired in
                        deployment; in-process fallbacks keep local dev
                        zero-dependency)
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException

from . import PROTOCOL_VERSION, __version__
from .agent_runtime import AgentRuntime, UnknownSubjectError
from .contract_models import (
    AgentTurnRequest,
    AgentTurnResponse,
    CognitiveState,
    SyncRequest,
    SyncResponse,
)
from .crdt_merge import IrreconcilableStateError
from .sync_service import MasterStateStore, SyncService
from .task_router import TaskRouter, demo_task_graph

logger = logging.getLogger("sutra.orchestrator")

_store = MasterStateStore()
_sync_service = SyncService(_store)
_runtime: AgentRuntime | None = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Boot order: task graph → router graph → (optionally) pgvector pool."""
    global _runtime
    _runtime = AgentRuntime(TaskRouter(demo_task_graph()), _store)

    dsn = os.environ.get("SUTRA_PG_DSN")
    if dsn:
        # Deferred import so offline dev never pays the psycopg dependency.
        from .memory_graph import MemoryGraph

        memory = MemoryGraph.from_dsn(dsn)
        memory.ensure_schema()
        app.state.memory = memory
        logger.info("MCE online: pgvector at %s", dsn.split("@")[-1])
    else:
        from .memory_graph import InMemoryMemoryGraph

        app.state.memory = InMemoryMemoryGraph()
        logger.warning("SUTRA_PG_DSN unset — MCE running in-memory (dev only)")

    yield


app = FastAPI(
    title="Sutra Cloud Engine",
    version=__version__,
    description=(
        "Reference Cognitive State Machine engine for the Hybrid Cognitive "
        "Sync Protocol. Indian Sovereign AI Initiative — Moolam AI."
    ),
    lifespan=lifespan,
)


@app.get("/v1/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "protocol": PROTOCOL_VERSION, "engine": __version__}


@app.post("/v1/sync", response_model=SyncResponse)
async def sync(request: SyncRequest) -> SyncResponse:
    """CRDT reconciliation endpoint. Idempotent; retries are always safe."""
    try:
        return _sync_service.reconcile(request)
    except IrreconcilableStateError as err:
        # 4xx signals the edge SyncEngine to quarantine, never retry.
        raise HTTPException(status_code=422, detail=str(err)) from err


@app.post("/v1/agent/turn", response_model=AgentTurnResponse)
async def agent_turn(request: AgentTurnRequest) -> AgentTurnResponse:
    """One cloud-routed agent turn through the cyclical task router."""
    assert _runtime is not None, "lifespan not run"
    try:
        return _runtime.run_turn(request)
    except UnknownSubjectError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err


@app.get("/v1/subjects/{subject_id}/state", response_model=CognitiveState)
async def get_state(subject_id: str) -> CognitiveState:
    assert _runtime is not None, "lifespan not run"
    state = _runtime.get_state(subject_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"unknown subject '{subject_id}'")
    return state
