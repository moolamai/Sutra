"""Bounded cloud trajectory write-ahead queue behavior."""

from __future__ import annotations

import threading
from typing import Callable

from sutra_orchestrator.trajectory import TurnTrajectoryV1
from sutra_orchestrator.trajectory_capture import (
    CloudTrajectoryCaptureHook,
    PostgresTrajectoryRepository,
    TrajectoryCaptureConsent,
    TrajectoryCaptureWriter,
)


def valid_record(turn_id: str = "turn-1", **overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "trajectoryFormatVersion": "trajectory.v1",
        "turnId": turn_id,
        "subjectId": "learner-a",
        "deviceId": "cloud-dev1",
        "capturedAt": "001700000000100:000002:cloud-dev1",
        "locality": "self-hosted",
        "consentRecordId": "consent-traj-001",
        "stages": [
            {"stage": "perceive", "status": "ok", "chunkIndex": 0},
            {"stage": "reason", "status": "ok", "chunkIndex": 0},
            {"stage": "act", "status": "ok", "chunkIndex": 0},
        ],
        "toolCalls": [],
        "outcomes": {"status": "completed", "terminalStage": "act"},
        "modelId": "cloud-model-v1",
        "promptHash": "sha256:prompt01",
        "responseHash": "sha256:response01",
    }
    value.update(overrides)
    return value


def active_consent(**overrides: object) -> TrajectoryCaptureConsent:
    values: dict[str, object] = {
        "consent_record_id": "consent-traj-001",
        "subject_id": "learner-a",
        "scope": "trajectory",
        "opted_in": True,
        "active": True,
    }
    values.update(overrides)
    return TrajectoryCaptureConsent(**values)  # type: ignore[arg-type]


class MemoryTrajectoryRepository:
    def __init__(
        self,
        *,
        write_ahead_gate: threading.Event | None = None,
        after_write_ahead: Callable[[], None] | None = None,
        commit_error: Exception | None = None,
    ) -> None:
        self.pending: dict[tuple[str, str], dict[str, object]] = {}
        self.stored: dict[tuple[str, str], dict[str, object]] = {}
        self.write_ahead_gate = write_ahead_gate
        self.after_write_ahead = after_write_ahead
        self.commit_error = commit_error
        self.write_ahead_started = threading.Event()
        self.lock = threading.RLock()
        self.write_calls = 0

    def initialize(self) -> None:
        return None

    def put_write_ahead(self, record: TurnTrajectoryV1) -> None:
        self.write_ahead_started.set()
        if self.write_ahead_gate is not None:
            assert self.write_ahead_gate.wait(2.0)
        with self.lock:
            self.write_calls += 1
            self.pending.setdefault(
                (record.subjectId, record.turnId),
                record.model_dump(mode="json", exclude_none=True),
            )
        if self.after_write_ahead is not None:
            self.after_write_ahead()

    def commit(self, record: TurnTrajectoryV1) -> None:
        if self.commit_error is not None:
            raise self.commit_error
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
    repository: MemoryTrajectoryRepository,
    *,
    capacity: int = 4,
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
        subject_id="learner-a",
        locality="self-hosted",
        resolve_consent=lambda _consent_id: consent,
        capacity=capacity,
        max_retries=max_retries,
        on_event=lambda event: events.append(dict(event)),
    )
    writer.initialize()
    return writer, events, set_consent


def test_postgres_repository_declares_subject_scoped_idempotent_tables() -> None:
    assert PostgresTrajectoryRepository
    from sutra_orchestrator.trajectory_capture import TRAJECTORY_TABLES_SQL

    assert "PRIMARY KEY (subject_id, turn_id)" in TRAJECTORY_TABLES_SQL
    assert "WHERE subject_id = %s AND turn_id = %s" not in TRAJECTORY_TABLES_SQL
    assert "trajectory_write_ahead" in TRAJECTORY_TABLES_SQL
    assert "turn_trajectories" in TRAJECTORY_TABLES_SQL


