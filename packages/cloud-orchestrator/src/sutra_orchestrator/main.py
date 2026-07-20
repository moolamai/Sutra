"""FastAPI ingress of the cloud engine (reference implementation).

A thin transport layer over the runtime components:

    POST /v1/sync                      — CRDT reconciliation (SyncService)
    POST /v1/agent/turn                — routed agent turn (AgentRuntime)
    POST /v1/agent/turn/stream         — SSE harness frames (StreamingTurnHost)
    POST /v1/agent/turn/{id}/abort     — emergency abort (AbortPipeline)
    GET  /v1/subjects/{id}/state       — read the master cognitive state
    GET  /v1/subjects/{id}/sync-audit  — paginated sync audit (read-only)
    GET  /v1/health                    — readiness matrix (auth exempt; 503 only when down)
    GET  /v1/metrics                   — Prometheus/OpenMetrics scrape (auth exempt; JSON via Accept)

Compose verification
  ``pytest tests/test_compose_metrics_readiness.py`` or
  ``bash packages/cloud-orchestrator/scripts/verify_operator_surfaces_compose.sh``

Auth : default-deny FastAPI dependency on protected /v1/*
routes; /v1/health and /v1/metrics are the only opt-outs. Handlers receive
CallerContext; path/body subjectId is checked against subjectScope
(403 + audit stream).
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Annotated, Any, AsyncIterator

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from . import PROTOCOL_VERSION, __version__
from .abort_pipeline import (
    ABORT_REASON_MANUAL,
    get_abort_audit_sink,
    get_abort_pipeline,
)
from .agent_runtime import AgentRuntime, UnknownSubjectError
from .auth import (
    CallerContext,
    enforce_subject_scope,
    get_caller_context,
    select_reference_verifier,
)
from .contract_models import (
    AgentTurnRequest,
    AgentTurnResponse,
    CognitiveState,
    SyncAdvisory,
    SyncAuditItem,
    SyncAuditListQuery,
    SyncAuditPage,
    SyncRequest,
    SyncResponse,
)
from .crdt_merge import IrreconcilableStateError
from .master_state_repository import (
    MasterStateRepository,
    select_master_state_backend,
)
from .routes.aggregation import (
    router as aggregation_router,
    select_aggregation_repository,
)
from .middleware import (
    OPENMETRICS_CONTENT_TYPE,
    PROM_CONTENT_TYPE,
    RequestIdLatencyMiddleware,
    begin_agent_turn_routing,
    build_readiness_report,
    cancel_agent_turn_routing,
    finish_agent_turn_routing,
    install_request_id_log_filter,
    mark_llm_generation_start,
    metrics_snapshot,
    record_sync_outcome,
    record_turn_stage_duration,
    render_prometheus_exposition,
    resolve_metrics_content_type,
)
from .streaming_turn_host import (
    StreamingTurnHost,
    end_stream,
    format_sse_frame,
    format_sse_heartbeat,
    new_turn_id,
    sse_heartbeat_seconds,
    stream_idempotency_key,
    try_begin_stream,
)
from .sync_audit_writer import SyncAuditRecord
from .sync_service import SyncService
from .domain_graph_loader import (
    ENV_TASK_GRAPH_PACK,
    TaskGraphLoadError,
    resolve_production_task_graph,
)
from .task_router import TaskRouter

logger = logging.getLogger("sutra.orchestrator")
install_request_id_log_filter(logger)

_store: MasterStateRepository | None = None
_sync_service: SyncService | None = None
_runtime: AgentRuntime | None = None

# Injected into every protected route; cached once per request by FastAPI.
CallerCtx = Annotated[CallerContext, Depends(get_caller_context)]


class AbortTurnBody(BaseModel):
    """Body for POST /v1/agent/turn/{turn_id}/abort (subject-scoped)."""

    model_config = ConfigDict(extra="forbid")

    subjectId: str = Field(min_length=1, max_length=128)
    reason: str | None = Field(default=None, max_length=64)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Boot order: auth verifier → master-state → task graph → (optionally) MCE."""
    global _store, _sync_service, _runtime

    # Injected interface — no import-time singleton.
    auth_verifier = select_reference_verifier()
    app.state.auth_verifier = auth_verifier
    app.state.auth_backend = getattr(auth_verifier, "backend_name", "custom")
    logger.info(
        "auth_verifier backend=%s outcome=selected",
        app.state.auth_backend,
    )

    dsn = os.environ.get("SUTRA_PG_DSN")
    redis_url = os.environ.get("SUTRA_REDIS_URL")
    # Postgres when DSN set (fail fast on connection error); memory otherwise.
    _store = select_master_state_backend(dsn)
    _sync_service = SyncService(_store)
    app.state.aggregation_repository = select_aggregation_repository(dsn)

    # Production path: file/Postgres pack via TASK_GRAPH_PACK.
    try:
        graph_meta = resolve_production_task_graph(
            subject_id="orchestrator-boot",
            device_id="cloud",
            emit_events=True,
        )
    except TaskGraphLoadError as exc:
        logger.error(
            "task_graph_load outcome=fail obligation=%s failure_class=%s subject_id=%s",
            exc.obligation,
            exc.failure_class,
            exc.subject_id,
        )
        raise
    router = TaskRouter(graph_meta.graph, redis_url=redis_url)
    app.state.task_graph_version_stamp = graph_meta.version_stamp
    app.state.task_graph_pack_id = graph_meta.pack_id
    app.state.task_graph_source_path = graph_meta.source_path
    logger.info(
        "task_graph_pack env=%s pack_id=%s version_stamp=%s outcome=wired",
        ENV_TASK_GRAPH_PACK,
        graph_meta.pack_id,
        graph_meta.version_stamp,
    )
    _runtime = AgentRuntime(router, _store)
    backend = getattr(_store, "backend_name", "unknown")
    # Log the active backend exactly once at startup (no raw state content).
    logger.info("master_state_backend=%s outcome=selected", backend)
    logger.info(
        "router_checkpointer backend=%s outcome=selected",
        router.checkpoint_backend,
    )
    app.state.master_state_backend = backend
    app.state.master_state_store = _store
    app.state.router_checkpointer_backend = router.checkpoint_backend
    # Configured flags only — never stash DSNs/Redis URLs on state.
    app.state.postgres_configured = bool(dsn and str(dsn).strip())
    app.state.redis_configured = bool(redis_url and str(redis_url).strip())
    # AGENT_MANUAL_ABORT audit sink (process-local; deploy may replace).
    app.state.abort_audit_sink = get_abort_audit_sink()

    if dsn:
        from .memory_graph import MemoryGraph

        memory = MemoryGraph.from_dsn(dsn)
        memory.ensure_schema()
        app.state.memory = memory
        logger.info("MCE online: pgvector at %s", dsn.split("@")[-1])
    else:
        from .memory_graph import InMemoryMemoryGraph

        app.state.memory = InMemoryMemoryGraph()
        logger.warning("SUTRA_PG_DSN unset — MCE running in-memory (dev only)")

    try:
        yield
    finally:
        close = getattr(_store, "close", None)
        if callable(close):
            close()
        aggregation_close = getattr(
            getattr(app.state, "aggregation_repository", None), "close", None
        )
        if callable(aggregation_close):
            aggregation_close()
        app.state.aggregation_repository = None
        _runtime = None
        _sync_service = None
        _store = None
        app.state.auth_verifier = None


