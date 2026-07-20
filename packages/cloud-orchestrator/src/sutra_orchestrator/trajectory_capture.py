"""Bounded, subject-scoped trajectory write-ahead queue.

Capture admission is synchronous and never waits for Postgres. A background
worker durably inserts a pending row before the idempotent final row. Consent is
checked before admission and again immediately before persistence.
"""

from __future__ import annotations

import hashlib
import logging
import queue
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable, Literal, Mapping, Protocol, runtime_checkable

from pydantic import ValidationError

from .trajectory import TurnTrajectoryV1

if TYPE_CHECKING:
    from psycopg_pool import ConnectionPool

logger = logging.getLogger(__name__)

DEFAULT_QUEUE_CAPACITY = 128
MAX_QUEUE_CAPACITY = 4_096
DEFAULT_MAX_RETRIES = 2
DEFAULT_RECOVERY_LIMIT = 128
TRAJECTORY_CONTENT_HASH_MAX_BYTES = 64_000

TRAJECTORY_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS trajectory_write_ahead (
    subject_id       TEXT NOT NULL,
    turn_id          TEXT NOT NULL,
    device_id        TEXT NOT NULL,
    consent_record_id TEXT NOT NULL,
    payload          JSONB NOT NULL,
    enqueued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (subject_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_trajectory_write_ahead_subject_enqueued
  ON trajectory_write_ahead (subject_id, enqueued_at ASC, turn_id ASC);

CREATE TABLE IF NOT EXISTS turn_trajectories (
    subject_id       TEXT NOT NULL,
    turn_id          TEXT NOT NULL,
    device_id        TEXT NOT NULL,
    consent_record_id TEXT NOT NULL,
    captured_at      TEXT NOT NULL,
    locality         TEXT NOT NULL,
    payload          JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (subject_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_turn_trajectories_subject_created
  ON turn_trajectories (subject_id, created_at DESC, turn_id DESC);
"""

FORBIDDEN_CONTENT_KEYS = frozenset(
    {
        "keystrokes",
        "rawKeystrokes",
        "utterance",
        "prompt",
        "completion",
        "reply",
        "arguments",
        "toolArgs",
        "rawArgs",
        "inputText",
        "responseText",
    }
)


@dataclass(frozen=True)
class TrajectoryCaptureConsent:
    consent_record_id: str
    subject_id: str
    scope: Literal["trajectory"]
    opted_in: bool
    active: bool


@dataclass(frozen=True)
class CaptureTrajectoryResult:
    queued: bool
    duplicate: bool
    subject_id: str | None
    turn_id: str | None
    failure_class: str | None = None
    detail: str | None = None


@dataclass(frozen=True)
class CloudTrajectoryHookResult:
    captured: bool
    subject_id: str
    turn_id: str
    failure_class: str | None = None


@runtime_checkable
class TurnTrajectoryCaptureHook(Protocol):
    """Post-reflect hook consumed by ``AgentRuntime``."""

    def capture_after_reflect(
        self,
        *,
        subject_id: str,
        device_id: str,
        session_id: str,
        captured_at: str,
        prompt: str,
        reply: str,
        model_id: str,
        declined: bool = False,
    ) -> CloudTrajectoryHookResult: ...


@runtime_checkable
class TrajectoryRepository(Protocol):
    """Durable substrate; all operations are explicitly subject-scoped."""

    def initialize(self) -> None: ...

    def put_write_ahead(self, record: TurnTrajectoryV1) -> None: ...

    def commit(self, record: TurnTrajectoryV1) -> None:
        """Idempotently insert final row and remove pending row atomically."""
        ...

    def discard(self, subject_id: str, turn_id: str) -> None: ...

    def recover(self, subject_id: str, *, limit: int) -> list[object]: ...


class PostgresTrajectoryRepository:
    """Postgres JSONB implementation with idempotent subject/turn keys."""

    def __init__(
        self,
        pool: ConnectionPool,
        *,
        connection_timeout_seconds: float = 5.0,
        statement_timeout_ms: int = 5_000,
    ) -> None:
        if connection_timeout_seconds <= 0:
            raise ValueError("connection_timeout_seconds must be positive")
        if statement_timeout_ms < 1:
            raise ValueError("statement_timeout_ms must be positive")
        self._pool = pool
        self._connection_timeout_seconds = connection_timeout_seconds
        self._statement_timeout_ms = statement_timeout_ms

    def initialize(self) -> None:
        with self._pool.connection(timeout=self._connection_timeout_seconds) as conn:
            with conn.transaction():
                self._set_statement_timeout(conn)
                for statement in TRAJECTORY_TABLES_SQL.split(";"):
                    if statement.strip():
                        conn.execute(statement)

    def put_write_ahead(self, record: TurnTrajectoryV1) -> None:
        payload = record.model_dump_json(exclude_none=True)
        with self._pool.connection(timeout=self._connection_timeout_seconds) as conn:
            with conn.transaction():
                self._set_statement_timeout(conn)
                conn.execute(
                    """
                    INSERT INTO trajectory_write_ahead
                      (subject_id, turn_id, device_id, consent_record_id, payload)
                    VALUES (%s, %s, %s, %s, %s::jsonb)
                    ON CONFLICT (subject_id, turn_id) DO NOTHING
                    """,
                    (
                        record.subjectId,
                        record.turnId,
                        record.deviceId,
                        record.consentRecordId,
                        payload,
                    ),
                )

    def commit(self, record: TurnTrajectoryV1) -> None:
        payload = record.model_dump_json(exclude_none=True)
        with self._pool.connection(timeout=self._connection_timeout_seconds) as conn:
            with conn.transaction():
                self._set_statement_timeout(conn)
                conn.execute(
                    """
                    INSERT INTO turn_trajectories
                      (subject_id, turn_id, device_id, consent_record_id,
                       captured_at, locality, payload)
                    VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
                    ON CONFLICT (subject_id, turn_id) DO NOTHING
                    """,
                    (
                        record.subjectId,
                        record.turnId,
                        record.deviceId,
                        record.consentRecordId,
                        record.capturedAt,
                        record.locality,
                        payload,
                    ),
                )
                conn.execute(
                    """
                    DELETE FROM trajectory_write_ahead
                    WHERE subject_id = %s AND turn_id = %s
                    """,
                    (record.subjectId, record.turnId),
                )

    def discard(self, subject_id: str, turn_id: str) -> None:
        with self._pool.connection(timeout=self._connection_timeout_seconds) as conn:
            with conn.transaction():
                self._set_statement_timeout(conn)
                conn.execute(
                    """
                    DELETE FROM trajectory_write_ahead
                    WHERE subject_id = %s AND turn_id = %s
                    """,
                    (subject_id, turn_id),
                )

    def recover(self, subject_id: str, *, limit: int) -> list[object]:
        with self._pool.connection(timeout=self._connection_timeout_seconds) as conn:
            with conn.transaction():
                self._set_statement_timeout(conn)
                rows = conn.execute(
                    """
                    SELECT payload
                    FROM trajectory_write_ahead
                    WHERE subject_id = %s
                    ORDER BY enqueued_at ASC, turn_id ASC
                    LIMIT %s
                    """,
                    (subject_id, limit),
                ).fetchall()
        return [row[0] for row in rows]

    def _set_statement_timeout(self, conn: object) -> None:
        conn.execute(  # type: ignore[attr-defined]
            "SELECT set_config('statement_timeout', %s, true)",
            (f"{self._statement_timeout_ms}ms",),
        )


def _contains_forbidden_content(value: object) -> bool:
    if isinstance(value, Mapping):
        if any(str(key) in FORBIDDEN_CONTENT_KEYS for key in value):
            return True
        return any(_contains_forbidden_content(child) for child in value.values())
    if isinstance(value, list):
        return any(_contains_forbidden_content(child) for child in value)
    return False


class CloudTrajectoryCaptureHook:
    """Build a metadata-only v1 record after cloud turn completion."""

    def __init__(
        self,
        *,
        writer_for_subject: Callable[[str], TrajectoryCaptureWriter | None],
        resolve_active_consent_record_id: Callable[[str], str | None],
        on_event: Callable[[Mapping[str, object]], None] | None = None,
    ) -> None:
        self._writer_for_subject = writer_for_subject
        self._resolve_active_consent_record_id = resolve_active_consent_record_id
        self._on_event = on_event

    def capture_after_reflect(
        self,
        *,
        subject_id: str,
        device_id: str,
        session_id: str,
        captured_at: str,
        prompt: str,
        reply: str,
        model_id: str,
        declined: bool = False,
    ) -> CloudTrajectoryHookResult:
        turn_id = self._turn_id(subject_id, session_id, captured_at)
        try:
            consent_record_id = (
                self._resolve_active_consent_record_id(subject_id) or ""
            ).strip()
        except Exception:
            return self._reject(
                subject_id,
                device_id,
                turn_id,
                "consent_resolve_failed",
            )
        if not consent_record_id:
            self._emit(
                outcome="skipped",
                subject_id=subject_id,
                device_id=device_id,
                turn_id=turn_id,
                failure_class="consent_missing",
            )
            return CloudTrajectoryHookResult(
                captured=False,
                subject_id=subject_id,
                turn_id=turn_id,
                failure_class="consent_missing",
            )

        writer = self._writer_for_subject(subject_id)
        if writer is None:
            return self._reject(subject_id, device_id, turn_id, "writer_missing")

        prompt_bytes = prompt.encode("utf-8")
        reply_bytes = reply.encode("utf-8")
        if (
            len(prompt_bytes) > TRAJECTORY_CONTENT_HASH_MAX_BYTES
            or len(reply_bytes) > TRAJECTORY_CONTENT_HASH_MAX_BYTES
        ):
            return self._reject(
                subject_id,
                device_id,
                turn_id,
                "content_too_large",
            )

        record = {
            "trajectoryFormatVersion": "trajectory.v1",
            "turnId": turn_id,
            "subjectId": subject_id,
            "deviceId": device_id,
            "sessionId": session_id,
            "capturedAt": captured_at,
            "locality": "self-hosted",
            "consentRecordId": consent_record_id,
            "stages": [
                {"stage": "perceive", "status": "ok", "chunkIndex": 0},
                {"stage": "reason", "status": "ok", "chunkIndex": 0},
                {
                    "stage": "act",
                    "status": "skipped" if declined else "ok",
                    "chunkIndex": 0,
                },
            ],
            "toolCalls": [],
            "outcomes": {
                "status": "completed",
                "terminalStage": "reason" if declined else "act",
            },
            "modelId": (model_id.strip() or "cloud-provider")[:256],
            "promptHash": f"sha256:{hashlib.sha256(prompt_bytes).hexdigest()}",
            "responseHash": f"sha256:{hashlib.sha256(reply_bytes).hexdigest()}",
            "promptByteLength": len(prompt_bytes),
            "responseByteLength": len(reply_bytes),
        }
        result = writer.capture_trajectory(record)
        self._emit(
            outcome="queued" if result.queued else "rejected",
            subject_id=subject_id,
            device_id=device_id,
            turn_id=turn_id,
            failure_class=result.failure_class,
        )
        return CloudTrajectoryHookResult(
            captured=result.queued,
            subject_id=subject_id,
            turn_id=turn_id,
            failure_class=result.failure_class,
        )

    @staticmethod
    def _turn_id(subject_id: str, session_id: str, captured_at: str) -> str:
        digest = hashlib.sha256(
            f"{subject_id}\0{session_id}\0{captured_at}".encode()
        ).hexdigest()
        return f"turn-{digest[:32]}"

    def _reject(
        self,
        subject_id: str,
        device_id: str,
        turn_id: str,
        failure_class: str,
    ) -> CloudTrajectoryHookResult:
        self._emit(
            outcome="rejected",
            subject_id=subject_id,
            device_id=device_id,
            turn_id=turn_id,
            failure_class=failure_class,
        )
        return CloudTrajectoryHookResult(
            captured=False,
            subject_id=subject_id,
            turn_id=turn_id,
            failure_class=failure_class,
        )

    def _emit(
        self,
        *,
        outcome: str,
        subject_id: str,
        device_id: str,
        turn_id: str,
        failure_class: str | None = None,
    ) -> None:
        event: dict[str, object] = {
            "event": "cloud_orchestrator.trajectory_capture",
            "outcome": outcome,
            "subjectId": subject_id,
            "deviceId": device_id,
            "turnId": turn_id,
        }
        if failure_class is not None:
            event["failureClass"] = failure_class
        logger.info(
            "trajectory_hook outcome=%s subject_id=%s device_id=%s failure_class=%s",
            outcome,
            subject_id,
            device_id,
            failure_class,
        )
        if self._on_event is not None:
            try:
                self._on_event(event)
            except Exception:
                logger.exception(
                    "trajectory_hook observer_outcome=failed subject_id=%s",
                    subject_id,
                )


class TrajectoryCaptureWriter:
    """Bounded background writer shared by cloud trajectory capture hooks."""

    def __init__(
        self,
        *,
        repository: TrajectoryRepository,
        subject_id: str,
        locality: Literal["on-device", "self-hosted"],
        resolve_consent: Callable[[str], TrajectoryCaptureConsent | None],
        capacity: int = DEFAULT_QUEUE_CAPACITY,
        max_retries: int = DEFAULT_MAX_RETRIES,
        on_event: Callable[[Mapping[str, object]], None] | None = None,
    ) -> None:
        if not subject_id.strip():
            raise ValueError("trajectory writer subject_id is required")
        if not 1 <= capacity <= MAX_QUEUE_CAPACITY:
            raise ValueError(f"trajectory queue capacity must be 1..{MAX_QUEUE_CAPACITY}")
        if not 0 <= max_retries <= 10:
            raise ValueError("trajectory max_retries must be 0..10")

        self._repository = repository
        self._subject_id = subject_id.strip()
        self._locality = locality
        self._resolve_consent = resolve_consent
        self._capacity = capacity
        self._max_retries = max_retries
        self._on_event = on_event

        self._queue: queue.Queue[TurnTrajectoryV1] = queue.Queue(maxsize=capacity)
        self._slots = threading.BoundedSemaphore(capacity)
        self._lock = threading.RLock()
        self._admitted_keys: set[tuple[str, str]] = set()
        self._admitted_count = 0
        self._dropped_count = 0
        self._initialized = False
        self._stop = threading.Event()
        self._idle = threading.Event()
        self._idle.set()
        self._worker: threading.Thread | None = None

    @property
    def queue_depth(self) -> int:
        with self._lock:
            return self._admitted_count

    @property
    def dropped_count(self) -> int:
        with self._lock:
            return self._dropped_count

    def initialize(self) -> None:
        self._repository.initialize()
        self._initialized = True
        recovered = self._repository.recover(
            self._subject_id,
            limit=min(self._capacity, DEFAULT_RECOVERY_LIMIT),
        )
        for payload in recovered:
            self._recover_one(payload)
        self._worker = threading.Thread(
            target=self._run,
            name=f"trajectory-writer-{self._subject_id[:24]}",
            daemon=True,
        )
        self._worker.start()

    def capture_trajectory(self, payload: object) -> CaptureTrajectoryResult:
        """Validate and admit without waiting for durable repository calls."""
        if not self._initialized:
            return self._reject(
                "not_initialized",
                None,
                None,
                "trajectory writer must be initialized before capture",
            )
        if _contains_forbidden_content(payload):
            subject_id = (
                str(payload.get("subjectId"))
                if isinstance(payload, Mapping) and isinstance(payload.get("subjectId"), str)
                else None
            )
            return self._reject(
                "keystroke_forbidden",
                subject_id,
                None,
                "raw content key forbidden",
            )
        try:
            record = TurnTrajectoryV1.model_validate(payload)
        except ValidationError as error:
            subject_id = (
                str(payload.get("subjectId"))
                if isinstance(payload, Mapping) and isinstance(payload.get("subjectId"), str)
                else None
            )
            return self._reject("validation", subject_id, None, error.title)

        if record.subjectId != self._subject_id:
            return self._reject(
                "cross_subject",
                record.subjectId,
                record,
                f"writer is bound to '{self._subject_id}'",
            )
        if record.locality != self._locality:
            return self._reject(
                "locality_mismatch",
                record.subjectId,
                record,
                f"writer locality '{self._locality}' does not match record",
            )
        consent_failure = self._consent_failure(record)
        if consent_failure is not None:
            return self._reject(
                consent_failure,
                record.subjectId,
                record,
                "active subject-matched trajectory consent required",
            )
        return self._admit(record, recovered=False)

    def wait_until_idle(self, timeout_seconds: float = 5.0) -> bool:
        return self._idle.wait(max(0.001, timeout_seconds))

    def close(self, timeout_seconds: float = 5.0) -> bool:
        idle = self.wait_until_idle(timeout_seconds)
        self._stop.set()
        worker = self._worker
        if worker is not None:
            worker.join(timeout=max(0.001, timeout_seconds))
        return idle and (worker is None or not worker.is_alive())

    def _recover_one(self, payload: object) -> None:
        try:
            record = TurnTrajectoryV1.model_validate(payload)
        except ValidationError:
            self._emit(
                outcome="rejected",
                subject_id=self._subject_id,
                failure_class="recovery_invalid",
            )
            return
        if record.subjectId != self._subject_id:
            self._emit(
                outcome="rejected",
                record=record,
                failure_class="cross_subject",
            )
            return
        if record.locality != self._locality:
            self._emit(
                outcome="rejected",
                record=record,
                failure_class="locality_mismatch",
            )
            return
        consent_failure = self._consent_failure(record)
        if consent_failure is not None:
            self._repository.discard(record.subjectId, record.turnId)
            self._emit(
                outcome="rejected",
                record=record,
                failure_class=consent_failure,
            )
            return
        self._admit(record, recovered=True)

    def _admit(
        self,
        record: TurnTrajectoryV1,
        *,
        recovered: bool,
    ) -> CaptureTrajectoryResult:
        key = (record.subjectId, record.turnId)
        with self._lock:
            if key in self._admitted_keys:
                self._emit(outcome="duplicate", record=record)
                return CaptureTrajectoryResult(
                    queued=True,
                    duplicate=True,
                    subject_id=record.subjectId,
                    turn_id=record.turnId,
                )
            if not self._slots.acquire(blocking=False):
                self._dropped_count += 1
                self._emit(
                    outcome="dropped",
                    record=record,
                    failure_class="queue_full",
                )
                return CaptureTrajectoryResult(
                    queued=False,
                    duplicate=False,
                    subject_id=record.subjectId,
                    turn_id=record.turnId,
                    failure_class="queue_full",
                    detail=f"trajectory queue capacity {self._capacity} reached",
                )
            self._admitted_keys.add(key)
            self._admitted_count += 1
            self._idle.clear()

        self._queue.put_nowait(record)
        self._emit(outcome="recovered" if recovered else "queued", record=record)
        return CaptureTrajectoryResult(
            queued=True,
            duplicate=False,
            subject_id=record.subjectId,
            turn_id=record.turnId,
        )

    def _run(self) -> None:
        while not self._stop.is_set() or not self._queue.empty():
            try:
                record = self._queue.get(timeout=0.05)
            except queue.Empty:
                continue
            try:
                self._persist(record)
            except Exception as error:  # worker must never die silently
                self._emit(
                    outcome="rejected",
                    record=record,
                    failure_class=type(error).__name__[:64],
                )
                logger.exception(
                    "trajectory_capture outcome=rejected subject_id=%s device_id=%s",
                    record.subjectId,
                    record.deviceId,
                )
            finally:
                with self._lock:
                    self._admitted_keys.discard((record.subjectId, record.turnId))
                    self._admitted_count -= 1
                    if self._admitted_count == 0:
                        self._idle.set()
                self._slots.release()
                self._queue.task_done()

    def _persist(self, record: TurnTrajectoryV1) -> None:
        last_failure = "storage_failed"
        for attempt in range(self._max_retries + 1):
            consent_failure = self._consent_failure(record)
            if consent_failure is not None:
                self._emit(
                    outcome="rejected",
                    record=record,
                    failure_class=consent_failure,
                    retry_count=attempt,
                )
                return
            try:
                self._repository.put_write_ahead(record)
                consent_failure = self._consent_failure(record)
                if consent_failure is not None:
                    self._repository.discard(record.subjectId, record.turnId)
                    self._emit(
                        outcome="rejected",
                        record=record,
                        failure_class=consent_failure,
                        retry_count=attempt,
                    )
                    return
                self._repository.commit(record)
                self._emit(
                    outcome="persisted",
                    record=record,
                    retry_count=attempt,
                )
                return
            except Exception as error:
                last_failure = (
                    "storage_timeout" if isinstance(error, TimeoutError) else "storage_failed"
                )
                if attempt < self._max_retries:
                    self._emit(
                        outcome="retrying",
                        record=record,
                        failure_class=last_failure,
                        retry_count=attempt + 1,
                    )
        self._emit(
            outcome="rejected",
            record=record,
            failure_class=last_failure,
            retry_count=self._max_retries,
        )

    def _consent_failure(self, record: TurnTrajectoryV1) -> str | None:
        try:
            consent = self._resolve_consent(record.consentRecordId)
        except Exception:
            return "consent_resolve_failed"
        if consent is None or consent.consent_record_id != record.consentRecordId:
            return "consent_missing"
        if consent.subject_id != record.subjectId:
            return "cross_subject"
        if consent.scope != "trajectory":
            return "consent_scope_invalid"
        if not consent.active or not consent.opted_in:
            return "consent_denied"
        return None

    def _reject(
        self,
        failure_class: str,
        subject_id: str | None,
        record: TurnTrajectoryV1 | None,
        detail: str,
    ) -> CaptureTrajectoryResult:
        self._emit(
            outcome="rejected",
            subject_id=subject_id or self._subject_id,
            record=record,
            failure_class=failure_class,
        )
        return CaptureTrajectoryResult(
            queued=False,
            duplicate=False,
            subject_id=subject_id,
            turn_id=record.turnId if record is not None else None,
            failure_class=failure_class,
            detail=detail,
        )

    def _emit(
        self,
        *,
        outcome: str,
        subject_id: str | None = None,
        record: TurnTrajectoryV1 | None = None,
        failure_class: str | None = None,
        retry_count: int | None = None,
    ) -> None:
        event: dict[str, object] = {
            "event": "telemetry.trajectory.capture",
            "outcome": outcome,
            "subjectId": record.subjectId if record is not None else subject_id or self._subject_id,
            "queueDepth": self.queue_depth,
        }
        if record is not None:
            event["deviceId"] = record.deviceId
            event["turnId"] = record.turnId
        if failure_class is not None:
            event["failureClass"] = failure_class
        if retry_count is not None:
            event["retryCount"] = retry_count

        logger.info(
            "trajectory_capture outcome=%s subject_id=%s device_id=%s failure_class=%s",
            outcome,
            event["subjectId"],
            event.get("deviceId"),
            failure_class,
        )
        if self._on_event is not None:
            try:
                self._on_event(event)
            except Exception:
                logger.exception(
                    "trajectory_capture observer_outcome=failed subject_id=%s",
                    event["subjectId"],
                )
