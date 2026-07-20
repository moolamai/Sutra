"""Store protocol + in-memory backend."""

from __future__ import annotations

import logging
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
    InMemoryMasterStateStore,
    MasterStateRepository,
    StaleStateVectorError,
)
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
                hesitationMs=1200,
                inputVelocity=3.2,
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


def test_happy_path_get_put_round_trip() -> None:
    store: MasterStateRepository = InMemoryMasterStateStore()
    subject = f"subj-{uuid.uuid4().hex[:8]}"
    state = _make_state(subject)

    assert store.get_state(subject) is None  # not-found
    with store.subject_guard(subject):
        store.put_state(state, expected_subject_id=subject)
        loaded = store.get_state(subject)

    assert loaded is not None
    assert loaded.model_dump() == state.model_dump()


def test_edge_stale_state_vector_rejected() -> None:
    store = InMemoryMasterStateStore()
    subject = f"subj-{uuid.uuid4().hex[:8]}"
    first = _make_state(subject, session_ms=1_000_000)
    store.put_state(first)

    stale = _make_state(subject, session_ms=2_000_000)
    with pytest.raises(StaleStateVectorError) as exc:
        store.put_state(
            stale,
            expected_state_vector={"session": _hlc(999, 0, "edge-aaaa")},
        )
    assert exc.value.subject_id == subject
    # Committed document unchanged (no last-write-wins).
    assert store.get_state(subject) == first


def test_edge_concurrent_same_subject_serialized() -> None:
    store = InMemoryMasterStateStore()
    subject = f"subj-{uuid.uuid4().hex[:8]}"
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def worker(session_ms: int) -> None:
        try:
            barrier.wait(timeout=5)
            with store.subject_guard(subject):
                current = store.get_state(subject)
                base = current or _make_state(subject, session_ms=session_ms)
                nxt = base.model_copy(
                    update={
                        "stateVector": {
                            "session": _hlc(session_ms, 3, "edge-aaaa"),
                        },
                        "mastery": {
                            "math.ratios": ConceptMastery(
                                conceptId="math.ratios",
                                alpha={"edge-aaaa": float(session_ms)},
                                beta={"edge-aaaa": 1.0},
                                lastExercisedAt=_hlc(session_ms, 0, "edge-aaaa"),
                            )
                        },
                    }
                )
                store.put_state(nxt, expected_subject_id=subject)
        except BaseException as err:  # noqa: BLE001 — collect into list
            errors.append(err)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futs = [pool.submit(worker, 1_000_000), pool.submit(worker, 2_000_000)]
        for fut in futs:
            fut.result(timeout=10)

    assert errors == []
    final = store.get_state(subject)
    assert final is not None
    # Exactly one committed document; both writers finished under the guard.
    assert "session" in final.stateVector


def test_sovereignty_cross_subject_put_refused(caplog: pytest.LogCaptureFixture) -> None:
    store = InMemoryMasterStateStore()
    a = f"subj-a-{uuid.uuid4().hex[:8]}"
    b = f"subj-b-{uuid.uuid4().hex[:8]}"
    foreign = _make_state(b)

    with caplog.at_level(logging.INFO, logger="sutra_orchestrator.master_state_repository"):
        with pytest.raises(CrossSubjectAccessError):
            store.put_state(foreign, expected_subject_id=a)

    assert store.get_state(a) is None
    assert store.get_state(b) is None
    # Observability: structured outcome, never raw learner content.
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "cross_subject_refused" in joined or "cross-subject" in joined.lower()
    assert "opaque-not-for-logs" not in joined
    assert '"frictionLog"' not in joined


def test_sync_service_uses_protocol_and_is_idempotent() -> None:
    from sutra_orchestrator.contract_models import SyncRequest

    store = InMemoryMasterStateStore()
    service = SyncService(store)
    subject = f"subj-{uuid.uuid4().hex[:8]}"
    edge = _make_state(subject)
    req = SyncRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        deviceId="edge-aaaa",
        edgeState=edge,
        lastKnownCloudVector={},
        syncAttemptId=str(uuid.uuid4()),
    )
    first = service.reconcile(req)
    second = service.reconcile(req)
    assert first.mergedState.model_dump() == second.mergedState.model_dump()
    assert store.get_state(subject) is not None


def test_in_memory_restart_loses_state_by_contract() -> None:
    """In-memory durability boundary: a new store instance is empty (restart)."""
    subject = f"subj-{uuid.uuid4().hex[:8]}"
    store_a = InMemoryMasterStateStore()
    store_a.put_state(_make_state(subject))
    assert store_a.get_state(subject) is not None

    store_b = InMemoryMasterStateStore()
    assert store_b.get_state(subject) is None
