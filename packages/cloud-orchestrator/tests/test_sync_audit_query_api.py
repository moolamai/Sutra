"""Paginated sync-audit GET routes."""

from __future__ import annotations

import importlib
import logging
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.contract_models import SyncAuditPage
from sutra_orchestrator.master_state_repository import InMemoryMasterStateStore
from sutra_orchestrator.sync_audit_writer import SyncAuditRecord

_AUTH = {"X-API-Key": "test-dev-key"}


def _attempt() -> str:
    return str(uuid.uuid4())


def _record(
    subject_id: str,
    *,
    device_id: str = "edge-aaaa",
    attempt: str | None = None,
    created_at: datetime | None = None,
    codes: tuple[str, ...] = (),
) -> SyncAuditRecord:
    advisories = tuple(
        {"code": code, "detail": f"detail-{code}"} for code in codes
    )
    hlc = f"{1_000_000:015d}:000000:{device_id}"
    return SyncAuditRecord(
        subject_id=subject_id,
        device_id=device_id,
        sync_attempt_id=attempt or _attempt(),
        protocol_version=PROTOCOL_VERSION,
        advisories=advisories,
        state_vector_before={"session": hlc},
        state_vector_after={"session": hlc},
        created_at=created_at or datetime.now(timezone.utc),
    )


@pytest.fixture()
def client_and_store(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[TestClient, InMemoryMasterStateStore]:
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.delenv("SUTRA_API_KEYS_JSON", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "permissive_dev")
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    with TestClient(main_mod.app) as client:
        store = client.app.state.master_state_store
        assert isinstance(store, InMemoryMasterStateStore)
        yield client, store


def test_happy_path_paginated_sync_audit(
    client_and_store: tuple[TestClient, InMemoryMasterStateStore],
    caplog: pytest.LogCaptureFixture,
) -> None:
    client, store = client_and_store
    subject = f"aud-q-{uuid.uuid4().hex[:8]}"
    base = datetime(2026, 7, 15, 12, 0, 0, tzinfo=timezone.utc)
    for i in range(5):
        store.append_sync_audit(
            _record(
                subject,
                created_at=base + timedelta(seconds=i),
                codes=("CLOCK_SKEW_CLAMPED",) if i % 2 == 0 else (),
            )
        )

    with caplog.at_level(logging.INFO, logger="sutra.orchestrator"):
        res = client.get(
            f"/v1/subjects/{subject}/sync-audit",
            params={"limit": 2},
            headers=_AUTH,
        )

    assert res.status_code == 200
    page = SyncAuditPage.model_validate(res.json())
    assert page.subjectId == subject
    assert len(page.items) == 2
    assert page.nextCursor is not None
    # Newest-first.
    assert page.items[0].createdAt > page.items[1].createdAt
    assert all(item.subjectId == subject for item in page.items)

    page2 = SyncAuditPage.model_validate(
        client.get(
            f"/v1/subjects/{subject}/sync-audit",
            params={"limit": 2, "cursor": page.nextCursor},
            headers=_AUTH,
        ).json()
    )
    assert len(page2.items) == 2
    assert page2.items[0].createdAt < page.items[1].createdAt

    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "sync_audit_list" in joined
    assert f"subject_id={subject}" in joined
    assert "outcome=ok" in joined
    assert "frictionLog" not in joined
    assert "utterance" not in joined


def test_edge_cursor_past_end_returns_empty_page(
    client_and_store: tuple[TestClient, InMemoryMasterStateStore],
) -> None:
    client, store = client_and_store
    subject = f"aud-end-{uuid.uuid4().hex[:8]}"
    store.append_sync_audit(_record(subject))

    first = SyncAuditPage.model_validate(
        client.get(
            f"/v1/subjects/{subject}/sync-audit",
            params={"limit": 10},
            headers=_AUTH,
        ).json()
    )
    assert len(first.items) == 1
    assert first.nextCursor is None

    # Exclusive older-than: cursor on the only row's key → empty next page.
    from sutra_orchestrator.main import _encode_audit_cursor

    cursor = _encode_audit_cursor(
        first.items[0].createdAt, first.items[0].syncAttemptId
    )
    res = client.get(
        f"/v1/subjects/{subject}/sync-audit",
        params={"limit": 10, "cursor": cursor},
        headers=_AUTH,
    )
    assert res.status_code == 200
    empty = SyncAuditPage.model_validate(res.json())
    assert empty.items == []
    assert empty.nextCursor is None
    assert empty.subjectId == subject


def test_edge_unknown_filter_and_bad_advisory_are_422(
    client_and_store: tuple[TestClient, InMemoryMasterStateStore],
) -> None:
    client, _store = client_and_store
    subject = f"aud-422-{uuid.uuid4().hex[:8]}"

    unknown = client.get(
        f"/v1/subjects/{subject}/sync-audit",
        params={"limit": 10, "notARealFilter": "x"},
        headers=_AUTH,
    )
    assert unknown.status_code == 422

    bad_code = client.get(
        f"/v1/subjects/{subject}/sync-audit",
        params={"advisory_code": "NOT_A_REAL_ADVISORY"},
        headers=_AUTH,
    )
    assert bad_code.status_code == 422

    bad_cursor = client.get(
        f"/v1/subjects/{subject}/sync-audit",
        params={"cursor": "%%%not-base64%%%"},
        headers=_AUTH,
    )
    assert bad_cursor.status_code == 422


def test_edge_advisory_filter_and_subject_isolation(
    client_and_store: tuple[TestClient, InMemoryMasterStateStore],
) -> None:
    client, store = client_and_store
    a = f"aud-a-{uuid.uuid4().hex[:6]}"
    b = f"aud-b-{uuid.uuid4().hex[:6]}"
    base = datetime(2026, 7, 15, 13, 0, 0, tzinfo=timezone.utc)

    store.append_sync_audit(
        _record(a, created_at=base, codes=("CLOCK_SKEW_CLAMPED",))
    )
    store.append_sync_audit(
        _record(a, created_at=base + timedelta(seconds=1), codes=("DUPLICATE_SAMPLE_DROPPED",))
    )
    store.append_sync_audit(
        _record(b, created_at=base + timedelta(seconds=2), codes=("CLOCK_SKEW_CLAMPED",))
    )

    filtered = SyncAuditPage.model_validate(
        client.get(
            f"/v1/subjects/{a}/sync-audit",
            params={"advisory_code": "CLOCK_SKEW_CLAMPED"},
            headers=_AUTH,
        ).json()
    )
    assert len(filtered.items) == 1
    assert filtered.items[0].advisories[0].code == "CLOCK_SKEW_CLAMPED"
    assert filtered.items[0].subjectId == a

    only_a = SyncAuditPage.model_validate(
        client.get(f"/v1/subjects/{a}/sync-audit", headers=_AUTH).json()
    )
    assert {item.subjectId for item in only_a.items} == {a}
    assert len(only_a.items) == 2

    only_b = SyncAuditPage.model_validate(
        client.get(f"/v1/subjects/{b}/sync-audit", headers=_AUTH).json()
    )
    assert len(only_b.items) == 1
    assert only_b.items[0].subjectId == b


def test_read_only_surface_has_no_mutation_methods(
    client_and_store: tuple[TestClient, InMemoryMasterStateStore],
) -> None:
    client, _store = client_and_store
    subject = f"aud-ro-{uuid.uuid4().hex[:8]}"
    for method in ("post", "put", "patch", "delete"):
        res = getattr(client, method)(
            f"/v1/subjects/{subject}/sync-audit",
            headers=_AUTH,
        )
        assert res.status_code == 405