app = FastAPI(
    title="Sutra Cloud Engine",
    version=__version__,
    description=(
        "Reference Cognitive State Machine engine for the Hybrid Cognitive "
        "Sync Protocol. Indian Sovereign AI Initiative — Moolam AI."
    ),
    lifespan=lifespan,
)

# 003: request id, latency, errors, NFR-04 (outermost ingress).
app.add_middleware(RequestIdLatencyMiddleware)

# Default-deny: routes on this router require auth. Health + metrics on ``app``.
# New /v1 handlers MUST register here (or they are unprotected — a defect).
protected = APIRouter(dependencies=[Depends(get_caller_context)])


@app.exception_handler(TimeoutError)
async def timeout_error_handler(
    _request: Request, _exc: TimeoutError
) -> JSONResponse:
    """Typed timeout → HTTP 504 (never unhandled rejection)."""
    return JSONResponse(
        status_code=504,
        content={"detail": "upstream timeout"},
    )


@app.get("/v1/health")
async def health() -> JSONResponse:
    """Readiness with per-dependency matrix — auth opt-out.

    Returns ``status: ok | degraded | down`` plus component breakdown for
    Postgres (required when configured), Redis (optional), orchestrator,
    master_state, and checkpointer. HTTP 503 only when the process cannot
    serve protected /v1 routes (orchestrator unready or Postgres down).
    Redis absent → 200 + ``degraded``. Never includes DSNs or subject ids.
    """
    state = getattr(app, "state", None)
    redis_url = os.environ.get("SUTRA_REDIS_URL")
    http_status, payload = build_readiness_report(
        store=getattr(state, "master_state_store", None) if state else _store,
        runtime_ready=_runtime is not None and _sync_service is not None,
        redis_url=redis_url if redis_url and str(redis_url).strip() else None,
        checkpointer_backend=(
            getattr(state, "router_checkpointer_backend", None) if state else None
        ),
        protocol=PROTOCOL_VERSION,
        engine=__version__,
        auth_backend=getattr(state, "auth_backend", None) if state else None,
    )
    return JSONResponse(status_code=http_status, content=payload)


