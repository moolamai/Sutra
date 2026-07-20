"""Error taxonomy metrics."""

from __future__ import annotations

import importlib
import logging
import uuid

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from sutra_orchestrator.middleware import (
    ERROR_CLASS_AUTH,
    ERROR_CLASS_CLIENT,
    ERROR_CLASS_SERVER,
    ERROR_CLASS_TIMEOUT,
    ERROR_CLASS_VALIDATION,
    ERROR_CLASSES,
    REQUEST_ID_HEADER,
    SUTRA_HTTP_ERRORS_METRIC,
    RequestIdLatencyMiddleware,
    classify_http_error,
    get_http_error_counter,
    reset_http_error_counter_for_tests,
    reset_latency_recorder_for_tests,
)


AUTH_HEADER = {"X-API-Key": "test-dev-key"}


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.delenv("SUTRA_API_KEYS_JSON", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "permissive_dev")
    reset_latency_recorder_for_tests()
    reset_http_error_counter_for_tests()
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    with TestClient(main_mod.app) as c:
        yield c
    reset_latency_recorder_for_tests()
    reset_http_error_counter_for_tests()


def test_unit_classify_http_error_distinct_classes() -> None:
    assert classify_http_error(200) is None
    assert classify_http_error(401) == ERROR_CLASS_AUTH
    assert classify_http_error(403) == ERROR_CLASS_AUTH
    assert classify_http_error(422) == ERROR_CLASS_VALIDATION
    assert classify_http_error(408) == ERROR_CLASS_TIMEOUT
    assert classify_http_error(504) == ERROR_CLASS_TIMEOUT
    assert classify_http_error(404) == ERROR_CLASS_CLIENT
    assert classify_http_error(400) == ERROR_CLASS_CLIENT
    assert classify_http_error(500) == ERROR_CLASS_SERVER
    assert classify_http_error(503) == ERROR_CLASS_SERVER
    # Never a generic "error" bucket.
    for code in (401, 403, 404, 408, 422, 500, 504):
        assert classify_http_error(code) != "error"
        assert classify_http_error(code) in ERROR_CLASSES


def test_happy_path_404_counts_as_client(client: TestClient) -> None:
    res = client.get("/v1/subjects/missing-subj/state", headers=AUTH_HEADER)
    assert res.status_code == 404
    uuid.UUID(res.headers[REQUEST_ID_HEADER])
    counter = get_http_error_counter()
    assert counter.count(ERROR_CLASS_CLIENT, "/v1/subjects/{subject_id}/state") >= 1
    assert counter.total(ERROR_CLASS_SERVER) == 0
    assert all(cls != "error" for cls, _ in counter.snapshot())


def test_edge_auth_401_counts_as_auth_without_credentials(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    import json

    from sutra_orchestrator.auth import StaticApiKeyVerifier

    keys = {
        "correct-secret": {
            "principalId": "teacher-1",
            "subjectScope": ["anika-k"],
        }
    }
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "api_key")
    monkeypatch.setenv("SUTRA_API_KEYS_JSON", json.dumps(keys))
    reset_http_error_counter_for_tests()
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    secret = "WRONG_SECRET_MUST_NOT_APPEAR"
    with caplog.at_level(logging.INFO, logger="sutra.orchestrator.middleware"):
        with TestClient(main_mod.app) as c:
            assert isinstance(c.app.state.auth_verifier, StaticApiKeyVerifier)
            res = c.get(
                "/v1/subjects/anika-k/state",
                headers={"X-API-Key": secret},
            )
    assert res.status_code == 401
    assert (
        get_http_error_counter().count(
            ERROR_CLASS_AUTH, "/v1/subjects/{subject_id}/state"
        )
        >= 1
    )
    blob = repr(get_http_error_counter().snapshot()) + " ".join(
        r.message for r in caplog.records
    )
    assert secret not in blob
    assert "correct-secret" not in blob
    assert any(SUTRA_HTTP_ERRORS_METRIC in r.message for r in caplog.records)
    reset_http_error_counter_for_tests()


def test_edge_validation_422_not_server(client: TestClient) -> None:
    res = client.post(
        "/v1/agent/turn",
        headers={**AUTH_HEADER, "Content-Type": "application/json"},
        json={"not": "a-valid-agent-turn"},
    )
    assert res.status_code == 422
    counter = get_http_error_counter()
    assert counter.total(ERROR_CLASS_VALIDATION) >= 1
    assert counter.total(ERROR_CLASS_SERVER) == 0


def test_edge_timeout_504_via_handler(client: TestClient) -> None:
    """TimeoutError handler maps to 504 → timeout class (not server)."""
    from sutra_orchestrator import main as main_mod

    @main_mod.app.get("/v1/__test_timeout")
    async def _boom() -> None:
        raise TimeoutError("simulated upstream")

    res = client.get("/v1/__test_timeout", headers=AUTH_HEADER)
    assert res.status_code == 504
    assert get_http_error_counter().total(ERROR_CLASS_TIMEOUT) >= 1
    assert get_http_error_counter().total(ERROR_CLASS_SERVER) == 0


def test_edge_unhandled_5xx_counts_as_server() -> None:
    reset_http_error_counter_for_tests()
    app = FastAPI()
    app.add_middleware(RequestIdLatencyMiddleware)

    @app.get("/v1/boom")
    async def boom() -> None:
        raise RuntimeError("forced failure")

    with TestClient(app, raise_server_exceptions=False) as c:
        res = c.get("/v1/boom")
    assert res.status_code == 500
    assert get_http_error_counter().count(ERROR_CLASS_SERVER, "/v1/boom") >= 1
    assert get_http_error_counter().total(ERROR_CLASS_VALIDATION) == 0
    reset_http_error_counter_for_tests()


def test_edge_health_200_does_not_increment_errors(client: TestClient) -> None:
    before = get_http_error_counter().total()
    res = client.get("/v1/health")
    assert res.status_code == 200
    assert get_http_error_counter().total() == before


def test_sovereignty_counter_never_holds_utterance(client: TestClient) -> None:
    secret = "GOLDEN_UTTERANCE_MUST_NOT_APPEAR_IN_ERRORS"
    client.post(
        "/v1/agent/turn",
        headers={**AUTH_HEADER, "Content-Type": "application/json"},
        json={
            "protocolVersion": "1.0.0",
            "subjectId": "anika-k",
            "sessionId": "sess-1",
            "utterance": secret,
            "friction": {
                "conceptId": "math.ratios",
                "hesitationMs": 1,
                "inputVelocity": 1.0,
                "revisionCount": 0,
                "assistanceRequested": False,
                "outcome": "ungraded",
                "capturedAt": "000001700000000:000000:edge-aaaa",
            },
        },
    )
    blob = repr(get_http_error_counter().snapshot())
    assert secret not in blob
    assert "utterance" not in blob


def test_http_exception_status_mapped_on_mini_app() -> None:
    reset_http_error_counter_for_tests()
    app = FastAPI()
    app.add_middleware(RequestIdLatencyMiddleware)

    @app.get("/v1/forbid")
    async def forbid() -> None:
        raise HTTPException(status_code=403, detail="nope")

    with TestClient(app) as c:
        assert c.get("/v1/forbid").status_code == 403
    assert get_http_error_counter().count(ERROR_CLASS_AUTH, "/v1/forbid") >= 1
    reset_http_error_counter_for_tests()
