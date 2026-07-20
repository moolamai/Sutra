"""Load proof: concurrent trajectory capture stays non-blocking under slow storage.

Admission p95 stays within NFR-06 (≤10ms). Trajectories become durable after drain.
Events stay metadata-only — never utterance / prompt bodies.
"""

from __future__ import annotations

import math
import threading
import time
from typing import Callable

import pytest

pytestmark = pytest.mark.slow

from sutra_orchestrator.trajectory import TurnTrajectoryV1
from sutra_orchestrator.trajectory_capture import (
    CloudTrajectoryCaptureHook,
    TrajectoryCaptureConsent,
    TrajectoryCaptureWriter,
)

LOAD_TURN_COUNT = 64
SLOW_STORAGE_MS = 0.080  # seconds — if capture awaited this, p95 would breach
CAPTURE_ADMISSION_P95_MS = 10.0  # NFR-06 composition ceiling


def valid_record(turn_id: str, **overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "trajectoryFormatVersion": "trajectory.v1",
        "turnId": turn_id,
        "subjectId": "learner-load-a",
        "deviceId": "cloud-load-1",
        "sessionId": "session-load-1",
        "capturedAt": "001700000000100:000002:cloud-load-1",
        "locality": "self-hosted",
        "consentRecordId": "consent-traj-load-1",
        "stages": [
            {"stage": "perceive", "status": "ok", "chunkIndex": 0},
            {"stage": "reason", "status": "ok", "chunkIndex": 0},
            {"stage": "act", "status": "ok", "chunkIndex": 0},
        ],
        "toolCalls": [],
        "outcomes": {"status": "completed", "terminalStage": "act"},
        "modelId": "cloud-load-model",
        "promptHash": "sha256:promptload01",
        "responseHash": "sha256:responseload01",
    }
    value.update(overrides)
    return value


def active_consent(**overrides: object) -> TrajectoryCaptureConsent:
    values: dict[str, object] = {
        "consent_record_id": "consent-traj-load-1",
        "subject_id": "learner-load-a",
        "scope": "trajectory",
        "opted_in": True,
        "active": True,
    }
    values.update(overrides)
    return TrajectoryCaptureConsent(**values)  # type: ignore[arg-type]


def percentile(sorted_asc: list[float], p: float) -> float:
    if not sorted_asc:
        return float("nan")
    idx = min(len(sorted_asc) - 1, max(0, int(math.ceil(p / 100 * len(sorted_asc))) - 1))
    return sorted_asc[idx]


class SlowMemoryTrajectoryRepository:
    def __init__(self, *, delay_seconds: float = SLOW_STORAGE_MS) -> None:
        self.pending: dict[tuple[str, str], dict[str, object]] = {}
        self.stored: dict[tuple[str, str], dict[str, object]] = {}
        self.delay_seconds = delay_seconds
        self.lock = threading.RLock()
        self.write_calls = 0

    def initialize(self) -> None:
        return None

    def put_write_ahead(self, record: TurnTrajectoryV1) -> None:
        time.sleep(self.delay_seconds)
        with self.lock:
            self.write_calls += 1
            self.pending.setdefault(
                (record.subjectId, record.turnId),
                record.model_dump(mode="json", exclude_none=True),
            )

    def commit(self, record: TurnTrajectoryV1) -> None:
        time.sleep(self.delay_seconds)
        with self.lock:
            self.write_calls += 1
            key = (record.subjectId, record.turnId)
            self.stored.setdefault(
                key,
                record.model_dump(mode="json", exclude_none=True),
            )
            self.pending.pop(key, None)

    def discard(self, subject_id: str, turn_id: str) -> None:
        with self.lock:
            self.write_calls += 1
            self.pending.pop((subject_id, turn_id), None)

    def recover(self, subject_id: str, *, limit: int) -> list[object]:
        with self.lock:
            return [
                payload
                for (row_subject, _), payload in self.pending.items()
                if row_subject == subject_id
            ][:limit]


