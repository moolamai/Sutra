"""Transactional sync_audit writes."""

from __future__ import annotations

import logging
import os
import uuid

import pytest

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.contract_models import (
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
    SyncRequest,
)
from sutra_orchestrator.master_state_repository import (
    InMemoryMasterStateStore,
    PostgresMasterStateStore,
)
from sutra_orchestrator.sync_audit_writer import advisories_verbatim
from sutra_orchestrator.sync_service import SyncService


def _hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


def _make_state(
    subject_id: str,
    *,
    device: str = "edge-aaaa",
    session_ms: int = 1_000_000,
    alpha: float = 3.0,
) -> CognitiveState:
    return CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        deviceIds=[device],
        activeConceptId="math.ratios",
        mode="exploratory",
        mastery={
            "math.ratios": ConceptMastery(
                conceptId="math.ratios",
                alpha={device: alpha},
                beta={device: 1.0},
                lastExercisedAt=_hlc(session_ms, 0, device),
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
                capturedAt=_hlc(session_ms, 1, device),
            )
        ],
        profile=SubjectProfile(
            ageBand="child",
            track="cbse-class-7-maths",
            language="hi-IN",
            updatedAt=_hlc(session_ms, 2, device),
        ),
        stateVector={"session": _hlc(session_ms, 3, device)},
    )


def test_happy_path_audit_row_with_state_commit(caplog: pytest.LogCaptureFixture) -> None:
    store = InMemoryMasterStateStore()
    service = SyncService(store)
    subject = f"aud-{uuid.uuid4().hex[:8]}"
    edge = _make_state(subject)
    attempt = str(uuid.uuid4())

    with caplog.at_level(logging.INFO, logger="sutra_orchestrator.master_state_repository"):
        resp = service.reconcile(
            SyncRequest(
                protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
                deviceId="edge-aaaa",
                edgeState=edge,
                lastKnownCloudVector={},
                syncAttemptId=attempt,
            )
        )

    rows = store.list_sync_audit(subject)
    assert len(rows) == 1
    row = rows[0]
    assert row.device_id == "edge-aaaa"
    assert row.sync_attempt_id == attempt
    assert row.protocol_version == PROTOCOL_VERSION
    assert row.state_vector_after == dict(resp.mergedState.stateVector)
    assert row.state_vector_before == dict(edge.stateVector)
    # Verbatim advisory codes from merge (replay may emit DUPLICATE on second call).
    codes = set(row.advisory_codes())
    for adv in resp.advisories:
        assert adv.code in codes
        assert any(a["detail"] == adv.detail for a in row.advisories)

    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "sync_audit_append" in joined
    assert "frictionLog" not in joined
    assert edge.frictionLog[0].conceptId  # content exists but must not be logged
    assert "hesitationMs" not in joined


def test_edge_replay_same_attempt_idempotent_no_double_audit() -> None:
    store = InMemoryMasterStateStore()
    service = SyncService(store)
    subject = f"aud-{uuid.uuid4().hex[:8]}"
    edge = _make_state(subject)
    attempt = str(uuid.uuid4())
    req = SyncRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        deviceId="edge-aaaa",
        edgeState=edge,
        lastKnownCloudVector={},
        syncAttemptId=attempt,
    )
    first = service.reconcile(req)
    second = service.reconcile(req)
    assert first.mergedState.model_dump() == second.mergedState.model_dump()
    assert len(store.list_sync_audit(subject)) == 1


def test_edge_sovereignty_audit_scoped_by_subject() -> None:
    store = InMemoryMasterStateStore()
    service = SyncService(store)
    a = f"aud-a-{uuid.uuid4().hex[:8]}"
    b = f"aud-b-{uuid.uuid4().hex[:8]}"
    for subject in (a, b):
        service.reconcile(
            SyncRequest(
                protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
                deviceId="edge-aaaa",
                edgeState=_make_state(subject),
                lastKnownCloudVector={},
                syncAttemptId=str(uuid.uuid4()),
            )
        )
    assert len(store.list_sync_audit(a)) == 1
    assert store.list_sync_audit(a)[0].subject_id == a
    assert len(store.list_sync_audit(b)) == 1
    assert store.list_sync_audit(b)[0].subject_id == b
    assert store.list_sync_audit(f"missing-{uuid.uuid4().hex[:6]}") == []


def test_advisories_verbatim_preserves_code_and_detail() -> None:
    from sutra_orchestrator.contract_models import SyncAdvisory

    ads = [
        SyncAdvisory(code="DUPLICATE_SAMPLE_DROPPED", detail="sample X"),
        SyncAdvisory(code="CLOCK_SKEW_CLAMPED", detail="skew Y"),
    ]
    out = advisories_verbatim(ads)
    assert out == (
        {"code": "DUPLICATE_SAMPLE_DROPPED", "detail": "sample X"},
        {"code": "CLOCK_SKEW_CLAMPED", "detail": "skew Y"},
    )


@pytest.mark.skipif(not os.environ.get("SUTRA_PG_DSN"), reason="SUTRA_PG_DSN not set")
def test_live_postgres_audit_in_same_transaction() -> None:
    store = PostgresMasterStateStore.from_dsn(os.environ["SUTRA_PG_DSN"])
    subject = f"aud-pg-{uuid.uuid4().hex[:8]}"
    attempt = str(uuid.uuid4())
    try:
        SyncService(store).reconcile(
            SyncRequest(
                protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
                deviceId="edge-aaaa",
                edgeState=_make_state(subject),
                lastKnownCloudVector={},
                syncAttemptId=attempt,
            )
        )
    finally:
        store.close()

    # Restart-equivalent: new store instance reads committed audit + state.
    again = PostgresMasterStateStore.from_dsn(os.environ["SUTRA_PG_DSN"])
    try:
        assert again.get_state(subject) is not None
        with again._pool.connection() as conn:  # noqa: SLF001 — integration assert
            row = conn.execute(
                """
                SELECT subject_id, device_id, advisories,
                       state_vector_before, state_vector_after
                FROM sync_audit
                WHERE sync_attempt_id = %s::uuid
                """,
                (attempt,),
            ).fetchone()
        assert row is not None
        assert row[0] == subject
        assert row[1] == "edge-aaaa"
        assert isinstance(row[2], list)
    finally:
        again.close()