def test_capture_returns_before_durable_write_completes() -> None:
    gate = threading.Event()
    repository = MemoryTrajectoryRepository(write_ahead_gate=gate)
    writer, events, _ = make_writer(repository)
    try:
        result = writer.capture_trajectory(valid_record())
        assert result.queued is True
        assert repository.stored == {}
        assert repository.write_ahead_started.wait(1.0)
        assert repository.stored == {}

        gate.set()
        assert writer.wait_until_idle(2.0)
        assert repository.pending == {}
        assert len(repository.stored) == 1
        assert any(event["outcome"] == "persisted" for event in events)
        assert all("prompt" not in event and "responseHash" not in event for event in events)
    finally:
        gate.set()
        writer.close()


def test_backpressure_drops_after_capacity_without_blocking_turn() -> None:
    gate = threading.Event()
    repository = MemoryTrajectoryRepository(write_ahead_gate=gate)
    writer, events, _ = make_writer(repository, capacity=1)
    try:
        assert writer.capture_trajectory(valid_record("turn-1")).queued is True
        second = writer.capture_trajectory(valid_record("turn-2"))
        assert second.queued is False
        assert second.failure_class == "queue_full"
        assert writer.dropped_count == 1
        assert any(
            event.get("outcome") == "dropped"
            and event.get("failureClass") == "queue_full"
            for event in events
        )
    finally:
        gate.set()
        writer.close()


def test_consent_revoked_after_write_ahead_discards_before_final_insert() -> None:
    set_consent: Callable[[TrajectoryCaptureConsent], None]
    repository = MemoryTrajectoryRepository(
        after_write_ahead=lambda: set_consent(
            active_consent(active=False, opted_in=False)
        )
    )
    writer, events, set_consent = make_writer(repository)
    try:
        assert writer.capture_trajectory(valid_record()).queued is True
        assert writer.wait_until_idle(2.0)
        assert repository.pending == {}
        assert repository.stored == {}
        assert any(
            event.get("outcome") == "rejected"
            and event.get("failureClass") == "consent_denied"
            for event in events
        )
    finally:
        writer.close()


def test_cross_subject_and_raw_keystrokes_rejected_before_storage() -> None:
    repository = MemoryTrajectoryRepository()
    writer, events, _ = make_writer(repository)
    try:
        cross = writer.capture_trajectory(
            valid_record("turn-cross", subjectId="learner-b")
        )
        raw = writer.capture_trajectory(
            valid_record("turn-raw", keystrokes="private typing")
        )
        assert cross.failure_class == "cross_subject"
        assert raw.failure_class == "keystroke_forbidden"
        assert repository.write_calls == 0
        assert {event.get("failureClass") for event in events} >= {
            "cross_subject",
            "keystroke_forbidden",
        }
    finally:
        writer.close()


def test_replay_is_idempotent_and_timeout_retries_are_bounded() -> None:
    repository = MemoryTrajectoryRepository()
    writer, _, _ = make_writer(repository)
    try:
        assert writer.capture_trajectory(valid_record()).queued is True
        assert writer.wait_until_idle(2.0)
        assert writer.capture_trajectory(valid_record()).queued is True
        assert writer.wait_until_idle(2.0)
        assert len(repository.stored) == 1
    finally:
        writer.close()

    recovered_repository = MemoryTrajectoryRepository()
    recovered = TurnTrajectoryV1.model_validate(valid_record("turn-recovered"))
    recovered_repository.pending[("learner-a", "turn-recovered")] = (
        recovered.model_dump(mode="json", exclude_none=True)
    )
    recovered_writer, recovered_events, _ = make_writer(recovered_repository)
    try:
        assert recovered_writer.wait_until_idle(2.0)
        assert recovered_repository.pending == {}
        assert len(recovered_repository.stored) == 1
        assert any(
            event.get("outcome") == "recovered" for event in recovered_events
        )
    finally:
        recovered_writer.close()

    timeout_repository = MemoryTrajectoryRepository(
        commit_error=TimeoutError("postgres statement timeout")
    )
    timeout_writer, events, _ = make_writer(timeout_repository, max_retries=1)
    try:
        assert timeout_writer.capture_trajectory(valid_record("turn-timeout")).queued
        assert timeout_writer.wait_until_idle(2.0)
        retrying = [
            event
            for event in events
            if event.get("outcome") == "retrying"
            and event.get("failureClass") == "storage_timeout"
        ]
        rejected = [
            event
            for event in events
            if event.get("outcome") == "rejected"
            and event.get("failureClass") == "storage_timeout"
        ]
        assert len(retrying) == 1
        assert len(rejected) == 1
        assert timeout_repository.write_calls == 2
    finally:
        timeout_writer.close()