def make_writer(
    repository: SlowMemoryTrajectoryRepository,
    *,
    capacity: int = LOAD_TURN_COUNT,
    max_retries: int = 0,
) -> tuple[
    TrajectoryCaptureWriter,
    list[dict[str, object]],
    Callable[[TrajectoryCaptureConsent], None],
]:
    events: list[dict[str, object]] = []
    consent = active_consent()

    def set_consent(value: TrajectoryCaptureConsent) -> None:
        nonlocal consent
        consent = value

    writer = TrajectoryCaptureWriter(
        repository=repository,
        subject_id="learner-load-a",
        locality="self-hosted",
        resolve_consent=lambda _consent_id: consent,
        capacity=capacity,
        max_retries=max_retries,
        on_event=lambda event: events.append(dict(event)),
    )
    writer.initialize()
    return writer, events, set_consent


def test_load_concurrent_captures_return_before_slow_storage_p95_within_nfr06() -> None:
    repository = SlowMemoryTrajectoryRepository()
    writer, events, _ = make_writer(repository)
    try:
        latencies: list[float] = []
        results = []
        wall_started = time.perf_counter()
        for i in range(LOAD_TURN_COUNT):
            t0 = time.perf_counter()
            result = writer.capture_trajectory(valid_record(f"turn-load-{i}"))
            latencies.append((time.perf_counter() - t0) * 1000.0)
            results.append(result)
        admission_wall_ms = (time.perf_counter() - wall_started) * 1000.0

        assert admission_wall_ms < SLOW_STORAGE_MS * 1000.0
        assert repository.stored == {}
        assert all(r.queued and not r.duplicate for r in results)

        p95 = percentile(sorted(latencies), 95)
        assert p95 <= CAPTURE_ADMISSION_P95_MS, (
            f"capture admission p95 {p95:.3f}ms exceeds NFR-06 budget "
            f"{CAPTURE_ADMISSION_P95_MS}ms"
        )

        assert writer.wait_until_idle(SLOW_STORAGE_MS * LOAD_TURN_COUNT * 4 + 5.0)
        assert len(repository.stored) == LOAD_TURN_COUNT
        assert repository.pending == {}
        assert {row["subjectId"] for row in repository.stored.values()} == {
            "learner-load-a"
        }
        assert any(e.get("outcome") == "queued" for e in events)
        assert any(e.get("outcome") == "persisted" for e in events)
        blob = str(events)
        assert "SECRET_" not in blob
        assert "utterance" not in blob
        assert "promptHash" not in blob
    finally:
        writer.close()


def test_load_backpressure_drops_without_blocking_turn() -> None:
    repository = SlowMemoryTrajectoryRepository(delay_seconds=0.2)
    writer, events, _ = make_writer(repository, capacity=4)
    try:
        latencies: list[float] = []
        queued = 0
        dropped = 0
        for i in range(12):
            t0 = time.perf_counter()
            result = writer.capture_trajectory(valid_record(f"turn-bp-{i}"))
            latencies.append((time.perf_counter() - t0) * 1000.0)
            if result.queued:
                queued += 1
            else:
                dropped += 1
                assert result.failure_class == "queue_full"
        assert queued == 4
        assert dropped == 8
        assert writer.dropped_count == 8
        p95 = percentile(sorted(latencies), 95)
        assert p95 <= CAPTURE_ADMISSION_P95_MS
        assert any(
            e.get("outcome") == "dropped" and e.get("failureClass") == "queue_full"
            for e in events
        )
    finally:
        writer.close(timeout_seconds=5.0)


def test_sovereignty_under_load_cross_subject_never_persists() -> None:
    repository = SlowMemoryTrajectoryRepository(delay_seconds=0.02)
    writer, events, _ = make_writer(repository, capacity=32)
    try:
        for i in range(16):
            assert writer.capture_trajectory(valid_record(f"a-{i}")).queued
        cross = writer.capture_trajectory(
            valid_record("cross", subjectId="learner-load-b")
        )
        assert cross.queued is False
        assert cross.failure_class == "cross_subject"
        assert writer.wait_until_idle(10.0)
        assert len(repository.stored) == 16
        assert all(
            row["subjectId"] == "learner-load-a" for row in repository.stored.values()
        )
        assert any(e.get("failureClass") == "cross_subject" for e in events)
    finally:
        writer.close()


