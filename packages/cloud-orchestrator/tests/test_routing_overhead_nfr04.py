"""NFR-04 agent-turn routing overhead."""

from __future__ import annotations

import importlib
import time
import uuid

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.slow

from sutra_orchestrator.contract_models import (
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
)
from sutra_orchestrator.middleware import (
    AGENT_TURN_ROUTE,
    NFR04_BUDGET_P95_MS,
    NFR04_ID,
    REQUEST_ID_HEADER,
    SUTRA_ROUTING_OVERHEAD_METRIC,
    begin_agent_turn_routing,
    cancel_agent_turn_routing,
    check_nfr04_cli,
    evaluate_nfr04_gate,
    finish_agent_turn_routing,
    format_nfr04_gate_report,
    get_latency_recorder,
    get_routing_overhead_recorder,
    mark_llm_generation_start,
    percentile_ms,
    reset_http_error_counter_for_tests,
    reset_latency_recorder_for_tests,
    reset_routing_overhead_recorder_for_tests,
)
from sutra_orchestrator import PROTOCOL_VERSION

AUTH_HEADER = {"X-API-Key": "test-dev-key"}
JSON_ACCEPT = {"Accept": "application/json"}


def _hlc(ms: int, counter: int, device: str) -> str:
    return f"{ms:015d}:{counter:06d}:{device}"


def _make_state(subject_id: str) -> CognitiveState:
    device = "edge-aaaa"
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
                lastExercisedAt=_hlc(1_700_000_000, 0, device),
            )
        },
        frictionLog=[
            FrictionSample(
                conceptId="math.ratios",
                hesitationMs=500,
                inputVelocity=2.5,
                revisionCount=0,
                assistanceRequested=False,
                outcome="correct",
                capturedAt=_hlc(1_700_000_000, 1, device),
            )
        ],
        profile=SubjectProfile(
            ageBand="child",
            track="cbse-class-7-maths",
            language="hi-IN",
            updatedAt=_hlc(1_700_000_000, 2, device),
        ),
        stateVector={"session": _hlc(1_700_000_000, 3, device)},
    )


def _turn_body(subject_id: str, utterance: str = "hello") -> dict:
    return {
        "protocolVersion": "1.0.0",
        "subjectId": subject_id,
        "sessionId": "sess-nfr04",
        "utterance": utterance,
        "friction": {
            "conceptId": "math.ratios",
            "hesitationMs": 1,
            "inputVelocity": 1.0,
            "revisionCount": 0,
            "assistanceRequested": False,
            "outcome": "ungraded",
            "capturedAt": "000001700000000:000000:edge-aaaa",
        },
    }


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.delenv("SUTRA_API_KEYS_JSON", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "permissive_dev")
    reset_latency_recorder_for_tests()
    reset_http_error_counter_for_tests()
    reset_routing_overhead_recorder_for_tests()
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    with TestClient(main_mod.app) as c:
        yield c
    reset_latency_recorder_for_tests()
    reset_http_error_counter_for_tests()
    reset_routing_overhead_recorder_for_tests()


def test_unit_percentile_and_gate_happy_path() -> None:
    samples = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
    assert percentile_ms(samples, 95) == 10.0
    result = evaluate_nfr04_gate(
        samples,
        budget_p95_ms=50.0,
        baseline_p95_ms=25.0,
        tolerance=0.5,
    )
    assert result.outcome == "pass"
    assert result.p95_ms == 10.0
    assert result.headroom_pct is not None and result.headroom_pct > 0
    report = format_nfr04_gate_report(result)
    assert "p95_measured_ms=10.000" in report
    assert "budget_p95_ms=50.000" in report
    assert "gate=pass" in report


def test_edge_seeded_slowdown_trips_gate(capsys: pytest.CaptureFixture[str]) -> None:
    slow = [80.0] * 20  # p95 well above 50ms budget
    result = evaluate_nfr04_gate(
        slow,
        budget_p95_ms=NFR04_BUDGET_P95_MS,
        baseline_p95_ms=25.0,
        tolerance=0.5,
    )
    assert result.outcome == "fail"
    assert result.p95_ms is not None and result.p95_ms > NFR04_BUDGET_P95_MS
    code = check_nfr04_cli(slow)
    assert code == 1
    out = capsys.readouterr().out
    assert NFR04_ID in out
    assert "p95_measured_ms=" in out
    assert "budget_p95_ms=" in out
    assert "gate=fail" in out


def test_edge_relative_regression_trips_even_under_absolute_budget() -> None:
    # Under 50ms absolute, but above baseline×(1+tol): 25 * 1.5 = 37.5
    samples = [40.0] * 10
    result = evaluate_nfr04_gate(
        samples,
        budget_p95_ms=50.0,
        baseline_p95_ms=25.0,
        tolerance=0.5,
    )
    assert result.outcome == "fail"
    assert "baseline" in result.reason


