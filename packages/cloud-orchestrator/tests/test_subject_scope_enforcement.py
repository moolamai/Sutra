"""Subject scope on path/body subjectId."""

from __future__ import annotations

import importlib
import json
import logging
import uuid

import pytest
from fastapi.testclient import TestClient

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.contract_models import (
    AgentTurnRequest,
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
    SyncRequest,
)

AUTH = {"X-API-Key": "scoped-key"}


def _hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


def _state(subject_id: str, *, device: str = "edge-aaaa") -> CognitiveState:
    return CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        deviceIds=[device],
        activeConceptId="math.ratios",
        mode="exploratory",
        mastery={
            "math.ratios": ConceptMastery(
                conceptId="math.ratios",
                alpha={device: 3.0},
                beta={device: 1.0},
                lastExercisedAt=_hlc(1_000_000, 0, device),
            )
        },
        frictionLog=[
            FrictionSample(
                conceptId="math.ratios",
                hesitationMs=100,
                inputVelocity=1.0,
                revisionCount=0,
                assistanceRequested=False,
                outcome="correct",
                capturedAt=_hlc(1_000_000, 1, device),
            )
        ],
        profile=SubjectProfile(
            ageBand="child",
            track="cbse-class-7-maths",
            language="hi-IN",
            updatedAt=_hlc(1_000_000, 2, device),
        ),
        stateVector={"session": _hlc(1_000_000, 3, device)},
    )


@pytest.fixture()
def api_key_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    keys = {
        "scoped-key": {
            "principalId": "teacher-1",
            "subjectScope": ["anika-k"],
        }
    }
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "api_key")
    monkeypatch.setenv("SUTRA_API_KEYS_JSON", json.dumps(keys))
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    with TestClient(main_mod.app) as c:
        yield c


def test_happy_path_in_scope_body_subject_allowed(
    api_key_client: TestClient,
) -> None:
    edge = _state("anika-k")
    req = SyncRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        deviceId="edge-aaaa",
        edgeState=edge,
        lastKnownCloudVector={},
        syncAttemptId=str(uuid.uuid4()),
    )
    res = api_key_client.post(
        "/v1/sync",
        json=req.model_dump(mode="json"),
        headers=AUTH,
    )
    assert res.status_code == 200
    assert res.json()["mergedState"]["subjectId"] == "anika-k"


def test_edge_body_subject_out_of_scope_sync_403(
    api_key_client: TestClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    edge = _state("foreign-student")
    req = SyncRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        deviceId="edge-aaaa",
        edgeState=edge,
        lastKnownCloudVector={},
        syncAttemptId=str(uuid.uuid4()),
    )
    with caplog.at_level(logging.WARNING, logger="sutra_orchestrator.auth"):
        res = api_key_client.post(
            "/v1/sync",
            json=req.model_dump(mode="json"),
            headers=AUTH,
        )
    assert res.status_code == 403
    assert res.json()["detail"]["code"] == "FORBIDDEN_SUBJECT_SCOPE"
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "auth_scope_audit" in joined
    assert "outcome=forbidden" in joined
    assert "source=body" in joined
    assert "route=/v1/sync" in joined
    assert "subject_id=foreign-student" in joined
    assert "principal_id=teacher-1" in joined
    assert "device_id=edge-aaaa" in joined
    assert "frictionLog" not in joined
    assert "utterance" not in joined


def test_edge_body_subject_out_of_scope_agent_turn_403(
    api_key_client: TestClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    friction = FrictionSample(
        conceptId="math.ratios",
        hesitationMs=100,
        inputVelocity=1.0,
        revisionCount=0,
        assistanceRequested=False,
        outcome="correct",
        capturedAt=_hlc(1_000_000, 1, "edge-aaaa"),
    )
    req = AgentTurnRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId="foreign-student",
        sessionId="sess-1",
        utterance="what is a ratio?",
        friction=friction,
    )
    with caplog.at_level(logging.WARNING, logger="sutra_orchestrator.auth"):
        res = api_key_client.post(
            "/v1/agent/turn",
            json=req.model_dump(mode="json"),
            headers=AUTH,
        )
    assert res.status_code == 403
    assert res.json()["detail"]["code"] == "FORBIDDEN_SUBJECT_SCOPE"
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "auth_scope_audit" in joined
    assert "source=body" in joined
    assert "route=/v1/agent/turn" in joined
    # Utterance must not appear in the audit stream.
    assert "what is a ratio" not in joined


def test_edge_path_subject_out_of_scope_audited(
    api_key_client: TestClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger="sutra_orchestrator.auth"):
        res = api_key_client.get(
            "/v1/subjects/other-student/sync-audit",
            headers=AUTH,
        )
    assert res.status_code == 403
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "auth_scope_audit" in joined
    assert "source=path" in joined
    assert "subject_id=other-student" in joined


def test_edge_missing_credentials_still_401_not_403(
    api_key_client: TestClient,
) -> None:
    res = api_key_client.post(
        "/v1/sync",
        json=SyncRequest(
            protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
            deviceId="edge-aaaa",
            edgeState=_state("anika-k"),
            lastKnownCloudVector={},
            syncAttemptId=str(uuid.uuid4()),
        ).model_dump(mode="json"),
    )
    assert res.status_code == 401
    assert res.json()["detail"]["code"] == "MISSING_CREDENTIALS"
