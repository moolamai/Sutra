"""POST /v1/agent/turn/{id}/abort — accept-vs-abort race fixtures (CK-07)."""

from __future__ import annotations

import importlib
import json
import logging
import uuid

import pytest
from fastapi.testclient import TestClient

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.abort_pipeline import (
    ABORT_REASON_MANUAL,
    AGENT_MANUAL_ABORT_AUDIT_EVENT,
    InProcessFakeDurableEffects,
    clear_abort_registry_for_tests,
    get_abort_audit_sink,
    get_abort_pipeline,
)
from sutra_orchestrator.contract_models import (
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
    SyncRequest,
)
from sutra_orchestrator.streaming_turn_host import clear_inflight_for_tests

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


@pytest.fixture()
def abort_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
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


def test_happy_path_stream_exposes_turn_id_header(abort_client: TestClient) -> None:
    _seed_subject(abort_client)
    with abort_client.stream(
        "POST",
        "/v1/agent/turn/stream",
        json=_turn_payload(),
        headers={**AUTH, "X-Device-Id": "edge-aaaa"},
    ) as res:
        assert res.status_code == 200
        turn_id = res.headers.get("x-turn-id") or res.headers.get("X-Turn-Id")
        assert turn_id and turn_id.startswith("turn-")
        body = res.read().decode("utf-8")
    assert "TURN_COMPLETE" in body


