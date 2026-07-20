#!/usr/bin/env python3
"""Smoke: FastAPI /v1/sync — subject isolation + idempotent replay."""

from __future__ import annotations

import json
import os
import sys

from fastapi.testclient import TestClient

# Allow `python scripts/smoke.py` from the template root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.main import app  # noqa: E402
from app.wire_models import PROTOCOL_VERSION, CognitiveState, SyncRequest  # noqa: E402

SUBJECT = os.environ.get("SUTRA_SUBJECT_ID", "fastapi-smoke-subject")
DEVICE = os.environ.get("SUTRA_DEVICE_ID", "fastapi-smoke-device")
OTHER = "fastapi-smoke-other"


def emit(event: dict) -> None:
    sys.stdout.write(
        f"{json.dumps({'event': 'integration_templates.fastapi_adapter.smoke', **event})}\n"
    )


def _state(subject_id: str) -> CognitiveState:
    return CognitiveState(
        protocolVersion=PROTOCOL_VERSION,
        subjectId=subject_id,
        deviceIds=[DEVICE],
        profile={
            "ageBand": "adult",
            "track": "cbse-class-7-maths",
            "language": "en-IN",
            "updatedAt": "000000000000001:000001:dev01",
        },
        stateVector={"root": "000000000000001:000001:dev01"},
    )


def main() -> int:
    client = TestClient(app)

    health = client.get("/v1/health")
    assert health.status_code == 200, health.text

    req = SyncRequest(
        protocolVersion=PROTOCOL_VERSION,
        deviceId=DEVICE,
        edgeState=_state(SUBJECT),
        lastKnownCloudVector={},
        syncAttemptId="attempt-1",
    )

    # Cross-subject header mismatch → 403.
    bad = client.post(
        "/v1/sync",
        json=req.model_dump(),
        headers={"x-sutra-subject-id": OTHER},
    )
    if bad.status_code != 403:
        emit(
            {
                "outcome": "fail",
                "subjectId": SUBJECT,
                "deviceId": DEVICE,
                "phase": "authorize",
                "obligation": "integration_templates.fastapi_adapter.smoke.subject_mismatch",
            }
        )
        print(f"expected 403 on subject mismatch, got {bad.status_code}", file=sys.stderr)
        return 1

    first = client.post(
        "/v1/sync",
        json=req.model_dump(),
        headers={"x-sutra-subject-id": SUBJECT},
    )
    if first.status_code != 200:
        emit(
            {
                "outcome": "fail",
                "subjectId": SUBJECT,
                "deviceId": DEVICE,
                "phase": "sync",
                "obligation": "integration_templates.fastapi_adapter.smoke.sync_failed",
            }
        )
        print(first.text, file=sys.stderr)
        return 1

    # Idempotent replay — same syncAttemptId must not diverge.
    mutated = req.model_copy(deep=True)
    mutated.edgeState.mode = "guided"
    second = client.post(
        "/v1/sync",
        json=mutated.model_dump(),
        headers={"x-sutra-subject-id": SUBJECT},
    )
    if second.status_code != 200:
        print(second.text, file=sys.stderr)
        return 1
    if first.json()["mergedState"]["mode"] != second.json()["mergedState"]["mode"]:
        emit(
            {
                "outcome": "fail",
                "subjectId": SUBJECT,
                "deviceId": DEVICE,
                "phase": "idempotency",
                "obligation": "integration_templates.fastapi_adapter.smoke.replay_diverged",
            }
        )
        print("idempotent replay diverged", file=sys.stderr)
        return 1

    emit(
        {
            "outcome": "ok",
            "subjectId": SUBJECT,
            "deviceId": DEVICE,
            "phase": "smoke",
        }
    )
    print("smoke OK: fastapi-adapter /v1/sync")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
