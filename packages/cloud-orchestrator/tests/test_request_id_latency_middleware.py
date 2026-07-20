"""Request-id + latency middleware."""

from __future__ import annotations

import importlib
import logging
import uuid

import pytest
from fastapi.testclient import TestClient
from starlette.responses import StreamingResponse

from sutra_orchestrator.middleware import (
    REQUEST_ID_HEADER,
    RequestIdLatencyMiddleware,
    current_request_id,
    get_latency_recorder,
    reset_http_error_counter_for_tests,
    reset_latency_recorder_for_tests,
    resolve_request_id,
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


def test_happy_path_health_echoes_request_id_without_latency_sample(
    client: TestClient,
) -> None:
    res = client.get("/v1/health")
    assert res.status_code == 200
    rid = res.headers.get(REQUEST_ID_HEADER)
    assert rid is not None
    uuid.UUID(rid)  # raises if malformed
    # Health bypasses heavy latency recording.
    samples = get_latency_recorder().samples()
    assert not any(s.route == "/v1/health" for s in samples)


def test_happy_path_protected_route_records_latency_and_request_id(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="sutra.orchestrator.middleware"):
        res = client.get("/v1/subjects/missing-subj/state", headers=AUTH_HEADER)
    assert res.status_code == 404
    rid = res.headers[REQUEST_ID_HEADER]
    uuid.UUID(rid)
    samples = [
        s
        for s in get_latency_recorder().samples()
        if s.route == "/v1/subjects/{subject_id}/state"
    ]
    assert len(samples) >= 1
    assert samples[-1].request_id == rid
    assert samples[-1].status_code == 404
    assert samples[-1].latency_ms >= 0.0
    assert any("http.request_complete" in r.message and rid in r.message for r in caplog.records)


def test_edge_inbound_valid_request_id_is_echoed(client: TestClient) -> None:
    inbound = str(uuid.uuid4())
    res = client.get(
        "/v1/health",
        headers={REQUEST_ID_HEADER: inbound},
    )
    assert res.headers[REQUEST_ID_HEADER] == inbound


def test_edge_invalid_inbound_request_id_replaced(client: TestClient) -> None:
    res = client.get(
        "/v1/health",
        headers={REQUEST_ID_HEADER: "not-a-uuid;;;SECRET"},
    )
    rid = res.headers[REQUEST_ID_HEADER]
    uuid.UUID(rid)
    assert rid != "not-a-uuid;;;SECRET"
    assert "SECRET" not in rid


def test_edge_streaming_records_first_byte_and_stream_duration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Streaming: first-byte latency + separate stream-duration histogram."""
    from fastapi import FastAPI

    reset_latency_recorder_for_tests()
    app = FastAPI()
    app.add_middleware(RequestIdLatencyMiddleware)

    @app.get("/v1/stream-demo")
    async def stream_demo() -> StreamingResponse:
        async def gen():
            yield b"chunk-a"
            yield b"chunk-b"

        return StreamingResponse(gen(), media_type="text/plain")

    with TestClient(app) as c:
        res = c.get("/v1/stream-demo")
    assert res.status_code == 200
    uuid.UUID(res.headers[REQUEST_ID_HEADER])
    rec = get_latency_recorder()
    kinds = {s.kind for s in rec.samples()}
    assert "first_byte" in kinds
    assert "stream" in kinds
    assert len(rec.stream_durations_ms()) >= 1


def test_sovereignty_latency_samples_never_hold_request_bodies(
    client: TestClient,
) -> None:
    secret = "GOLDEN_UTTERANCE_MUST_NOT_APPEAR"
    res = client.post(
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
    # Auth/validation/404 are fine — we only care that samples stay metadata-only.
    assert res.headers.get(REQUEST_ID_HEADER)
    blob = repr(get_latency_recorder().samples())
    assert secret not in blob
    assert "utterance" not in blob


def test_unit_resolve_and_route_helpers() -> None:
    assert resolve_request_id(None)
    fixed = "11111111-1111-4111-8111-111111111111"
    assert resolve_request_id({REQUEST_ID_HEADER: fixed}) == fixed
    assert current_request_id() is None
