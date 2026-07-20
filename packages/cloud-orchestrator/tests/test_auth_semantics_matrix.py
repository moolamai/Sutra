"""Auth semantics test matrix.

Matrix (exact status codes — never conflated):

| Case                         | Expected |
|------------------------------|----------|
| no credential                | 401      |
| garbage credential           | 401      |
| valid, out-of-scope subject  | 403      |
| valid, in-scope subject      | 200      |
| /v1/health unauthenticated   | 200      |

Applies across protected /v1 routes; health is the only auth opt-out.
"""

from __future__ import annotations

import importlib
import json
import logging
import uuid
from typing import Any, Callable

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

IN_SCOPE = "anika-k"
OUT_SCOPE = "foreign-student"
SCOPED_KEY = "scoped-key"
GARBAGE_KEY = "%%%not-a-real-key%%%"


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


def _sync_payload(subject_id: str) -> dict[str, Any]:
    return SyncRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        deviceId="edge-aaaa",
        edgeState=_state(subject_id),
        lastKnownCloudVector={},
        syncAttemptId=str(uuid.uuid4()),
    ).model_dump(mode="json")


def _turn_payload(subject_id: str) -> dict[str, Any]:
    return AgentTurnRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        sessionId="sess-matrix-1",
        utterance="what is a ratio?",
        friction=FrictionSample(
            conceptId="math.ratios",
            hesitationMs=100,
            inputVelocity=1.0,
            revisionCount=0,
            assistanceRequested=False,
            outcome="correct",
            capturedAt=_hlc(1_000_000, 1, "edge-aaaa"),
        ),
    ).model_dump(mode="json")


@pytest.fixture()
def matrix_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """API-key verifier with a single in-scope subject — production-shaped matrix."""
    keys = {
        SCOPED_KEY: {
            "principalId": "teacher-1",
            "subjectScope": [IN_SCOPE],
        }
    }
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "api_key")
    monkeypatch.setenv("SUTRA_API_KEYS_JSON", json.dumps(keys))
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    with TestClient(main_mod.app) as client:
        yield client


def _seed_in_scope(client: TestClient) -> None:
    """Create master state for the in-scope subject so agent-turn/state can 200."""
    res = client.post(
        "/v1/sync",
        json=_sync_payload(IN_SCOPE),
        headers={"X-API-Key": SCOPED_KEY},
    )
    assert res.status_code == 200, res.text


# Route factories: (name, call) → Response
RouteCaller = Callable[[TestClient, str | None, str], Any]


def _call_health(client: TestClient, _subject: str | None, key: str) -> Any:
    headers = {"X-API-Key": key} if key else None
    return client.get("/v1/health", headers=headers)


def _call_state(client: TestClient, subject: str | None, key: str) -> Any:
    sid = subject or IN_SCOPE
    headers = {"X-API-Key": key} if key else None
    return client.get(f"/v1/subjects/{sid}/state", headers=headers)


def _call_audit(client: TestClient, subject: str | None, key: str) -> Any:
    sid = subject or IN_SCOPE
    headers = {"X-API-Key": key} if key else None
    return client.get(f"/v1/subjects/{sid}/sync-audit", headers=headers)


def _call_sync(client: TestClient, subject: str | None, key: str) -> Any:
    sid = subject or IN_SCOPE
    headers = {"X-API-Key": key} if key else None
    return client.post("/v1/sync", json=_sync_payload(sid), headers=headers)


def _call_turn(client: TestClient, subject: str | None, key: str) -> Any:
    sid = subject or IN_SCOPE
    headers = {"X-API-Key": key} if key else None
    return client.post("/v1/agent/turn", json=_turn_payload(sid), headers=headers)


PROTECTED_ROUTES: list[tuple[str, RouteCaller]] = [
    ("GET /v1/subjects/{id}/state", _call_state),
    ("GET /v1/subjects/{id}/sync-audit", _call_audit),
    ("POST /v1/sync", _call_sync),
    ("POST /v1/agent/turn", _call_turn),
]


def test_matrix_health_unauthenticated_is_200(matrix_client: TestClient) -> None:
    res = matrix_client.get("/v1/health")
    assert res.status_code == 200
    assert res.json()["status"] == "degraded"
    assert res.json()["components"]["redis"]["status"] == "absent"
    assert res.json().get("auth_backend") == "static_api_key"


