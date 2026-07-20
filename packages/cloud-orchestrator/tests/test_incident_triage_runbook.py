"""Incident triage runbook consistency.

Validates X-Request-Id / metrics / outcome guidance against live middleware
constants and a recorded correlation path on the HTTP surface.
"""

from __future__ import annotations

import importlib
import logging
import re
from pathlib import Path

from fastapi.testclient import TestClient

import pytest

from sutra_orchestrator.middleware import (
    REQUEST_ID_HEADER,
    SUTRA_HTTP_DURATION_METRIC,
    SUTRA_HTTP_ERRORS_PROM,
    SUTRA_ROUTING_OVERHEAD_PROM,
    SUTRA_SYNC_OUTCOME_PROM,
    SUTRA_TURN_STAGE_DURATION_PROM,
    SYNC_OUTCOME_LABELS,
    reset_http_error_counter_for_tests,
    reset_latency_recorder_for_tests,
)

from tests._internal_runbooks import skip_without_internal_runbooks

pytestmark = skip_without_internal_runbooks

REPO_ROOT = Path(__file__).resolve().parents[3]
RUNBOOK = (
    REPO_ROOT / "docs" / "operations" / "runbooks" / "incident-triage-basics.md"
)
README = Path(__file__).resolve().parents[1] / "README.md"

_INBOUND_RID = "11111111-1111-4111-8111-111111111111"
_AUTH = {"X-API-Key": "compose-operator-surface", REQUEST_ID_HEADER: _INBOUND_RID}


def _marker_block(text: str, name: str) -> str:
    pattern = (
        rf"<!-- {re.escape(name)} -->\s*(.*?)\s*<!-- /{re.escape(name)} -->"
    )
    match = re.search(pattern, text, flags=re.DOTALL)
    assert match, f"runbook must embed {name} block"
    return match.group(1)


def test_happy_path_runbook_linked_and_metric_names_match_code() -> None:
    assert RUNBOOK.is_file()
    readme = README.read_text(encoding="utf-8")
    assert "docs/operations/runbooks/incident-triage-basics.md" in readme

    text = RUNBOOK.read_text(encoding="utf-8")
    assert "X-Request-Id" in text
    assert "http.request_complete" in text
    assert "sutra.request_id" in text
    assert "event-catalog.md" in text
    assert "/v1/metrics" in text

    for name in (
        SUTRA_SYNC_OUTCOME_PROM,
        SUTRA_HTTP_DURATION_METRIC,
        SUTRA_ROUTING_OVERHEAD_PROM,
        SUTRA_TURN_STAGE_DURATION_PROM,
        SUTRA_HTTP_ERRORS_PROM,
    ):
        assert name in text

    metrics_block = _marker_block(text, "RUNBOOK_TRIAGE_METRICS")
    assert f"# TYPE {SUTRA_SYNC_OUTCOME_PROM} counter" in metrics_block

    for outcome in ("converged", "quarantined", "exhausted", "skipped-offline"):
        assert outcome in text
        assert outcome in SYNC_OUTCOME_LABELS


def test_happy_path_request_id_echo_matches_runbook_and_logs(
    monkeypatch,
) -> None:
    """Recorded correlation path: inbound UUID echoed + log line shape."""
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "permissive_dev")
    reset_latency_recorder_for_tests()
    reset_http_error_counter_for_tests()
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)

    text = RUNBOOK.read_text(encoding="utf-8")
    rid_block = _marker_block(text, "RUNBOOK_TRIAGE_REQUEST_ID")
    assert _INBOUND_RID in rid_block
    assert "http.request_complete request_id=" in rid_block

    with TestClient(main_mod.app) as client:
        caplog_records: list[logging.LogRecord] = []

        class _Cap(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                caplog_records.append(record)

        handler = _Cap()
        logger = logging.getLogger("sutra.orchestrator.middleware")
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        try:
            res = client.get("/v1/subjects/anika-k/state", headers=_AUTH)
        finally:
            logger.removeHandler(handler)

        assert res.headers.get(REQUEST_ID_HEADER) == _INBOUND_RID
        joined = " ".join(r.getMessage() for r in caplog_records)
        assert "http.request_complete" in joined
        assert f"request_id={_INBOUND_RID}" in joined
        assert "/v1/subjects/{subject_id}/state" in joined
        # Sovereignty: no learner content in correlation logs.
        assert "utterance" not in joined.lower()


def test_edge_metrics_scrape_has_no_subject_labels(monkeypatch) -> None:
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "permissive_dev")
    reset_latency_recorder_for_tests()
    reset_http_error_counter_for_tests()
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    with TestClient(main_mod.app) as client:
        body = client.get("/v1/metrics").text
    assert f"# TYPE {SUTRA_SYNC_OUTCOME_PROM} counter" in body
    assert "subject_id" not in body
    assert "subjectId" not in body
    assert "utterance" not in body

    # Empty subject audit still documents zero-row semantics in outcomes block.
    outcomes = _marker_block(
        RUNBOOK.read_text(encoding="utf-8"), "RUNBOOK_TRIAGE_OUTCOMES"
    )
    assert "items: []" in outcomes or 'items: []' in outcomes


def test_edge_windows_compose_and_quarantine_vs_exhausted_documented() -> None:
    text = RUNBOOK.read_text(encoding="utf-8")
    assert "docker compose -f infra/docker-compose.yml" in text
    assert "Invoke-WebRequest" in text or "Invoke-RestMethod" in text
    assert "curl -s" in text

    outcomes = _marker_block(text, "RUNBOOK_TRIAGE_OUTCOMES")
    assert "quarantined" in outcomes
    assert "exhausted" in outcomes
    # Distinct remediation branches (not the same advice).
    assert "semantic" in outcomes.lower() or "advisories" in outcomes.lower()
    assert "transport" in outcomes.lower() or "timeout" in outcomes.lower()