@app.get("/v1/metrics")
async def metrics(request: Request) -> Response:
    """Operator scrape — Prometheus exposition (default) or JSON summary.

    HTTP latency, sync outcome counters, turn-stage
    histograms, NFR-04 routing overhead. Auth exempt. Labels are route /
    outcome / stage / error_class only — never subjectId.
    """
    accept = request.headers.get("accept") or ""
    if "application/json" in accept.lower():
        return JSONResponse(metrics_snapshot())
    content_type = resolve_metrics_content_type(accept)
    body = render_prometheus_exposition(
        openmetrics=content_type.startswith("application/openmetrics"),
    )
    # Explicit PROM/OpenMetrics types — also tolerate clients that send */*.
    media = content_type if content_type else PROM_CONTENT_TYPE
    if media not in (PROM_CONTENT_TYPE, OPENMETRICS_CONTENT_TYPE):
        media = PROM_CONTENT_TYPE
    return Response(content=body, media_type=media)


@protected.post("/v1/sync", response_model=SyncResponse)
async def sync(request: SyncRequest, caller: CallerCtx) -> SyncResponse:
    """CRDT reconciliation endpoint. Idempotent; retries are always safe."""
    assert _sync_service is not None, "lifespan not run"
    enforce_subject_scope(
        caller,
        request.edgeState.subjectId,
        route="/v1/sync",
        source="body",
        device_id=request.deviceId,
    )
    try:
        response = _sync_service.reconcile(request)
    except IrreconcilableStateError as err:
        # 4xx signals the edge SyncEngine to quarantine, never retry.
        record_sync_outcome("quarantined")
        raise HTTPException(status_code=422, detail=str(err)) from err
    record_sync_outcome("converged")
    logger.info(
        "sync ok: subject_id=%s device_id=%s principal_id=%s outcome=ok",
        request.edgeState.subjectId,
        request.deviceId,
        caller.principalId,
    )
    return response


@protected.post(
    "/v1/agent/turn",
    response_model=AgentTurnResponse,
    response_model_exclude_none=True,
)
async def agent_turn(request: AgentTurnRequest, caller: CallerCtx) -> AgentTurnResponse:
    """One cloud-routed agent turn through the cyclical task router.

    NFR-04: wall time for orchestrator work is recorded up to
    ``mark_llm_generation_start``. The reference runtime has no LLM call, so
    the full ``run_turn`` counts as routing overhead; production should call
    ``mark_llm_generation_start`` immediately before the first model invoke.
    """
    assert _runtime is not None, "lifespan not run"
    enforce_subject_scope(
        caller,
        request.subjectId,
        route="/v1/agent/turn",
        source="body",
        device_id=None,
    )
    begin_agent_turn_routing(now=time.perf_counter)
    turn_started = time.perf_counter()
    try:
        response = _runtime.run_turn(request)
        # Reference engine returns the directive as the reply (no model I/O).
        # Production: call mark_llm_generation_start() before the LLM invoke.
        mark_llm_generation_start(now=time.perf_counter)
    except UnknownSubjectError as err:
        cancel_agent_turn_routing()
        raise HTTPException(status_code=404, detail=str(err)) from err
    except Exception:
        cancel_agent_turn_routing()
        raise
    else:
        finish_agent_turn_routing(now=time.perf_counter)
        record_turn_stage_duration(
            "respond",
            (time.perf_counter() - turn_started) * 1000.0,
        )
    logger.info(
        "agent_turn ok: subject_id=%s principal_id=%s outcome=ok",
        request.subjectId,
        caller.principalId,
    )
    return response