@pytest.mark.parametrize("route_name,call", PROTECTED_ROUTES, ids=[r[0] for r in PROTECTED_ROUTES])
def test_matrix_no_credential_is_401(
    matrix_client: TestClient,
    route_name: str,
    call: RouteCaller,
) -> None:
    res = call(matrix_client, IN_SCOPE, "")
    assert res.status_code == 401, f"{route_name}: expected 401, got {res.status_code}"
    assert res.json()["detail"]["code"] == "MISSING_CREDENTIALS"
    # Never a 403 mislabel for missing AuthN.
    assert res.status_code != 403


@pytest.mark.parametrize("route_name,call", PROTECTED_ROUTES, ids=[r[0] for r in PROTECTED_ROUTES])
def test_matrix_garbage_credential_is_401(
    matrix_client: TestClient,
    route_name: str,
    call: RouteCaller,
) -> None:
    res = call(matrix_client, IN_SCOPE, GARBAGE_KEY)
    assert res.status_code == 401, f"{route_name}: expected 401, got {res.status_code}"
    assert res.json()["detail"]["code"] == "INVALID_CREDENTIALS"
    assert res.status_code != 403
    assert res.status_code != 500


@pytest.mark.parametrize("route_name,call", PROTECTED_ROUTES, ids=[r[0] for r in PROTECTED_ROUTES])
def test_matrix_valid_out_of_scope_is_403(
    matrix_client: TestClient,
    route_name: str,
    call: RouteCaller,
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger="sutra_orchestrator.auth"):
        res = call(matrix_client, OUT_SCOPE, SCOPED_KEY)
    assert res.status_code == 403, f"{route_name}: expected 403, got {res.status_code}"
    assert res.json()["detail"]["code"] == "FORBIDDEN_SUBJECT_SCOPE"
    # AuthN succeeded — must not be 401.
    assert res.status_code != 401
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "auth_scope_audit" in joined
    assert f"subject_id={OUT_SCOPE}" in joined
    assert "frictionLog" not in joined
    assert "utterance" not in joined
    assert "what is a ratio" not in joined


@pytest.mark.parametrize("route_name,call", PROTECTED_ROUTES, ids=[r[0] for r in PROTECTED_ROUTES])
def test_matrix_valid_in_scope_is_200(
    matrix_client: TestClient,
    route_name: str,
    call: RouteCaller,
) -> None:
    _seed_in_scope(matrix_client)
    res = call(matrix_client, IN_SCOPE, SCOPED_KEY)
    assert res.status_code == 200, (
        f"{route_name}: expected 200, got {res.status_code} body={res.text[:200]}"
    )


def test_matrix_only_health_opts_out_of_auth(matrix_client: TestClient) -> None:
    """Sovereignty: protected families require AuthN; health + metrics do not."""
    assert matrix_client.get("/v1/health").status_code == 200
    assert matrix_client.get("/v1/metrics").status_code == 200
    for route_name, call in PROTECTED_ROUTES:
        res = call(matrix_client, IN_SCOPE, "")
        assert res.status_code == 401, f"{route_name} must not be open"


def test_matrix_cross_subject_isolation_negative(
    matrix_client: TestClient,
) -> None:
    """In-scope key cannot read another subject's state (403, not 404 leak)."""
    _seed_in_scope(matrix_client)
    # Ensure foreign subject has never been written by this caller.
    res = matrix_client.get(
        f"/v1/subjects/{OUT_SCOPE}/state",
        headers={"X-API-Key": SCOPED_KEY},
    )
    assert res.status_code == 403
    assert res.json()["detail"]["code"] == "FORBIDDEN_SUBJECT_SCOPE"


def test_edge_idempotent_replay_still_in_scope_200(
    matrix_client: TestClient,
) -> None:
    """Replayed sync with same attempt stays 200 under scope (no 401/403 flap)."""
    payload = _sync_payload(IN_SCOPE)
    headers = {"X-API-Key": SCOPED_KEY}
    first = matrix_client.post("/v1/sync", json=payload, headers=headers)
    second = matrix_client.post("/v1/sync", json=payload, headers=headers)
    assert first.status_code == 200
    assert second.status_code == 200