def test_race_abort_before_complete_wins_zero_durable_effects(
    abort_client: TestClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Race fixture A: abort before TURN_COMPLETE → aborted + zero durable."""
    _seed_subject(abort_client)
    durable = InProcessFakeDurableEffects()
    pipeline = get_abort_pipeline()
    turn_id = "turn-race-before"
    ok, handle, fc, detail = pipeline.register_turn(
        turn_id=turn_id,
        subject_id="anika-k",
        device_id="edge-aaaa",
    )
    assert ok and handle is not None, (fc, detail)

    durable.apply("write-race")
    appended_ok, _, app_detail = handle.append_effect(
        effect_id="write-race",
        tool_name="persist",
        idempotency_key="idem-race-before",
        risk_class="write",
        mid_write=True,
        compensate=lambda entry, _ctx: durable.compensate(entry.effect_id),
    )
    assert appended_ok, app_detail
    assert durable.has("write-race")
    assert pipeline.locks.is_held("idem-race-before")

    with caplog.at_level(logging.INFO):
        res = abort_client.post(
            f"/v1/agent/turn/{turn_id}/abort",
            json={"subjectId": "anika-k", "reason": ABORT_REASON_MANUAL},
            headers={**AUTH, "X-Device-Id": "edge-aaaa"},
        )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["action"] == "aborted"
    assert body["signalCascaded"] is True
    assert body["rolledBackCount"] == 1
    assert body["locksReleased"] >= 1
    assert body["status"] == "aborted"
    assert durable.size == 0
    assert not pipeline.locks.is_held("idem-race-before")
    joined = "\n".join(r.getMessage() for r in caplog.records)
    assert "agent_turn_abort outcome=ok" in joined
    assert "turn_id=turn-race-before" in joined
    assert "partial" not in joined  # no raw effect payload in logs


def test_race_abort_after_turn_complete_returns_already_completed(
    abort_client: TestClient,
) -> None:
    """Race fixture B: abort after committed TURN_COMPLETE → already_completed."""
    _seed_subject(abort_client)
    pipeline = get_abort_pipeline()
    turn_id = "turn-race-after"
    ok, handle, _, _ = pipeline.register_turn(
        turn_id=turn_id,
        subject_id="anika-k",
        device_id="edge-aaaa",
    )
    assert ok and handle is not None
    handle.append_effect(effect_id="committed-1", idempotency_key="idem-done")
    handle.mark_effect_committed("committed-1")
    done_ok, done_fc, done_detail = pipeline.mark_turn_completed(
        turn_id,
        subject_id="anika-k",
        effects_committed=True,
    )
    assert done_ok, (done_fc, done_detail)

    res = abort_client.post(
        f"/v1/agent/turn/{turn_id}/abort",
        json={"subjectId": "anika-k"},
        headers=AUTH,
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["action"] == "already_completed"
    assert body["signalCascaded"] is False
    assert body["status"] == "completed"


def test_edge_double_abort_idempotent(abort_client: TestClient) -> None:
    pipeline = get_abort_pipeline()
    turn_id = "turn-dbl-abort"
    ok, handle, _, _ = pipeline.register_turn(
        turn_id=turn_id, subject_id="anika-k"
    )
    assert ok and handle is not None
    handle.append_effect(effect_id="e1", idempotency_key="idem-dbl")

    first = abort_client.post(
        f"/v1/agent/turn/{turn_id}/abort",
        json={"subjectId": "anika-k"},
        headers=AUTH,
    )
    second = abort_client.post(
        f"/v1/agent/turn/{turn_id}/abort",
        json={"subjectId": "anika-k"},
        headers=AUTH,
    )
    assert first.status_code == 200
    assert first.json()["action"] == "aborted"
    assert second.status_code == 200
    assert second.json()["action"] == "already_aborted"
    assert second.json()["signalCascaded"] is False


def test_edge_abort_missing_turn_404(abort_client: TestClient) -> None:
    res = abort_client.post(
        "/v1/agent/turn/turn-missing/abort",
        json={"subjectId": "anika-k"},
        headers=AUTH,
    )
    assert res.status_code == 404
    assert res.json()["detail"]["code"] == "TURN_NOT_FOUND"


def test_sovereignty_cross_subject_abort_403(abort_client: TestClient) -> None:
    pipeline = get_abort_pipeline()
    turn_id = "turn-iso"
    assert pipeline.register_turn(turn_id=turn_id, subject_id="anika-k")[0]

    # Caller only scoped to anika-k — cannot abort for other-learner body.
    res = abort_client.post(
        f"/v1/agent/turn/{turn_id}/abort",
        json={"subjectId": "other-learner"},
        headers=AUTH,
    )
    assert res.status_code == 403
    assert res.json()["detail"]["code"] == "FORBIDDEN_SUBJECT_SCOPE"
    # Turn still active for the real owner.
    assert get_abort_pipeline().get_handle(turn_id, "anika-k") is not None


def test_scalability_abort_after_completed_stream(abort_client: TestClient) -> None:
    """Operator path: finish SSE, then abort same turnId → already_completed."""
    _seed_subject(abort_client)
    payload = _turn_payload()
    with abort_client.stream(
        "POST",
        "/v1/agent/turn/stream",
        json=payload,
        headers=AUTH,
    ) as res:
        assert res.status_code == 200
        turn_id = res.headers.get("x-turn-id") or res.headers.get("X-Turn-Id")
        assert turn_id
        res.read()

    abort_res = abort_client.post(
        f"/v1/agent/turn/{turn_id}/abort",
        json={"subjectId": "anika-k"},
        headers=AUTH,
    )
    assert abort_res.status_code == 200, abort_res.text
    assert abort_res.json()["action"] == "already_completed"
    assert abort_res.json()["auditRecorded"] is False
    assert get_abort_audit_sink().size == 0


def test_integration_agent_manual_abort_audit_and_zero_partial_effects(
    abort_client: TestClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Successful abort → AGENT_MANUAL_ABORT audit + zero durable side effects."""
    _seed_subject(abort_client)
    durable = InProcessFakeDurableEffects()
    pipeline = get_abort_pipeline()
    sink = get_abort_audit_sink()
    turn_id = "turn-audit-int"

    ok, handle, _, _ = pipeline.register_turn(
        turn_id=turn_id,
        subject_id="anika-k",
        device_id="edge-aaaa",
    )
    assert ok and handle is not None
    durable.apply("write-audit")
    handle.append_effect(
        effect_id="write-audit",
        tool_name="persist",
        idempotency_key="idem-audit-int",
        risk_class="write",
        mid_write=True,
        compensate=lambda entry, _ctx: durable.compensate(entry.effect_id),
    )

    with caplog.at_level(logging.INFO):
        res = abort_client.post(
            f"/v1/agent/turn/{turn_id}/abort",
            json={"subjectId": "anika-k", "reason": ABORT_REASON_MANUAL},
            headers={**AUTH, "X-Device-Id": "edge-aaaa"},
        )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["action"] == "aborted"
    assert body["auditRecorded"] is True
    assert body["rolledBackCount"] == 1
    assert durable.size == 0

    assert sink.size == 1
    row = sink.list()[0]
    assert row.event == AGENT_MANUAL_ABORT_AUDIT_EVENT
    assert row.subject_id == "anika-k"
    assert row.turn_id == turn_id
    assert row.reason == ABORT_REASON_MANUAL
    assert row.device_id == "edge-aaaa"
    assert row.principal_id == "teacher-1"

    joined = "\n".join(r.getMessage() for r in caplog.records)
    assert "action=audit_recorded" in joined
    assert AGENT_MANUAL_ABORT_AUDIT_EVENT in joined
    assert "write-audit" not in joined  # no effect payload / content leak

    # Idempotent: second abort must not append another audit row.
    again = abort_client.post(
        f"/v1/agent/turn/{turn_id}/abort",
        json={"subjectId": "anika-k"},
        headers=AUTH,
    )
    assert again.status_code == 200
    assert again.json()["action"] == "already_aborted"
    assert again.json()["auditRecorded"] is False
    assert sink.size == 1