@protected.post("/v1/agent/turn/stream")
async def agent_turn_stream(
    request: AgentTurnRequest,
    http_request: Request,
    caller: CallerCtx,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
    x_device_id: Annotated[str | None, Header(alias="X-Device-Id")] = None,
) -> StreamingResponse:
    """SSE turn stream: SESSION_START → deltas → TURN_COMPLETE | HARNESS_ERROR.

    Auth via CallerContext at open; subject scoped to body ``subjectId``.
    Heartbeat interval: ``SUTRA_SSE_HEARTBEAT_SECONDS`` (default 15).
    Double POST with the same Idempotency-Key (or sessionId) → 409 while in flight.
    Mid-stream auth expiry does not abort an already-open stream.
    """
    assert _runtime is not None, "lifespan not run"
    device_id = x_device_id.strip() if isinstance(x_device_id, str) and x_device_id.strip() else None
    enforce_subject_scope(
        caller,
        request.subjectId,
        route="/v1/agent/turn/stream",
        source="body",
        device_id=device_id,
    )

    stream_key = stream_idempotency_key(
        subject_id=request.subjectId,
        session_id=request.sessionId,
        idempotency_key=idempotency_key,
    )
    if not try_begin_stream(stream_key):
        logger.info(
            "agent_turn_stream outcome=rejected failure_class=idempotency_conflict "
            "subject_id=%s principal_id=%s device_id=%s",
            request.subjectId,
            caller.principalId,
            device_id or "-",
        )
        raise HTTPException(
            status_code=409,
            detail={
                "code": "STREAM_IN_FLIGHT",
                "message": "a turn stream for this idempotency key is already in flight",
            },
        )

    # Fail closed before opening the SSE body when the subject has no state.
    if _runtime.get_state(request.subjectId) is None:
        end_stream(stream_key)
        raise HTTPException(
            status_code=404,
            detail=f"no cognitive state for subject '{request.subjectId}'; sync first",
        )

    heartbeat_s = sse_heartbeat_seconds()
    correlation_id = request.sessionId
    turn_id = new_turn_id(request.sessionId)
    abort_pipeline = get_abort_pipeline()
    reg_ok, abort_handle, reg_fc, reg_detail = abort_pipeline.register_turn(
        turn_id=turn_id,
        subject_id=request.subjectId,
        device_id=device_id,
    )
    if not reg_ok or abort_handle is None:
        end_stream(stream_key)
        raise HTTPException(
            status_code=409 if reg_fc == "duplicate_turn" else 503,
            detail={
                "code": (reg_fc or "invalid_turn").upper(),
                "message": reg_detail or "could not register abort handle",
            },
        )
    # Journal a pre-commit stream hold — abandoned on abort before TURN_COMPLETE.
    abort_handle.append_effect(
        effect_id=f"stream-{turn_id}",
        tool_name="stream",
        idempotency_key=stream_key,
        risk_class="read",
        mid_write=False,
    )

    async def event_generator() -> AsyncIterator[str]:
        host = StreamingTurnHost(
            subject_id=request.subjectId,
            correlation_id=correlation_id,
            device_id=device_id,
            on_telemetry=lambda e: logger.info(
                "agent_turn_stream frame outcome=%s subject_id=%s device_id=%s "
                "frame_type=%s failure_class=%s",
                e.get("outcome"),
                e.get("subjectId"),
                e.get("deviceId", "-"),
                e.get("frameType", "-"),
                e.get("failureClass", "-"),
            ),
        )
        last_heartbeat = time.perf_counter()

        async def _maybe_heartbeat() -> AsyncIterator[str]:
            nonlocal last_heartbeat
            now = time.perf_counter()
            if heartbeat_s > 0 and (now - last_heartbeat) >= heartbeat_s:
                yield format_sse_heartbeat()
                last_heartbeat = now

        async def _abort_terminal(message: str = "turn aborted") -> AsyncIterator[str]:
            term = host.terminate_with_error(
                code=ABORT_REASON_MANUAL,
                message=message[:256],
                recoverable=False,
            )
            if term.ok:
                yield format_sse_frame(term.frame)

        try:
            opened = host.emit_session_start()
            if not opened.ok:
                return
            yield format_sse_frame(opened.frame)
            async for hb in _maybe_heartbeat():
                yield hb

            if abort_handle.aborted:
                async for chunk in _abort_terminal():
                    yield chunk
                return

            if await http_request.is_disconnected():
                term = host.terminate_with_error(
                    code="CLIENT_DISCONNECT",
                    message="peer closed mid-stream",
                    recoverable=True,
                )
                if term.ok:
                    yield format_sse_frame(term.frame)
                logger.info(
                    "agent_turn_stream outcome=rejected "
                    "failure_class=client_disconnect subject_id=%s "
                    "principal_id=%s device_id=%s",
                    request.subjectId,
                    caller.principalId,
                    device_id or "-",
                )
                return

            try:
                response = _runtime.run_turn(request)
            except UnknownSubjectError as err:
                term = host.terminate_with_error(
                    code="UNKNOWN_SUBJECT",
                    message=str(err)[:256],
                    recoverable=False,
                )
                if term.ok:
                    yield format_sse_frame(term.frame)
                return
            except Exception as err:
                term = host.terminate_with_error(
                    code="HANDLER_THROWN",
                    message=(str(err)[:256] if str(err) else "turn handler threw"),
                    recoverable=True,
                )
                if term.ok:
                    yield format_sse_frame(term.frame)
                logger.info(
                    "agent_turn_stream outcome=rejected failure_class=handler_thrown "
                    "subject_id=%s principal_id=%s",
                    request.subjectId,
                    caller.principalId,
                )
                return

            if abort_handle.aborted:
                async for chunk in _abort_terminal():
                    yield chunk
                return

            try:
                # SESSION_START already emitted — answer + terminal only.
                ans = host.emit_answer_delta(response.reply)
                if not ans.ok:
                    raise RuntimeError(ans.detail)
                yield format_sse_frame(ans.frame)
                async for hb in _maybe_heartbeat():
                    yield hb

                if abort_handle.aborted:
                    async for chunk in _abort_terminal():
                        yield chunk
                    return

                done = host.emit_turn_complete(turn_id)
                if not done.ok:
                    raise RuntimeError(done.detail)
                yield format_sse_frame(done.frame)
                abort_handle.mark_effect_committed(f"stream-{turn_id}")
                abort_pipeline.mark_turn_completed(
                    turn_id,
                    subject_id=request.subjectId,
                    effects_committed=True,
                )
            except Exception as err:
                term = host.terminate_with_error(
                    code="STREAM_TRUNCATED",
                    message=(str(err)[:256] if str(err) else "stream truncated"),
                    recoverable=True,
                )
                if term.ok:
                    yield format_sse_frame(term.frame)
                return

            logger.info(
                "agent_turn_stream outcome=ok subject_id=%s principal_id=%s "
                "device_id=%s frame_count=%s turn_id=%s",
                request.subjectId,
                caller.principalId,
                device_id or "-",
                host.sequence_length,
                turn_id,
            )
        finally:
            end_stream(stream_key)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Turn-Id": turn_id,
        },
    )


