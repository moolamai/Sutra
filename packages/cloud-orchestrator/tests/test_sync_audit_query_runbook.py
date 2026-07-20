"""SYNC-06 sync audit query runbook.

Governance-doc consistency + verification against the seeded advisory fixture
embedded in the runbook (in-memory store + HTTP query surface).
"""

from __future__ import annotations

import importlib
import json
import re
from datetime import datetime
from pathlib import Path
from typing import get_args

from fastapi.testclient import TestClient

import pytest

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.contract_models import AdvisoryCode, SyncAuditPage
from sutra_orchestrator.master_state_repository import InMemoryMasterStateStore
from sutra_orchestrator.sync_audit_writer import SyncAuditRecord

from tests._internal_runbooks import skip_without_internal_runbooks

pytestmark = skip_without_internal_runbooks

REPO_ROOT = Path(__file__).resolve().parents[3]
RUNBOOK = (
    REPO_ROOT / "docs" / "operations" / "runbooks" / "sync-audit-query-sync-06.md"
)
README = Path(__file__).resolve().parents[1] / "README.md"
ADVISORY_SURFACE = (
    REPO_ROOT / "packages" / "sync-protocol" / "docs" / "advisory-surface.md"
)

_ALL_CODES = tuple(get_args(AdvisoryCode))

# SYNC-06 runbook documents the reconciliation catalogue (not every wire advisory).
_SYNC06_RUNBOOK_CODES = (
    "CLOCK_SKEW_CLAMPED",
    "DUPLICATE_SAMPLE_DROPPED",
    "UNKNOWN_CONCEPT_QUARANTINED",
    "STATE_VECTOR_REGRESSION",
)

_AUTH = {"X-API-Key": "compose-operator-surface"}


def _marker_block(text: str, name: str) -> str:
    pattern = (
        rf"<!-- {re.escape(name)} -->\s*(.*?)\s*<!-- /{re.escape(name)} -->"
    )
    match = re.search(pattern, text, flags=re.DOTALL)
    assert match, f"runbook must embed {name} block"
    return match.group(1)


def _load_seed_fixture() -> list[dict]:
    text = RUNBOOK.read_text(encoding="utf-8")
    block = _marker_block(text, "RUNBOOK_SEED_FIXTURE")
    match = re.search(r"```json\s*(.*?)\s*```", block, flags=re.DOTALL)
    assert match, "RUNBOOK_SEED_FIXTURE must contain a json fence"
    data = json.loads(match.group(1))
    assert isinstance(data, list) and len(data) == 4
    return data


def _seed_store(store: InMemoryMasterStateStore, rows: list[dict]) -> None:
    for row in rows:
        codes = tuple(row["codes"])
        advisories = tuple(
            {"code": code, "detail": f"fixture: {code}"} for code in codes
        )
        device = row["deviceId"]
        hlc = f"{1_700_000_000_000:015d}:000000:{device}"
        store.append_sync_audit(
            SyncAuditRecord(
                subject_id=row["subjectId"],
                device_id=device,
                sync_attempt_id=row["syncAttemptId"],
                protocol_version=PROTOCOL_VERSION,
                advisories=advisories,
                state_vector_before={"session": hlc},
                state_vector_after={"session": hlc},
                created_at=datetime.fromisoformat(row["createdAt"]),
            )
        )


def test_happy_path_runbook_exists_linked_and_codes_match_contract() -> None:
    assert RUNBOOK.is_file()
    assert ADVISORY_SURFACE.is_file()
    readme = README.read_text(encoding="utf-8")
    assert "docs/operations/runbooks/sync-audit-query-sync-06.md" in readme

    text = RUNBOOK.read_text(encoding="utf-8")
    surface = ADVISORY_SURFACE.read_text(encoding="utf-8")
    for code in _SYNC06_RUNBOOK_CODES:
        assert code in text
        assert code in surface

    # AdvisoryCode Literal stays aligned with the wire schema catalogue.
    assert len(_ALL_CODES) == 5
    for code in _ALL_CODES:
        assert code in surface

    assert "event-catalog.md" in text
    assert "/v1/metrics" in text
    assert "docker compose" in text
    assert "Invoke-RestMethod" in text
    assert "remediation" in text.lower() or "Operator remediation" in text


