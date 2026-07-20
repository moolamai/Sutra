"""POST /v1/agent/turn/stream — SSE harness frames + CallerContext auth."""

from __future__ import annotations

import importlib
import json
import logging
import re
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.contract_models import (
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    HarnessFrame,
    SubjectProfile,
    SyncRequest,
    assert_monotonic_sequence,
)
from sutra_orchestrator.abort_pipeline import clear_abort_registry_for_tests
from sutra_orchestrator.streaming_turn_host import (
    ENV_SSE_HEARTBEAT_SECONDS,
    SSE_HEARTBEAT_SECONDS_DEFAULT,
    clear_inflight_for_tests,
    end_stream,
    format_sse_heartbeat,
    sse_heartbeat_seconds,
    stream_idempotency_key,
    try_begin_stream,
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


def _turn_payload(subject_id: str = "anika-k") -> dict:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "subjectId": subject_id,
        "sessionId": f"sess-{uuid.uuid4().hex[:8]}",
        "utterance": "what is a ratio",
        "friction": {
            "conceptId": "math.ratios",
            "hesitationMs": 100,
            "inputVelocity": 1.0,
            "revisionCount": 0,
            "assistanceRequested": False,
            "outcome": "correct",
            "capturedAt": _hlc(1_000_000, 4, "edge-aaaa"),
        },
    }


def _parse_sse_frames(body: str) -> list[dict]:
    frames: list[dict] = []
    for block in re.split(r"\n\n+", body.strip()):
        if not block.strip() or block.startswith(":"):
            continue
        data_line = None
        for line in block.split("\n"):
            if line.startswith("data:"):
                data_line = line[len("data:") :].strip()
        if data_line:
            frames.append(json.loads(data_line))
    return frames


@pytest.fixture()
def stream_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
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
    monkeypatch.setenv(ENV_SSE_HEARTBEAT_SECONDS, "0")
    clear_inflight_for_tests()
    clear_abort_registry_for_tests()
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    with TestClient(main_mod.app) as c:
        yield c
    clear_abort_registry_for_tests()
    clear_inflight_for_tests()


def _seed_subject(client: TestClient, subject_id: str = "anika-k") -> None:
    edge = _state(subject_id)
    req = SyncRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        deviceId="edge-aaaa",
        edgeState=edge,
        lastKnownCloudVector={},
        syncAttemptId=str(uuid.uuid4()),
    )
    res = client.post(
        "/v1/sync",
        json=req.model_dump(mode="json"),
        headers=AUTH,
    )
    assert res.status_code == 200, res.text


def test_happy_path_sse_emits_session_answer_complete(
    stream_client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="sutra.orchestrator")
    _seed_subject(stream_client)
    payload = _turn_payload()
    with stream_client.stream(
        "POST",
        "/v1/agent/turn/stream",
        json=payload,
        headers={**AUTH, "X-Device-Id": "edge-aaaa"},
    ) as res:
        assert res.status_code == 200
        assert "text/event-stream" in res.headers.get("content-type", "")
        body = res.read().decode("utf-8")

    frames = _parse_sse_frames(body)
    assert [f["type"] for f in frames] == [
        "SESSION_START",
        "ANSWER_DELTA",
        "TURN_COMPLETE",
    ]
    parsed = [HarnessFrame.model_validate(f).root for f in frames]
    assert assert_monotonic_sequence(parsed) == {"ok": True}
    assert all(f.subjectId == "anika-k" for f in parsed)
    assert all(f.correlationId == payload["sessionId"] for f in parsed)

    joined = "\n".join(r.getMessage() for r in caplog.records)
    assert "agent_turn_stream outcome=ok" in joined
    assert "what is a ratio" not in joined
    assert "subject_id=anika-k" in joined


def test_auth_rejects_missing_credentials(stream_client: TestClient) -> None:
    _seed_subject(stream_client)
    res = stream_client.post(
        "/v1/agent/turn/stream",
        json=_turn_payload(),
    )
    assert res.status_code == 401


def test_sovereignty_cross_subject_forbidden(
    stream_client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    _seed_subject(stream_client)
    res = stream_client.post(
        "/v1/agent/turn/stream",
        json=_turn_payload("foreign-student"),
        headers=AUTH,
    )
    assert res.status_code == 403
    assert res.json()["detail"]["code"] == "FORBIDDEN_SUBJECT_SCOPE"
    joined = "\n".join(r.getMessage() for r in caplog.records)
    assert "auth_scope_audit" in joined
    assert "route=/v1/agent/turn/stream" in joined
    assert "what is a ratio" not in joined


def test_edge_unknown_subject_404_before_stream(stream_client: TestClient) -> None:
    # anika-k is in scope but never synced → no cognitive state
    res = stream_client.post(
        "/v1/agent/turn/stream",
        json=_turn_payload("anika-k"),
        headers=AUTH,
    )
    assert res.status_code == 404
    assert "sync first" in res.json()["detail"]


def test_edge_double_post_idempotency_conflict(stream_client: TestClient) -> None:
    _seed_subject(stream_client)
    payload = _turn_payload()
    headers = {**AUTH, "Idempotency-Key": "idem-fixed-1"}
    key = stream_idempotency_key(
        subject_id=payload["subjectId"],
        session_id=payload["sessionId"],
        idempotency_key="idem-fixed-1",
    )
    # Simulate an in-flight stream (TestClient drains ASGI generators too fast
    # for a reliable open-stream race).
    assert try_begin_stream(key) is True
    try:
        second = stream_client.post(
            "/v1/agent/turn/stream",
            json=payload,
            headers=headers,
        )
        assert second.status_code == 409
        assert second.json()["detail"]["code"] == "STREAM_IN_FLIGHT"
    finally:
        end_stream(key)

    # After release, the same key succeeds.
    with stream_client.stream(
        "POST",
        "/v1/agent/turn/stream",
        json=payload,
        headers=headers,
    ) as res:
        assert res.status_code == 200
        body = res.read().decode("utf-8")
    assert [f["type"] for f in _parse_sse_frames(body)][-1] == "TURN_COMPLETE"


def test_heartbeat_interval_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_SSE_HEARTBEAT_SECONDS, "0.5")
    assert sse_heartbeat_seconds() == 0.5
    monkeypatch.delenv(ENV_SSE_HEARTBEAT_SECONDS, raising=False)
    assert sse_heartbeat_seconds() == SSE_HEARTBEAT_SECONDS_DEFAULT
    assert format_sse_heartbeat() == ":heartbeat\n\n"


def test_scalability_concurrent_streams_different_keys(
    stream_client: TestClient,
) -> None:
    _seed_subject(stream_client)

    def _one(i: int) -> list[str]:
        payload = _turn_payload()
        payload["sessionId"] = f"sess-conc-{i}"
        with stream_client.stream(
            "POST",
            "/v1/agent/turn/stream",
            json=payload,
            headers={**AUTH, "Idempotency-Key": f"key-{i}"},
        ) as res:
            assert res.status_code == 200
            body = res.read().decode("utf-8")
        return [f["type"] for f in _parse_sse_frames(body)]

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(_one, range(4)))
    assert all(r == ["SESSION_START", "ANSWER_DELTA", "TURN_COMPLETE"] for r in results)