@protected.post("/v1/agent/turn/{turn_id}/abort")
async def agent_turn_abort(
    turn_id: str,
    body: AbortTurnBody,
    caller: CallerCtx,
    x_device_id: Annotated[str | None, Header(alias="X-Device-Id")] = None,
) -> dict[str, Any]:
    """Emergency abort: cascade signal, rollback uncommitted, release locks.

    Accept-vs-abort: if TURN_COMPLETE already recorded with committed effects,
    returns ``already_completed`` (HTTP 200). Missing turn → 404. Cross-subject
    scope → 403.
    """
    device_id = (
        x_device_id.strip()
        if isinstance(x_device_id, str) and x_device_id.strip()
        else None
    )
    enforce_subject_scope(
        caller,
        body.subjectId,
        route="/v1/agent/turn/{turn_id}/abort",
        source="body",
        device_id=device_id,
    )

    result = get_abort_pipeline().abort(
        turn_id,
        subject_id=body.subjectId,
        reason=body.reason,
        principal_id=caller.principalId,
    )
    if not result.ok:
        if result.failure_class == "not_found":
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "TURN_NOT_FOUND",
                    "message": result.detail,
                    "turnId": turn_id,
                },
            )
        if result.failure_class == "cross_subject":
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "FORBIDDEN_SUBJECT_SCOPE",
                    "message": result.detail,
                    "turnId": turn_id,
                },
            )
        raise HTTPException(
            status_code=400,
            detail={
                "code": result.failure_class.upper(),
                "message": result.detail,
                "turnId": turn_id,
            },
        )

    logger.info(
        "agent_turn_abort outcome=ok action=%s subject_id=%s device_id=%s "
        "turn_id=%s signal_cascaded=%s locks_released=%s principal_id=%s "
        "audit_recorded=%s",
        result.action,
        result.subject_id,
        device_id or "-",
        result.turn_id,
        result.signal_cascaded,
        result.locks_released,
        caller.principalId,
        result.audit_recorded,
    )
    return {
        "action": result.action,
        "turnId": result.turn_id,
        "subjectId": result.subject_id,
        "signalCascaded": result.signal_cascaded,
        "cascadeLatencyMs": result.cascade_latency_ms,
        "uncommittedCount": result.uncommitted_count,
        "rolledBackCount": result.rolled_back_count,
        "abandonedCount": result.abandoned_count,
        "locksReleased": result.locks_released,
        "compensateFailures": result.compensate_failures,
        "auditRecorded": result.audit_recorded,
        "status": result.status,
    }