def test_happy_path_seeded_fixture_api_by_subject_and_code(
    monkeypatch,
) -> None:
    """Verify runbook fixture against the real sync-audit query API."""
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.delenv("SUTRA_API_KEYS_JSON", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "permissive_dev")
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    rows = _load_seed_fixture()

    with TestClient(main_mod.app) as client:
        store = client.app.state.master_state_store
        assert isinstance(store, InMemoryMasterStateStore)
        _seed_store(store, rows)

        # Idempotent replay: same attempt id must not double-apply.
        _seed_store(store, rows[:1])

        page = SyncAuditPage.model_validate(
            client.get(
                "/v1/subjects/anika-k/sync-audit",
                params={"limit": 50},
                headers=_AUTH,
            ).json()
        )
        assert page.subjectId == "anika-k"
        assert len(page.items) == 3
        assert {i.subjectId for i in page.items} == {"anika-k"}
        assert page.items[0].syncAttemptId == "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3"

        filtered = SyncAuditPage.model_validate(
            client.get(
                "/v1/subjects/anika-k/sync-audit",
                params={"advisory_code": "CLOCK_SKEW_CLAMPED", "limit": 50},
                headers=_AUTH,
            ).json()
        )
        assert len(filtered.items) == 1
        assert filtered.items[0].syncAttemptId == (
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
        )
        assert filtered.items[0].advisories[0].code == "CLOCK_SKEW_CLAMPED"


def test_edge_empty_subject_returns_zero_rows_not_error(monkeypatch) -> None:
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "permissive_dev")
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    with TestClient(main_mod.app) as client:
        res = client.get(
            "/v1/subjects/subject-does-not-exist/sync-audit",
            params={"limit": 50},
            headers=_AUTH,
        )
        assert res.status_code == 200
        page = SyncAuditPage.model_validate(res.json())
        assert page.items == []
        assert page.nextCursor is None

    text = RUNBOOK.read_text(encoding="utf-8")
    empty_sql = _marker_block(text, "RUNBOOK_SQL_EMPTY")
    assert "(0 rows)" in empty_sql
    empty_api = _marker_block(text, "RUNBOOK_API_EMPTY")
    assert '"items": []' in empty_api


def test_edge_subject_isolation_and_no_content_leak(monkeypatch) -> None:
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "permissive_dev")
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    rows = _load_seed_fixture()

    with TestClient(main_mod.app) as client:
        store = client.app.state.master_state_store
        assert isinstance(store, InMemoryMasterStateStore)
        _seed_store(store, rows)

        only_a = SyncAuditPage.model_validate(
            client.get(
                "/v1/subjects/anika-k/sync-audit", headers=_AUTH
            ).json()
        )
        assert {i.subjectId for i in only_a.items} == {"anika-k"}
        assert all(
            i.subjectId != "ravi-m" for i in only_a.items
        )

        only_r = SyncAuditPage.model_validate(
            client.get("/v1/subjects/ravi-m/sync-audit", headers=_AUTH).json()
        )
        assert len(only_r.items) == 1
        assert only_r.items[0].advisories[0].code == "STATE_VECTOR_REGRESSION"

    text = RUNBOOK.read_text(encoding="utf-8")
    # Worked JSON fences must not carry learner content fields.
    for fence in re.findall(r"```json\s*(.*?)\s*```", text, flags=re.DOTALL):
        lowered = fence.lower()
        assert '"utterance"' not in lowered
        assert "frictionlog" not in lowered
        assert '"text"' not in lowered
    seed_sql = _marker_block(text, "RUNBOOK_SEED_SQL")
    assert "anika-k" in seed_sql
    assert "INSERT INTO sync_audit" in seed_sql
    assert "ON CONFLICT (sync_attempt_id) DO NOTHING" in seed_sql
    assert "FROM subject_states" not in text
    assert "state->" not in text
    assert '"utterance"' not in seed_sql.lower()