def test_load_consent_revoked_mid_drain_and_idempotent_replay() -> None:
    repository = SlowMemoryTrajectoryRepository(delay_seconds=0.03)
    writer, events, set_consent = make_writer(repository, capacity=8)
    try:
        assert writer.capture_trajectory(valid_record("turn-revoke")).queued
        set_consent(active_consent(active=False, opted_in=False))
        assert writer.wait_until_idle(5.0)
        assert repository.stored == {}
        assert any(
            e.get("outcome") == "rejected"
            and e.get("failureClass") in {"consent_denied", "consent_missing"}
            for e in events
        )
    finally:
        writer.close()

    recovered = SlowMemoryTrajectoryRepository(delay_seconds=0.02)
    recovered.pending[("learner-load-a", "turn-recover")] = TurnTrajectoryV1.model_validate(
        valid_record("turn-recover")
    ).model_dump(mode="json", exclude_none=True)
    writer2, recovered_events, _ = make_writer(recovered, capacity=8)
    try:
        assert writer2.wait_until_idle(5.0)
        assert len(recovered.stored) == 1
        assert any(e.get("outcome") == "recovered" for e in recovered_events)
        assert writer2.capture_trajectory(valid_record("turn-recover")).queued
        assert writer2.wait_until_idle(5.0)
        assert len(recovered.stored) == 1
    finally:
        writer2.close()


def test_cloud_hook_under_load_skips_absent_consent_and_queues_when_active() -> None:
    repository = SlowMemoryTrajectoryRepository(delay_seconds=0.02)
    writer, _, _ = make_writer(repository, capacity=32)
    hook_events: list[dict[str, object]] = []
    active = True

    def resolve_consent(subject_id: str) -> str | None:
        if not active:
            return None
        return "consent-traj-load-1" if subject_id == "learner-load-a" else None

    hook = CloudTrajectoryCaptureHook(
        writer_for_subject=lambda sid: writer if sid == "learner-load-a" else None,
        resolve_active_consent_record_id=resolve_consent,
        on_event=lambda event: hook_events.append(dict(event)),
    )
    try:
        active = False
        skipped = hook.capture_after_reflect(
            subject_id="learner-load-a",
            device_id="cloud-load-1",
            session_id="session-load-skip",
            captured_at="001700000000100:000002:cloud-load-1",
            prompt="SECRET_LOAD_PROMPT",
            reply="SECRET_LOAD_REPLY",
            model_id="cloud-load-model",
        )
        assert skipped.captured is False
        assert skipped.failure_class == "consent_missing"
        assert repository.write_calls == 0

        active = True
        latencies: list[float] = []
        for i in range(24):
            t0 = time.perf_counter()
            result = hook.capture_after_reflect(
                subject_id="learner-load-a",
                device_id="cloud-load-1",
                session_id=f"session-load-{i}",
                captured_at=f"0017000000001{i:02d}:000002:cloud-load-1",
                prompt="SECRET_LOAD_PROMPT",
                reply="SECRET_LOAD_REPLY",
                model_id="cloud-load-model",
            )
            latencies.append((time.perf_counter() - t0) * 1000.0)
            assert result.captured is True
        p95 = percentile(sorted(latencies), 95)
        # Hook builds hashes synchronously then admits; keep well under routing NFR-04.
        assert p95 <= 50.0
        assert writer.wait_until_idle(10.0)
        assert len(repository.stored) == 24
        blob = str(list(repository.stored.values()))
        assert "SECRET_LOAD_PROMPT" not in blob
        assert "SECRET_LOAD_REPLY" not in blob
        assert "SECRET_LOAD_PROMPT" not in str(hook_events)
    finally:
        writer.close()
