"""Cloud LLM provider-down degradation (ATR-05 directive fallback).

Stub model adapter timeout → directive-only reply, routing rationale,
HTTP 200 with freshness marker — never 500/504 for model timeout.
"""

from __future__ import annotations

import importlib
import logging

import pytest
from fastapi.testclient import TestClient

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.agent_runtime import AgentRuntime
from sutra_orchestrator.contract_models import (
    AgentTurnRequest,
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
)
from sutra_orchestrator.model_provider import DeterministicFakeProvider
from sutra_orchestrator.sync_service import InMemoryMasterStateStore
from sutra_orchestrator.task_router import TaskRouter, demo_task_graph

AUTH_HEADER = {"X-API-Key": "test-dev-key"}


def hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


def make_state(subject_id: str) -> CognitiveState:
    device = "cloud-degr-a"
    return CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        deviceIds=[device],
        activeConceptId="math.ratios",
        mode="exploratory",
        mastery={
            "math.ratios": ConceptMastery(
                conceptId="math.ratios",
                alpha={device: 2.0},
                beta={device: 2.0},
                lastExercisedAt=hlc(1_700_000_000_000, 0, device),
            ),
            "math.fractions": ConceptMastery(
                conceptId="math.fractions",
                alpha={device: 5.0},
                beta={device: 1.0},
                lastExercisedAt=hlc(1_700_000_000_000, 1, device),
            ),
        },
        frictionLog=[],
        profile=SubjectProfile(
            ageBand="child",
            track="cbse-class-7-maths",
            language="hi-IN",
            updatedAt=hlc(1_700_000_000_000, 2, device),
        ),
        stateVector={"session": hlc(1_700_000_000_000, 3, device)},
    )


def turn_body(subject_id: str, utterance: str = "hello ratios") -> dict:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "subjectId": subject_id,
        "sessionId": "sess-degr",
        "utterance": utterance,
        "friction": {
            "conceptId": "math.ratios",
            "hesitationMs": 800,
            "inputVelocity": 3.0,
            "revisionCount": 0,
            "assistanceRequested": False,
            "outcome": "correct",
            "capturedAt": hlc(1_700_000_000_100, 0, "edge-degr"),
        },
    }


@pytest.fixture()
def client_timeout(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.delenv("SUTRA_API_KEYS_JSON", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "permissive_dev")
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    with TestClient(main_mod.app) as c:
        assert main_mod._store is not None
        assert main_mod._runtime is not None
        subject = "subj-llm-down-http"
        main_mod._store.put(make_state(subject))
        # Inject force-timeout provider — production ModelProvider seam, not a
        # registry backdoor.
        main_mod._runtime = AgentRuntime(
            TaskRouter(demo_task_graph(), redis_url=None),
            main_mod._store,
            model_provider=DeterministicFakeProvider(force_timeout=True),
        )
        yield c


def test_happy_path_http_200_directive_freshness_not_500(
    client_timeout: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    subject = "subj-llm-down-http"
    with caplog.at_level(logging.INFO):
        res = client_timeout.post(
            "/v1/agent/turn",
            headers=AUTH_HEADER,
            json=turn_body(subject),
        )
    assert res.status_code == 200, res.text
    assert res.status_code != 500
    assert res.status_code != 504
    body = res.json()
    assert body["degraded"] is True
    assert body["reply"].startswith("GUIDE concept=")
    assert body["routingRationale"]
    assert body["freshnessMarker"]["source"] == "last-known-good"
    assert body["freshnessMarker"]["capturedAt"]
    assert "SECRET" not in res.text
    assert any(
        "outcome=degraded" in r.message and "failure_class=timeout" in r.message
        for r in caplog.records
    )


def test_edge_empty_still_typed_error_not_fabricated() -> None:
    from sutra_orchestrator.model_provider import ModelProviderEmptyError

    store = InMemoryMasterStateStore()
    subject = "subj-llm-down-empty"
    store.put(make_state(subject))
    rt = AgentRuntime(
        TaskRouter(demo_task_graph(), redis_url=None),
        store,
        model_provider=DeterministicFakeProvider(force_empty=True),
    )
    with pytest.raises(ModelProviderEmptyError):
        rt.run_turn(
            AgentTurnRequest(
                protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
                subjectId=subject,
                sessionId="s",
                utterance="x",
                friction=FrictionSample(
                    conceptId="math.ratios",
                    hesitationMs=1,
                    inputVelocity=1.0,
                    revisionCount=0,
                    assistanceRequested=False,
                    outcome="correct",
                    capturedAt=hlc(1_700_000_000_100, 0, "edge-degr"),
                ),
            )
        )


def test_sovereignty_cross_subject_state_isolated(
    client_timeout: TestClient,
) -> None:
    """Timeout degrade for A must not leak B's utterance or reply body."""
    import sutra_orchestrator.main as main_mod

    other = "subj-llm-down-other"
    assert main_mod._store is not None
    main_mod._store.put(make_state(other))
    secret = "SECRET_UTTERANCE_MUST_NOT_LEAK_CROSS"
    res = client_timeout.post(
        "/v1/agent/turn",
        headers=AUTH_HEADER,
        json=turn_body("subj-llm-down-http", utterance=secret),
    )
    assert res.status_code == 200
    assert secret not in res.text
    assert secret not in res.json()["reply"]
    other_state = main_mod._store.get(other)
    assert other_state is not None
    assert other_state.activeConceptId == "math.ratios"
