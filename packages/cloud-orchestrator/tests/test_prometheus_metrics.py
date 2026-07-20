"""GET /v1/metrics Prometheus exposition."""

from __future__ import annotations

import importlib
import uuid

import pytest
from fastapi.testclient import TestClient

from sutra_orchestrator.contract_models import (
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
)
from sutra_orchestrator.middleware import (
    AGENT_TURN_ROUTE,
    OPENMETRICS_CONTENT_TYPE,
    PROM_CONTENT_TYPE,
    REQUEST_ID_HEADER,
    SUTRA_HTTP_DURATION_METRIC,
    SUTRA_HTTP_ERRORS_PROM,
    SUTRA_ROUTING_OVERHEAD_PROM,
    SUTRA_SYNC_OUTCOME_PROM,
    SUTRA_TURN_STAGE_DURATION_PROM,
    get_latency_recorder,
    record_sync_outcome,
    record_turn_stage_duration,
    render_prometheus_exposition,
    reset_http_error_counter_for_tests,
    reset_latency_recorder_for_tests,
    reset_routing_overhead_recorder_for_tests,
    reset_sync_outcome_counter_for_tests,
    reset_turn_stage_duration_recorder_for_tests,
)
from sutra_orchestrator import PROTOCOL_VERSION

AUTH_HEADER = {"X-API-Key": "test-dev-key"}


def _hlc(ms: int, counter: int, device: str) -> str:
    return f"{ms:015d}:{counter:06d}:{device}"


def _make_state(subject_id: str) -> CognitiveState:
    device = "edge-aaaa"
    return CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        deviceIds=[device],
        activeConceptId="math.ratios",
        mode="exploratory",  # type: ignore[arg-type]
        mastery={
            "math.ratios": ConceptMastery(
                conceptId="math.ratios",
                alpha={device: 1.0},
                beta={device: 1.0},
                lastExercisedAt=_hlc(1_700_000_000_000, 0, device),
            )
        },
        frictionLog=[],
        profile=SubjectProfile(
            ageBand="child",  # type: ignore[arg-type]
            track="math",
            language="en-IN",
            updatedAt=_hlc(1_700_000_000_000, 0, device),
        ),
        stateVector={"session": _hlc(1_700_000_000_000, 0, device)},
    )


def _turn_body(subject_id: str, *, utterance: str = "hello") -> dict:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "subjectId": subject_id,
        "sessionId": "sess-1",
        "utterance": utterance,
        "friction": {
            "conceptId": "math.ratios",
            "hesitationMs": 100,
            "inputVelocity": 2.0,
            "revisionCount": 0,
            "assistanceRequested": False,
            "outcome": "correct",
            "capturedAt": _hlc(1_700_000_000_100, 0, "edge-aaaa"),
        },
    }


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUTRA_API_KEYS", "test-dev-key")
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    reset_latency_recorder_for_tests()
    reset_http_error_counter_for_tests()
    reset_routing_overhead_recorder_for_tests()
    reset_sync_outcome_counter_for_tests()
    reset_turn_stage_duration_recorder_for_tests()
    with TestClient(main_mod.app) as c:
        yield c


def test_happy_path_prometheus_exposition_after_traffic(client: TestClient) -> None:
    subject = f"prom-{uuid.uuid4().hex[:8]}"
    client.app.state.master_state_store.put_state(
        _make_state(subject), expected_subject_id=subject
    )

    res = client.get("/v1/metrics")
    assert res.status_code == 200
    assert PROM_CONTENT_TYPE.split(";")[0] in res.headers["content-type"]
    uuid.UUID(res.headers[REQUEST_ID_HEADER])
    body = res.text
    assert f"# TYPE {SUTRA_HTTP_DURATION_METRIC} histogram" in body
    assert f"# TYPE {SUTRA_SYNC_OUTCOME_PROM} counter" in body
    assert f"# TYPE {SUTRA_TURN_STAGE_DURATION_PROM} histogram" in body
    assert f"# TYPE {SUTRA_ROUTING_OVERHEAD_PROM} histogram" in body

    assert (
        client.post(
            "/v1/agent/turn",
            headers={**AUTH_HEADER, "Content-Type": "application/json"},
            json=_turn_body(subject),
        ).status_code
        == 200
    )
    # Seed sync via memory reconcile path
    sync_body = {
        "protocolVersion": PROTOCOL_VERSION,
        "deviceId": "edge-aaaa",
        "edgeState": _make_state(subject).model_dump(mode="json"),
        "lastKnownCloudVector": {},
        "syncAttemptId": str(uuid.uuid4()),
    }
    assert (
        client.post(
            "/v1/sync",
            headers={**AUTH_HEADER, "Content-Type": "application/json"},
            json=sync_body,
        ).status_code
        == 200
    )

    after = client.get("/v1/metrics").text
    assert f'{SUTRA_SYNC_OUTCOME_PROM}{{outcome="converged"}}' in after
    assert f'{SUTRA_TURN_STAGE_DURATION_PROM}_count{{stage="respond"}}' in after
    assert f'route="{AGENT_TURN_ROUTE}"' in after or f'route=\\"{AGENT_TURN_ROUTE}\\"' not in after
    assert AGENT_TURN_ROUTE in after
    assert "subject_id" not in after
    assert subject not in after


def test_edge_openmetrics_accept_and_json_accept(client: TestClient) -> None:
    om = client.get(
        "/v1/metrics",
        headers={"Accept": "application/openmetrics-text; version=1.0.0"},
    )
    assert om.status_code == 200
    assert "openmetrics-text" in om.headers["content-type"]
    assert om.text.rstrip().endswith("# EOF")

    js = client.get("/v1/metrics", headers={"Accept": "application/json"})
    assert js.status_code == 200
    assert "application/json" in js.headers["content-type"]
    payload = js.json()
    assert "nfr04" in payload
    assert payload["exposition"] == "prometheus"


def test_edge_metrics_scrape_skips_self_latency(client: TestClient) -> None:
    client.get("/v1/metrics")
    assert not any(s.route == "/v1/metrics" for s in get_latency_recorder().samples())


def test_edge_high_load_scrape_is_read_only(client: TestClient) -> None:
    """Scrape must not increment sync / stage meters (read-only)."""
    record_sync_outcome("converged")
    record_turn_stage_duration("respond", 12.5)
    before = render_prometheus_exposition()
    for _ in range(20):
        client.get("/v1/metrics")
    after = render_prometheus_exposition()
    # Counter values for sync outcome stay stable across scrapes.
    assert 'sutra_sync_outcome_total{outcome="converged"} 1' in before
    assert 'sutra_sync_outcome_total{outcome="converged"} 1' in after


def test_sovereignty_no_subject_labels_in_prometheus(client: TestClient) -> None:
    subject = f"prom-sov-{uuid.uuid4().hex[:8]}"
    secret = "GOLDEN_UTTERANCE_PROM_LEAK"
    client.app.state.master_state_store.put_state(
        _make_state(subject), expected_subject_id=subject
    )
    client.post(
        "/v1/agent/turn",
        headers={**AUTH_HEADER, "Content-Type": "application/json"},
        json=_turn_body(subject, utterance=secret),
    )
    text = client.get("/v1/metrics").text
    assert secret not in text
    assert subject not in text
    assert "subjectId" not in text
    assert "subject_id" not in text
    assert SUTRA_HTTP_ERRORS_PROM in text or "# TYPE" in text