def test_edge_llm_latency_excluded_from_histogram() -> None:
    reset_routing_overhead_recorder_for_tests()
    begin_agent_turn_routing()
    time.sleep(0.005)
    mark_llm_generation_start()
    time.sleep(0.05)  # simulated model time — must not enter NFR-04
    ms = finish_agent_turn_routing()
    assert ms is not None
    assert ms < 40.0
    samples = get_routing_overhead_recorder().samples()
    assert len(samples) == 1
    assert samples[0] < 40.0


def test_edge_cancel_does_not_record() -> None:
    reset_routing_overhead_recorder_for_tests()
    begin_agent_turn_routing()
    cancel_agent_turn_routing()
    assert finish_agent_turn_routing() is None
    assert get_routing_overhead_recorder().samples() == []


def test_happy_path_metrics_and_agent_turn(
    client: TestClient,
) -> None:
    subject = f"nfr04-{uuid.uuid4().hex[:8]}"
    store = client.app.state.master_state_store
    store.put_state(_make_state(subject), expected_subject_id=subject)

    before = client.get("/v1/metrics", headers=JSON_ACCEPT)
    assert before.status_code == 200
    uuid.UUID(before.headers[REQUEST_ID_HEADER])
    assert before.json()["nfr04"]["id"] == NFR04_ID
    assert before.json()["nfr04"]["metric"] == SUTRA_ROUTING_OVERHEAD_METRIC
    assert before.json()["nfr04"]["budget_p95_ms"] == NFR04_BUDGET_P95_MS

    res = client.post(
        "/v1/agent/turn",
        headers={**AUTH_HEADER, "Content-Type": "application/json"},
        json=_turn_body(subject),
    )
    assert res.status_code == 200, res.text

    after = client.get("/v1/metrics", headers=JSON_ACCEPT).json()
    nfr = after["nfr04"]
    assert nfr["sample_count"] >= 1
    assert nfr["p95_ms"] is not None
    assert nfr["p95_ms"] <= NFR04_BUDGET_P95_MS
    assert nfr["gate"] in {"pass", "insufficient_samples"}
    # Warm multi-sample: tree should pass with headroom under absolute budget.
    for _ in range(8):
        assert (
            client.post(
                "/v1/agent/turn",
                headers={**AUTH_HEADER, "Content-Type": "application/json"},
                json=_turn_body(subject),
            ).status_code
            == 200
        )
    final = client.get("/v1/metrics", headers=JSON_ACCEPT).json()["nfr04"]
    assert final["sample_count"] >= 9
    assert final["gate"] == "pass"
    assert final["headroom_pct"] is not None and final["headroom_pct"] > 0
    gate = evaluate_nfr04_gate()
    assert gate.outcome == "pass"
    assert check_nfr04_cli() == 0


def test_edge_metrics_light_path_skips_wall_latency(client: TestClient) -> None:
    client.get("/v1/metrics")
    samples = get_latency_recorder().samples()
    assert not any(s.route == "/v1/metrics" for s in samples)


def test_edge_unknown_subject_does_not_inflate_histogram(client: TestClient) -> None:
    reset_routing_overhead_recorder_for_tests()
    res = client.post(
        "/v1/agent/turn",
        headers={**AUTH_HEADER, "Content-Type": "application/json"},
        json=_turn_body("missing-subject-xyz"),
    )
    assert res.status_code == 404
    assert get_routing_overhead_recorder().samples() == []


def test_sovereignty_metrics_never_hold_utterance(client: TestClient) -> None:
    subject = f"nfr04-{uuid.uuid4().hex[:8]}"
    store = client.app.state.master_state_store
    store.put_state(_make_state(subject), expected_subject_id=subject)
    secret = "GOLDEN_UTTERANCE_MUST_NOT_APPEAR_IN_METRICS"
    client.post(
        "/v1/agent/turn",
        headers={**AUTH_HEADER, "Content-Type": "application/json"},
        json=_turn_body(subject, utterance=secret),
    )
    blob = repr(client.get("/v1/metrics", headers=JSON_ACCEPT).json()) + repr(
        get_routing_overhead_recorder().samples()
    )
    assert secret not in blob
    assert "utterance" not in blob
    assert AGENT_TURN_ROUTE in str(client.get("/v1/metrics", headers=JSON_ACCEPT).json())
    # Default scrape is Prometheus text — also privacy-check that surface.
    prom = client.get("/v1/metrics").text
    assert secret not in prom
    assert "subject_id" not in prom
    assert "utterance" not in prom
