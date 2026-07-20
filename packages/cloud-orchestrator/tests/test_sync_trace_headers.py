"""Extract W3C traceparent before CRDT merge."""

from __future__ import annotations

import logging

import pytest

from sutra_orchestrator.contract_models import SyncRequest, SyncWireHeaders
from sutra_orchestrator.sync_service import SyncService
from sutra_orchestrator.sync_trace import (
    continue_sync_trace,
    current_sync_trace,
    extract_sync_trace,
)
from sutra_orchestrator.master_state_repository import InMemoryMasterStateStore


def _minimal_state(subject_id: str = "anika-k") -> dict:
    hlc = "000001700000000:000000:edge-aaaa"
    return {
        "protocolVersion": "1.0.0",
        "subjectId": subject_id,
        "deviceIds": ["edge-aaaa"],
        "activeConceptId": "math.ratios",
        "mode": "exploratory",
        "mastery": {
            "math.ratios": {
                "conceptId": "math.ratios",
                "alpha": {"edge-aaaa": 1},
                "beta": {"edge-aaaa": 1},
                "lastExercisedAt": hlc,
            }
        },
        "frictionLog": [],
        "profile": {
            "ageBand": "child",
            "track": "cbse-class-7-maths",
            "language": "hi-IN",
            "updatedAt": hlc,
        },
        "stateVector": {"session": hlc},
    }


def _sync_request(**kwargs) -> SyncRequest:
    payload = {
        "protocolVersion": "1.0.0",
        "deviceId": "edge-aaaa",
        "edgeState": _minimal_state(),
        "lastKnownCloudVector": {},
        "syncAttemptId": "55555555-5555-4555-8555-555555555555",
        **kwargs,
    }
    return SyncRequest.model_validate(payload)


def test_happy_path_extract_and_continue_before_merge(caplog: pytest.LogCaptureFixture) -> None:
    traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
    req = _sync_request(headers={"traceparent": traceparent})
    extracted = extract_sync_trace(req.headers)
    assert extracted is not None
    assert extracted.trace_id == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    assert extracted.parent_span_id == "bbbbbbbbbbbbbbbb"

    svc = SyncService(InMemoryMasterStateStore())
    with caplog.at_level(logging.INFO):
        resp = svc.reconcile(req)
    assert resp.mergedState.subjectId == "anika-k"
    assert any("sync.trace.continue" in r.message for r in caplog.records)
    assert any("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" in r.message for r in caplog.records)


def test_edge_malformed_traceparent_soft_skips() -> None:
    assert extract_sync_trace(SyncWireHeaders(traceparent="nope")) is None
    req = _sync_request(headers={"traceparent": "garbage"})
    with continue_sync_trace(req) as ctx:
        assert ctx is None
        assert current_sync_trace() is None


def test_edge_absent_headers_reconcile_still_works() -> None:
    svc = SyncService(InMemoryMasterStateStore())
    resp = svc.reconcile(_sync_request())
    assert resp.mergedState.subjectId == "anika-k"
    assert current_sync_trace() is None


def test_sovereignty_trace_context_is_request_scoped() -> None:
    tp_a = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-cccccccccccccccc-01"
    tp_b = "00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-dddddddddddddddd-01"
    req_a = _sync_request(
        headers={"traceparent": tp_a},
    )
    req_b = _sync_request(
        edgeState=_minimal_state("other-subject"),
        syncAttemptId="66666666-6666-4666-8666-666666666666",
        headers={"traceparent": tp_b},
    )
    with continue_sync_trace(req_a) as ctx_a:
        assert ctx_a is not None
        assert current_sync_trace() is not None
        assert current_sync_trace().trace_id.startswith("aaaa")
        with continue_sync_trace(req_b) as ctx_b:
            assert ctx_b is not None
            assert current_sync_trace().trace_id.startswith("bbbb")
        assert current_sync_trace().trace_id.startswith("aaaa")
    assert current_sync_trace() is None