def test_cloud_hook_attaches_consent_hashes_content_and_queues_metadata() -> None:
    repository = MemoryTrajectoryRepository()
    writer, _, _ = make_writer(repository)
    hook_events: list[dict[str, object]] = []
    hook = CloudTrajectoryCaptureHook(
        writer_for_subject=lambda subject_id: (
            writer if subject_id == "learner-a" else None
        ),
        resolve_active_consent_record_id=lambda _subject_id: "consent-traj-001",
        on_event=lambda event: hook_events.append(dict(event)),
    )
    try:
        result = hook.capture_after_reflect(
            subject_id="learner-a",
            device_id="cloud-dev1",
            session_id="session-cloud-1",
            captured_at="001700000000100:000002:cloud-dev1",
            prompt="SECRET_CLOUD_PROMPT",
            reply="SECRET_CLOUD_REPLY",
            model_id="cloud-model-v1",
        )
        assert result.captured is True
        assert repository.stored == {}
        assert writer.wait_until_idle(2.0)
        assert len(repository.stored) == 1
        record = next(iter(repository.stored.values()))
        assert record["consentRecordId"] == "consent-traj-001"
        assert str(record["promptHash"]).startswith("sha256:")
        assert str(record["responseHash"]).startswith("sha256:")
        serialized = str(record)
        assert "SECRET_CLOUD_PROMPT" not in serialized
        assert "SECRET_CLOUD_REPLY" not in serialized
        assert any(event["outcome"] == "queued" for event in hook_events)
        assert "SECRET_CLOUD_PROMPT" not in str(hook_events)
        assert "SECRET_CLOUD_REPLY" not in str(hook_events)
    finally:
        writer.close()


def test_cloud_hook_skips_absent_consent_without_empty_record() -> None:
    repository = MemoryTrajectoryRepository()
    writer, _, _ = make_writer(repository)
    events: list[dict[str, object]] = []
    hook = CloudTrajectoryCaptureHook(
        writer_for_subject=lambda _subject_id: writer,
        resolve_active_consent_record_id=lambda _subject_id: None,
        on_event=lambda event: events.append(dict(event)),
    )
    try:
        result = hook.capture_after_reflect(
            subject_id="learner-a",
            device_id="cloud-dev1",
            session_id="session-cloud-1",
            captured_at="001700000000100:000002:cloud-dev1",
            prompt="not captured",
            reply="not captured either",
            model_id="cloud-model-v1",
        )
        assert result.captured is False
        assert result.failure_class == "consent_missing"
        assert repository.write_calls == 0
        assert repository.stored == {}
        assert any(
            event.get("outcome") == "skipped"
            and event.get("failureClass") == "consent_missing"
            for event in events
        )
    finally:
        writer.close()


def test_cloud_hook_cross_subject_writer_rejects_before_storage() -> None:
    repository = MemoryTrajectoryRepository()
    writer, _, _ = make_writer(repository)
    hook = CloudTrajectoryCaptureHook(
        writer_for_subject=lambda _subject_id: writer,
        resolve_active_consent_record_id=lambda _subject_id: "consent-traj-001",
    )
    try:
        result = hook.capture_after_reflect(
            subject_id="learner-b",
            device_id="cloud-dev1",
            session_id="session-cloud-b",
            captured_at="001700000000100:000002:cloud-dev1",
            prompt="subject b prompt",
            reply="subject b reply",
            model_id="cloud-model-v1",
        )
        assert result.captured is False
        assert result.failure_class == "cross_subject"
        assert repository.write_calls == 0
    finally:
        writer.close()
