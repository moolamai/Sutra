"""Postgres master-state repository."""

from __future__ import annotations

import logging
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.contract_models import (
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
)
from sutra_orchestrator.master_state_repository import (
    CrossSubjectAccessError,
    MasterStateUnavailableError,
    PostgresMasterStateStore,
    StaleStateVectorError,
)


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
                hesitationMs=400,
                inputVelocity=2.0,
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


def _pg_dsn() -> str | None:
    return os.environ.get("SUTRA_PG_DSN")


def test_fail_fast_when_postgres_unreachable() -> None:
    """Postgres unavailable at startup → typed error, not a half-alive store."""
    bad = "postgresql://sutra:wrong@127.0.0.1:1/sutra?connect_timeout=1"
    with pytest.raises(MasterStateUnavailableError):
        PostgresMasterStateStore.from_dsn(bad, ensure_schema=False)


def test_postgres_store_exports_protocol_surface() -> None:
    """Contract surface is present without a live database."""
    assert hasattr(PostgresMasterStateStore, "get_state")
    assert hasattr(PostgresMasterStateStore, "put_state")
    assert hasattr(PostgresMasterStateStore, "subject_guard")
    assert PostgresMasterStateStore.backend_name == "postgres"


@pytest.mark.skipif(not _pg_dsn(), reason="SUTRA_PG_DSN not set")
def test_happy_path_jsonb_round_trip_and_restart() -> None:
    """write → new store instance (restart) → read returns committed state."""
    dsn = _pg_dsn()
    assert dsn is not None
    subject = f"pg-subj-{uuid.uuid4().hex[:10]}"
    state = _make_state(subject)

    store = PostgresMasterStateStore.from_dsn(dsn)
    try:
        assert store.get_state(subject) is None
        with store.subject_guard(subject):
            store.put_state(state, expected_subject_id=subject)
            loaded = store.get_state(subject)
        assert loaded is not None
        assert loaded.model_dump() == state.model_dump()
    finally:
        store.close()

    restarted = PostgresMasterStateStore.from_dsn(dsn)
    try:
        again = restarted.get_state(subject)
        assert again is not None
        assert again.model_dump() == state.model_dump()
    finally:
        restarted.close()


@pytest.mark.skipif(not _pg_dsn(), reason="SUTRA_PG_DSN not set")
def test_edge_stale_vector_and_cross_subject(caplog: pytest.LogCaptureFixture) -> None:
    dsn = _pg_dsn()
    assert dsn is not None
    store = PostgresMasterStateStore.from_dsn(dsn)
    subject = f"pg-subj-{uuid.uuid4().hex[:10]}"
    other = f"pg-other-{uuid.uuid4().hex[:10]}"
    first = _make_state(subject, session_ms=1_000_000)

    try:
        store.put_state(first)
        with pytest.raises(StaleStateVectorError):
            store.put_state(
                _make_state(subject, session_ms=2_000_000),
                expected_state_vector={"session": _hlc(1, 0, "nope")},
            )
        assert store.get_state(subject) == first

        with caplog.at_level(
            logging.WARNING, logger="sutra_orchestrator.master_state_repository"
        ):
            with pytest.raises(CrossSubjectAccessError):
                store.put_state(_make_state(other), expected_subject_id=subject)
        assert store.get_state(other) is None
        joined = " ".join(r.getMessage() for r in caplog.records)
        assert "cross_subject_refused" in joined
        assert "frictionLog" not in joined
    finally:
        store.close()


@pytest.mark.skipif(not _pg_dsn(), reason="SUTRA_PG_DSN not set")
def test_edge_concurrent_first_insert_no_pk_violation() -> None:
    dsn = _pg_dsn()
    assert dsn is not None
    store = PostgresMasterStateStore.from_dsn(dsn)
    subject = f"pg-race-{uuid.uuid4().hex[:10]}"
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def worker(session_ms: int) -> None:
        try:
            barrier.wait(timeout=5)
            with store.subject_guard(subject):
                current = store.get_state(subject)
                nxt = current or _make_state(subject, session_ms=session_ms)
                if current is not None:
                    nxt = current.model_copy(
                        update={
                            "stateVector": {
                                "session": _hlc(session_ms, 3, "edge-aaaa"),
                            }
                        }
                    )
                store.put_state(nxt, expected_subject_id=subject)
        except BaseException as err:  # noqa: BLE001
            errors.append(err)

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futs = [
                pool.submit(worker, 1_000_000),
                pool.submit(worker, 2_000_000),
            ]
            for fut in futs:
                fut.result(timeout=30)
        assert errors == []
        assert store.get_state(subject) is not None
    finally:
        store.close()
