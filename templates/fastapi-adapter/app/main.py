"""FastAPI adapter — /v1/sync wire target without forking sutra-orchestrator.

Adopters point a TypeScript SyncTransport at this service. For production,
swap SyncStore for the published sutra-orchestrator SyncService over the
same wire models — do not import orchestrator private modules here.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .sync_store import SyncStore
from .wire_models import PROTOCOL_VERSION, SyncRequest, SyncResponse

app = FastAPI(title="sutra-fastapi-adapter", version="0.1.0")
store = SyncStore()


def emit(event: dict[str, Any]) -> None:
    sys.stdout.write(f"{json.dumps({'event': 'integration_templates.fastapi_adapter', **event})}\n")
    sys.stdout.flush()


@app.get("/v1/health")
def health() -> dict[str, Any]:
    return {"ok": True, "protocolVersion": PROTOCOL_VERSION}


@app.post("/v1/sync", response_model=SyncResponse)
async def sync(request: Request) -> SyncResponse | JSONResponse:
    try:
        payload = await request.json()
    except Exception:
        emit(
            {
                "outcome": "fail",
                "subjectId": None,
                "deviceId": None,
                "phase": "parse",
                "obligation": "integration_templates.fastapi_adapter.invalid_json",
            }
        )
        raise HTTPException(status_code=400, detail="invalid_json") from None

    try:
        req = SyncRequest.model_validate(payload)
    except Exception as err:
        emit(
            {
                "outcome": "fail",
                "subjectId": None,
                "deviceId": None,
                "phase": "validate",
                "obligation": "integration_templates.fastapi_adapter.invalid_request",
            }
        )
        raise HTTPException(status_code=400, detail=str(err)) from err

    subject_id = req.edgeState.subjectId
    device_id = req.deviceId

    # Optional caller-declared subject scope header (sovereignty gate).
    scope = request.headers.get("x-sutra-subject-id")
    if scope is not None and scope.strip() and scope.strip() != subject_id:
        emit(
            {
                "outcome": "fail",
                "subjectId": subject_id,
                "deviceId": device_id,
                "phase": "authorize",
                "obligation": "integration_templates.fastapi_adapter.subject_mismatch",
            }
        )
        raise HTTPException(status_code=403, detail="subjectId mismatch")

    try:
        response = store.apply(req)
    except ValueError as err:
        emit(
            {
                "outcome": "fail",
                "subjectId": subject_id,
                "deviceId": device_id,
                "phase": "apply",
                "obligation": "integration_templates.fastapi_adapter.apply_failed",
            }
        )
        raise HTTPException(status_code=400, detail=str(err)) from err

    emit(
        {
            "outcome": "ok",
            "subjectId": subject_id,
            "deviceId": device_id,
            "phase": "sync",
            "syncAttemptId": req.syncAttemptId,
        }
    )
    return response