@protected.get("/v1/subjects/{subject_id}/state", response_model=CognitiveState)
async def get_state(subject_id: str, caller: CallerCtx) -> CognitiveState:
    assert _runtime is not None, "lifespan not run"
    enforce_subject_scope(
        caller,
        subject_id,
        route="/v1/subjects/{subject_id}/state",
        source="path",
    )
    state = _runtime.get_state(subject_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"unknown subject '{subject_id}'")
    return state


def _encode_audit_cursor(created_at: datetime, sync_attempt_id: str) -> str:
    payload = json.dumps(
        {"t": created_at.isoformat(), "id": sync_attempt_id},
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_audit_cursor(cursor: str) -> tuple[datetime, str]:
    pad = "=" * (-len(cursor) % 4)
    try:
        raw = base64.urlsafe_b64decode(cursor + pad)
        data = json.loads(raw.decode("utf-8"))
        created_at = datetime.fromisoformat(str(data["t"]))
        attempt_id = str(data["id"])
    except Exception as err:
        raise HTTPException(
            status_code=422,
            detail="invalid sync-audit cursor",
        ) from err
    if not attempt_id:
        raise HTTPException(status_code=422, detail="invalid sync-audit cursor")
    return created_at, attempt_id


def _audit_item_from_record(record: SyncAuditRecord) -> SyncAuditItem:
    return SyncAuditItem(
        subjectId=record.subject_id,
        deviceId=record.device_id,
        syncAttemptId=record.sync_attempt_id,  # type: ignore[arg-type]
        protocolVersion=record.protocol_version,  # type: ignore[arg-type]
        advisories=[
            SyncAdvisory(code=a["code"], detail=a["detail"])  # type: ignore[arg-type]
            for a in record.advisories
        ],
        stateVectorBefore=dict(record.state_vector_before),  # type: ignore[arg-type]
        stateVectorAfter=dict(record.state_vector_after),  # type: ignore[arg-type]
        createdAt=record.created_at,
    )


@protected.get(
    "/v1/subjects/{subject_id}/sync-audit",
    response_model=SyncAuditPage,
)
async def list_sync_audit(
    subject_id: str,
    query: Annotated[SyncAuditListQuery, Query()],
    caller: CallerCtx,
) -> SyncAuditPage:
    """Read-only keyset-paginated sync_audit history for one subject."""
    assert _store is not None, "lifespan not run"
    if not subject_id.strip():
        raise HTTPException(status_code=422, detail="subject_id must be non-empty")
    enforce_subject_scope(
        caller,
        subject_id,
        route="/v1/subjects/{subject_id}/sync-audit",
        source="path",
    )

    cursor_created_at: datetime | None = None
    cursor_attempt_id: str | None = None
    if query.cursor is not None:
        cursor_created_at, cursor_attempt_id = _decode_audit_cursor(query.cursor)

    try:
        rows = _store.query_sync_audit(
            subject_id,
            limit=query.limit,
            cursor_created_at=cursor_created_at,
            cursor_attempt_id=cursor_attempt_id,
            advisory_code=query.advisory_code,
        )
    except ValueError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err

    has_more = len(rows) > query.limit
    page_rows = rows[: query.limit]
    next_cursor: str | None = None
    if has_more and page_rows:
        last = page_rows[-1]
        next_cursor = _encode_audit_cursor(last.created_at, last.sync_attempt_id)

    logger.info(
        "sync_audit_list subject_id=%s principal_id=%s outcome=ok items=%d "
        "has_more=%s advisory_code=%s",
        subject_id,
        caller.principalId,
        len(page_rows),
        has_more,
        query.advisory_code or "-",
    )
    return SyncAuditPage(
        subjectId=subject_id,
        items=[_audit_item_from_record(r) for r in page_rows],
        nextCursor=next_cursor,
    )


protected.include_router(aggregation_router)
app.include_router(protected)
