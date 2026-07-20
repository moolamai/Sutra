"""Python mirror of ``@moolam/runtime-harness`` AbortPipeline (CK-07).

Process-local registry: turnId → abort signal + effect journal + locks.
Used by FastAPI ``POST /v1/agent/turn/{id}/abort`` and the SSE turn stream.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Literal, Protocol, runtime_checkable

logger = logging.getLogger("sutra.orchestrator.abort")

ABORT_REGISTRY_LIMIT = 256
ABORT_JOURNAL_LIMIT = 64
ABORT_LOCK_LIMIT = 512
ABORT_AUDIT_RECORD_LIMIT = 256
ABORT_REASON_MANUAL = "AGENT_MANUAL_ABORT"
AGENT_MANUAL_ABORT_AUDIT_EVENT = "AGENT_MANUAL_ABORT"

TurnAbortStatus = Literal["active", "aborted", "completed"]
EffectJournalStatus = Literal[
    "pending", "mid_write", "committed", "abandoned", "rolled_back"
]
AbortAction = Literal["aborted", "already_aborted", "already_completed"]
AbortFailureClass = Literal[
    "missing_subject",
    "cross_subject",
    "not_found",
    "duplicate_turn",
    "registry_full",
    "invalid_turn",
    "journal_full",
    "invalid_effect",
    "lock_held",
    "lock_table_full",
]

CompensateFn = Callable[["EffectJournalEntry", dict[str, str]], None]


@dataclass
class EffectJournalEntry:
    effect_id: str
    status: EffectJournalStatus
    recorded_at: float
    tool_name: str | None = None
    idempotency_key: str | None = None
    risk_class: Literal["read", "write", "critical"] | None = None


@dataclass
class EffectJournal:
    _entries: list[EffectJournalEntry] = field(default_factory=list)
    _by_id: dict[str, EffectJournalEntry] = field(default_factory=dict)
    _compensators: dict[str, CompensateFn] = field(default_factory=dict)

    @property
    def size(self) -> int:
        return len(self._entries)

    def list(self) -> list[EffectJournalEntry]:
        return list(self._entries)

    def list_rollback_candidates(self) -> list[EffectJournalEntry]:
        return [
            e
            for e in self._entries
            if e.status in ("pending", "mid_write")
        ]

    def append(
        self,
        *,
        effect_id: str,
        tool_name: str | None = None,
        idempotency_key: str | None = None,
        risk_class: Literal["read", "write", "critical"] | None = None,
        mid_write: bool = False,
        compensate: CompensateFn | None = None,
    ) -> tuple[bool, EffectJournalEntry | None, AbortFailureClass | None, str]:
        eid = (effect_id or "").strip()
        if not eid:
            return False, None, "invalid_effect", "effectId required"
        if eid in self._by_id:
            return False, None, "invalid_effect", "duplicate effectId"
        if len(self._entries) >= ABORT_JOURNAL_LIMIT:
            return False, None, "journal_full", f"journal limit {ABORT_JOURNAL_LIMIT}"
        entry = EffectJournalEntry(
            effect_id=eid,
            status="mid_write" if mid_write else "pending",
            recorded_at=time.time(),
            tool_name=tool_name[:64] if tool_name else None,
            idempotency_key=idempotency_key[:128] if idempotency_key else None,
            risk_class=risk_class,
        )
        self._entries.append(entry)
        self._by_id[eid] = entry
        if compensate is not None:
            self._compensators[eid] = compensate
        return True, entry, None, ""

    def mark_committed(self, effect_id: str) -> bool:
        entry = self._by_id.get((effect_id or "").strip())
        if entry is None or entry.status not in ("pending", "mid_write"):
            return False
        entry.status = "committed"
        self._compensators.pop(entry.effect_id, None)
        return True

    def mark_mid_write(self, effect_id: str) -> bool:
        entry = self._by_id.get((effect_id or "").strip())
        if entry is None or entry.status != "pending":
            return False
        entry.status = "mid_write"
        return True


class IdempotencyLockTable:
    def __init__(self, max_locks: int = ABORT_LOCK_LIMIT) -> None:
        if not isinstance(max_locks, int) or max_locks < 1 or max_locks > 8192:
            raise ValueError("max_locks must be an integer in 1..8192")
        self._max = max_locks
        self._locks: dict[str, tuple[str, str]] = {}
        self._lock = threading.Lock()

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._locks)

    def is_held(self, key: str) -> bool:
        k = (key or "").strip()
        with self._lock:
            return bool(k) and k in self._locks

    def acquire(
        self, key: str, *, subject_id: str, turn_id: str
    ) -> tuple[bool, AbortFailureClass | None, str]:
        k = (key or "").strip()
        sid = (subject_id or "").strip()
        tid = (turn_id or "").strip()
        if not k or not sid or not tid:
            return False, "invalid_effect", "lock key and scope required"
        with self._lock:
            held = self._locks.get(k)
            if held is not None:
                if held == (sid, tid):
                    return True, None, ""
                return False, "lock_held", "idempotency key held by another turn"
            if len(self._locks) >= self._max:
                return False, "lock_table_full", f"lock table limit {self._max}"
            self._locks[k] = (sid, tid)
            return True, None, ""

    def release(self, key: str, *, subject_id: str, turn_id: str) -> bool:
        k = (key or "").strip()
        sid = (subject_id or "").strip()
        tid = (turn_id or "").strip()
        with self._lock:
            held = self._locks.get(k)
            if held != (sid, tid):
                return False
            del self._locks[k]
            return True

    def release_all_for_turn(self, turn_id: str, subject_id: str) -> list[str]:
        tid = (turn_id or "").strip()
        sid = (subject_id or "").strip()
        released: list[str] = []
        with self._lock:
            for key, (hs, ht) in list(self._locks.items()):
                if ht == tid and hs == sid:
                    del self._locks[key]
                    released.append(key)
        return released

    def clear(self) -> None:
        with self._lock:
            self._locks.clear()


@dataclass(frozen=True)
class AgentManualAbortAuditRecord:
    """AGENT_MANUAL_ABORT audit row — metadata only (no learner content)."""

    event: str
    subject_id: str
    turn_id: str
    reason: str
    rolled_back_count: int
    abandoned_count: int
    locks_released: int
    recorded_at: str
    device_id: str | None = None
    principal_id: str | None = None


@runtime_checkable
class AbortAuditSink(Protocol):
    def record_manual_abort(self, record: AgentManualAbortAuditRecord) -> None: ...


class InMemoryAbortAuditSink:
    """Deterministic in-process audit sink (idempotent per subjectId+turnId)."""

    def __init__(self, max_records: int = ABORT_AUDIT_RECORD_LIMIT) -> None:
        self._max = max_records
        self._records: list[AgentManualAbortAuditRecord] = []
        self._seen: set[str] = set()
        self._lock = threading.Lock()

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._records)

    def list(self) -> list[AgentManualAbortAuditRecord]:
        with self._lock:
            return list(self._records)

    def clear(self) -> None:
        with self._lock:
            self._records.clear()
            self._seen.clear()

    def record_manual_abort(self, record: AgentManualAbortAuditRecord) -> None:
        sid = (record.subject_id or "").strip()
        tid = (record.turn_id or "").strip()
        if not sid or not tid:
            return
        if record.event != AGENT_MANUAL_ABORT_AUDIT_EVENT:
            return
        key = f"{sid}\0{tid}"
        with self._lock:
            if key in self._seen:
                return
            if len(self._records) >= self._max:
                oldest = self._records.pop(0)
                self._seen.discard(f"{oldest.subject_id}\0{oldest.turn_id}")
            stored = AgentManualAbortAuditRecord(
                event=AGENT_MANUAL_ABORT_AUDIT_EVENT,
                subject_id=sid,
                turn_id=tid,
                reason=(record.reason or ABORT_REASON_MANUAL)[:64],
                rolled_back_count=record.rolled_back_count,
                abandoned_count=record.abandoned_count,
                locks_released=record.locks_released,
                recorded_at=record.recorded_at,
                device_id=(record.device_id[:64] if record.device_id else None),
                principal_id=(
                    record.principal_id[:128] if record.principal_id else None
                ),
            )
            self._seen.add(key)
            self._records.append(stored)


@dataclass
class _TurnRecord:
    turn_id: str
    subject_id: str
    device_id: str | None
    journal: EffectJournal
    status: TurnAbortStatus = "active"
    effects_committed: bool = False
    abort_event: threading.Event = field(default_factory=threading.Event)
    rollback_done: bool = False
    locks_released_done: bool = False
    audit_done: bool = False
    abort_count: int = 0


@dataclass(frozen=True)
class TurnAbortHandle:
    turn_id: str
    subject_id: str
    device_id: str | None
    journal: EffectJournal
    _record: _TurnRecord
    _pipeline: AbortPipeline

    @property
    def status(self) -> TurnAbortStatus:
        return self._record.status

    @property
    def aborted(self) -> bool:
        return self._record.status == "aborted" or self._record.abort_event.is_set()

    @property
    def abort_event(self) -> threading.Event:
        return self._record.abort_event

    def append_effect(
        self,
        *,
        effect_id: str,
        tool_name: str | None = None,
        idempotency_key: str | None = None,
        risk_class: Literal["read", "write", "critical"] | None = None,
        mid_write: bool = False,
        compensate: CompensateFn | None = None,
    ) -> tuple[bool, AbortFailureClass | None, str]:
        if self._record.status != "active":
            return False, "invalid_turn", f"cannot journal on {self._record.status} turn"
        if idempotency_key and idempotency_key.strip():
            ok, fc, detail = self._pipeline.locks.acquire(
                idempotency_key,
                subject_id=self.subject_id,
                turn_id=self.turn_id,
            )
            if not ok:
                return False, fc, detail
        ok, _entry, fc, detail = self.journal.append(
            effect_id=effect_id,
            tool_name=tool_name,
            idempotency_key=idempotency_key,
            risk_class=risk_class,
            mid_write=mid_write,
            compensate=compensate,
        )
        if not ok:
            if idempotency_key and idempotency_key.strip():
                self._pipeline.locks.release(
                    idempotency_key,
                    subject_id=self.subject_id,
                    turn_id=self.turn_id,
                )
            return False, fc, detail
        return True, None, ""

    def mark_effect_committed(self, effect_id: str) -> bool:
        return self.journal.mark_committed(effect_id)

    def mark_effect_mid_write(self, effect_id: str) -> bool:
        return self.journal.mark_mid_write(effect_id)


@dataclass(frozen=True)
class AbortTurnAccepted:
    ok: Literal[True] = True
    action: AbortAction = "aborted"
    turn_id: str = ""
    subject_id: str = ""
    signal_cascaded: bool = False
    cascade_latency_ms: float = 0.0
    uncommitted_count: int = 0
    rolled_back_count: int = 0
    abandoned_count: int = 0
    locks_released: int = 0
    compensate_failures: int = 0
    audit_recorded: bool = False
    status: TurnAbortStatus = "aborted"


@dataclass(frozen=True)
class AbortTurnRejected:
    ok: Literal[False] = False
    failure_class: AbortFailureClass = "not_found"
    detail: str = ""
    subject_id: str | None = None
    turn_id: str | None = None


AbortTurnResult = AbortTurnAccepted | AbortTurnRejected


class AbortPipeline:
    """Process-local turn abort registry (subject-scoped)."""

    def __init__(
        self,
        *,
        max_active_turns: int = ABORT_REGISTRY_LIMIT,
        lock_table: IdempotencyLockTable | None = None,
        audit_sink: AbortAuditSink | None = None,
    ) -> None:
        if not isinstance(max_active_turns, int) or max_active_turns < 1:
            raise ValueError("max_active_turns must be a positive integer")
        self._max = max_active_turns
        self.locks = lock_table or IdempotencyLockTable()
        self._audit_sink = audit_sink
        self._turns: dict[str, _TurnRecord] = {}
        self._lock = threading.Lock()

    def set_audit_sink(self, sink: AbortAuditSink | None) -> None:
        self._audit_sink = sink

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._turns)

    @property
    def active_count(self) -> int:
        with self._lock:
            return sum(1 for t in self._turns.values() if t.status == "active")

    def register_turn(
        self,
        *,
        turn_id: str,
        subject_id: str,
        device_id: str | None = None,
    ) -> tuple[bool, TurnAbortHandle | None, AbortFailureClass | None, str]:
        sid = (subject_id or "").strip()
        tid = (turn_id or "").strip()
        if not sid:
            return False, None, "missing_subject", "subjectId required"
        if not tid:
            return False, None, "invalid_turn", "turnId required"
        with self._lock:
            existing = self._turns.get(tid)
            if existing is not None:
                if existing.subject_id != sid:
                    return False, None, "cross_subject", "turnId owned by another subject"
                return False, None, "duplicate_turn", "turnId already registered"
            active = sum(1 for t in self._turns.values() if t.status == "active")
            if active >= self._max:
                return False, None, "registry_full", f"active turn limit {self._max}"
            record = _TurnRecord(
                turn_id=tid,
                subject_id=sid,
                device_id=(device_id.strip() if device_id and device_id.strip() else None),
                journal=EffectJournal(),
            )
            self._turns[tid] = record
        handle = TurnAbortHandle(
            turn_id=tid,
            subject_id=sid,
            device_id=record.device_id,
            journal=record.journal,
            _record=record,
            _pipeline=self,
        )
        logger.info(
            "abort_pipeline outcome=ok action=registered subject_id=%s "
            "device_id=%s turn_id=%s",
            sid,
            record.device_id or "-",
            tid,
        )
        return True, handle, None, ""

    def abort(
        self,
        turn_id: str,
        *,
        subject_id: str,
        reason: str | None = None,
        principal_id: str | None = None,
    ) -> AbortTurnResult:
        started = time.perf_counter()
        sid = (subject_id or "").strip()
        tid = (turn_id or "").strip()
        if not sid:
            return AbortTurnRejected(
                failure_class="missing_subject",
                detail="subjectId required",
                subject_id=None,
                turn_id=None,
            )
        if not tid:
            return AbortTurnRejected(
                failure_class="invalid_turn",
                detail="turnId required",
                subject_id=sid,
                turn_id=None,
            )

        with self._lock:
            record = self._turns.get(tid)

        if record is None:
            logger.info(
                "abort_pipeline outcome=rejected failure_class=not_found "
                "subject_id=%s turn_id=%s",
                sid,
                tid,
            )
            return AbortTurnRejected(
                failure_class="not_found",
                detail="no in-flight turn for turnId",
                subject_id=sid,
                turn_id=tid,
            )
        if record.subject_id != sid:
            logger.info(
                "abort_pipeline outcome=rejected failure_class=cross_subject "
                "subject_id=%s turn_id=%s",
                sid,
                tid,
            )
            return AbortTurnRejected(
                failure_class="cross_subject",
                detail="turn subjectId does not match",
                subject_id=sid,
                turn_id=tid,
            )

        if record.status == "completed" and record.effects_committed:
            latency = max(0.0, (time.perf_counter() - started) * 1000.0)
            logger.info(
                "abort_pipeline outcome=ok action=already_completed "
                "subject_id=%s device_id=%s turn_id=%s cascade_latency_ms=%.3f",
                sid,
                record.device_id or "-",
                tid,
                latency,
            )
            return AbortTurnAccepted(
                action="already_completed",
                turn_id=tid,
                subject_id=sid,
                signal_cascaded=False,
                cascade_latency_ms=latency,
                status="completed",
            )

        if record.status == "aborted":
            latency = max(0.0, (time.perf_counter() - started) * 1000.0)
            logger.info(
                "abort_pipeline outcome=ok action=already_aborted "
                "subject_id=%s device_id=%s turn_id=%s",
                sid,
                record.device_id or "-",
                tid,
            )
            return AbortTurnAccepted(
                action="already_aborted",
                turn_id=tid,
                subject_id=sid,
                signal_cascaded=False,
                cascade_latency_ms=latency,
                status="aborted",
            )

        rolled_back = 0
        abandoned = 0
        compensate_failures = 0
        locks_released = 0
        try:
            record.abort_count += 1
            record.abort_event.set()
            if not record.rollback_done:
                rb, ab, fails = self._rollback_journal(record)
                rolled_back, abandoned, compensate_failures = rb, ab, fails
                record.rollback_done = True
                logger.info(
                    "abort_pipeline outcome=ok action=rollback subject_id=%s "
                    "turn_id=%s rolled_back=%s abandoned=%s compensate_failures=%s",
                    sid,
                    tid,
                    rolled_back,
                    abandoned,
                    compensate_failures,
                )
            record.status = "aborted"
            record.effects_committed = False
        finally:
            if not record.locks_released_done:
                keys = self.locks.release_all_for_turn(tid, sid)
                locks_released = len(keys)
                record.locks_released_done = True
                logger.info(
                    "abort_pipeline outcome=ok action=locks_released "
                    "subject_id=%s turn_id=%s locks_released=%s",
                    sid,
                    tid,
                    locks_released,
                )

        latency = max(0.0, (time.perf_counter() - started) * 1000.0)
        abort_reason = (reason or ABORT_REASON_MANUAL)[:64]
        audit_recorded = False
        if not record.audit_done and self._audit_sink is not None:
            self._audit_sink.record_manual_abort(
                AgentManualAbortAuditRecord(
                    event=AGENT_MANUAL_ABORT_AUDIT_EVENT,
                    subject_id=sid,
                    turn_id=tid,
                    reason=abort_reason,
                    rolled_back_count=rolled_back,
                    abandoned_count=abandoned,
                    locks_released=locks_released,
                    recorded_at=datetime.now(timezone.utc).isoformat(),
                    device_id=record.device_id,
                    principal_id=(
                        principal_id.strip()[:128]
                        if isinstance(principal_id, str) and principal_id.strip()
                        else None
                    ),
                )
            )
            record.audit_done = True
            audit_recorded = True
            logger.info(
                "abort_pipeline outcome=ok action=audit_recorded event=%s "
                "subject_id=%s device_id=%s turn_id=%s reason=%s",
                AGENT_MANUAL_ABORT_AUDIT_EVENT,
                sid,
                record.device_id or "-",
                tid,
                abort_reason,
            )
        logger.info(
            "abort_pipeline outcome=ok action=aborted subject_id=%s device_id=%s "
            "turn_id=%s cascade_latency_ms=%.3f rolled_back=%s abandoned=%s "
            "locks_released=%s reason=%s audit_recorded=%s",
            sid,
            record.device_id or "-",
            tid,
            latency,
            rolled_back,
            abandoned,
            locks_released,
            abort_reason,
            audit_recorded,
        )
        return AbortTurnAccepted(
            action="aborted",
            turn_id=tid,
            subject_id=sid,
            signal_cascaded=True,
            cascade_latency_ms=latency,
            uncommitted_count=rolled_back + abandoned,
            rolled_back_count=rolled_back,
            abandoned_count=abandoned,
            locks_released=locks_released,
            compensate_failures=compensate_failures,
            audit_recorded=audit_recorded,
            status="aborted",
        )

    def _rollback_journal(self, record: _TurnRecord) -> tuple[int, int, int]:
        rolled_back = 0
        abandoned = 0
        failures = 0
        for entry in record.journal.list_rollback_candidates():
            compensate = record.journal._compensators.get(entry.effect_id)  # noqa: SLF001
            needs = entry.status == "mid_write" or (
                entry.status == "pending" and compensate is not None
            )
            if needs and compensate is not None:
                try:
                    compensate(
                        entry,
                        {"subjectId": record.subject_id, "turnId": record.turn_id},
                    )
                    entry.status = "rolled_back"
                    record.journal._compensators.pop(entry.effect_id, None)  # noqa: SLF001
                    rolled_back += 1
                except Exception:
                    entry.status = "abandoned"
                    record.journal._compensators.pop(entry.effect_id, None)  # noqa: SLF001
                    abandoned += 1
                    failures += 1
            else:
                entry.status = "abandoned"
                abandoned += 1
        return rolled_back, abandoned, failures

    def mark_turn_completed(
        self,
        turn_id: str,
        *,
        subject_id: str,
        effects_committed: bool,
    ) -> tuple[bool, AbortFailureClass | None, str]:
        sid = (subject_id or "").strip()
        tid = (turn_id or "").strip()
        if not sid:
            return False, "missing_subject", "subjectId required"
        if not tid:
            return False, "invalid_turn", "turnId required"
        with self._lock:
            record = self._turns.get(tid)
        if record is None:
            return False, "not_found", "no turn for turnId"
        if record.subject_id != sid:
            return False, "cross_subject", "turn subjectId does not match"
        if record.status == "aborted":
            return False, "invalid_turn", "turn already aborted"
        record.status = "completed"
        record.effects_committed = bool(effects_committed)
        if not record.locks_released_done:
            self.locks.release_all_for_turn(tid, sid)
            record.locks_released_done = True
        logger.info(
            "abort_pipeline outcome=ok action=completed subject_id=%s "
            "device_id=%s turn_id=%s effects_committed=%s",
            sid,
            record.device_id or "-",
            tid,
            record.effects_committed,
        )
        return True, None, ""

    def get_handle(
        self, turn_id: str, subject_id: str
    ) -> TurnAbortHandle | None:
        sid = (subject_id or "").strip()
        tid = (turn_id or "").strip()
        with self._lock:
            record = self._turns.get(tid)
        if record is None or record.subject_id != sid:
            return None
        return TurnAbortHandle(
            turn_id=tid,
            subject_id=sid,
            device_id=record.device_id,
            journal=record.journal,
            _record=record,
            _pipeline=self,
        )

    def clear(self) -> None:
        with self._lock:
            self._turns.clear()
        self.locks.clear()


# ── Process singleton (mirrors stream inflight table) ─────────────────────────

_pipeline = AbortPipeline()
_audit_sink: InMemoryAbortAuditSink = InMemoryAbortAuditSink()
_pipeline.set_audit_sink(_audit_sink)
_pipeline_lock = threading.Lock()


def get_abort_pipeline() -> AbortPipeline:
    return _pipeline


def get_abort_audit_sink() -> InMemoryAbortAuditSink:
    return _audit_sink


def configure_abort_audit_sink(sink: AbortAuditSink | None) -> None:
    """Replace the process abort audit sink (tests / deploy injection)."""
    with _pipeline_lock:
        _pipeline.set_audit_sink(sink)


def clear_abort_registry_for_tests() -> None:
    """Reset process registry between tests (same pattern as clear_inflight)."""
    with _pipeline_lock:
        _pipeline.clear()
        _audit_sink.clear()
        _pipeline.set_audit_sink(_audit_sink)


class InProcessFakeDurableEffects:
    """Deterministic durable sink for race / rollback tests."""

    def __init__(self) -> None:
        self._applied: dict[str, Any] = {}
        self._lock = threading.Lock()

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._applied)

    def apply(self, effect_id: str, value: Any = True) -> None:
        eid = (effect_id or "").strip()
        if not eid:
            return
        with self._lock:
            self._applied[eid] = value

    def has(self, effect_id: str) -> bool:
        with self._lock:
            return (effect_id or "").strip() in self._applied

    def compensate(self, effect_id: str) -> bool:
        with self._lock:
            return self._applied.pop((effect_id or "").strip(), None) is not None


__all__ = [
    "ABORT_REASON_MANUAL",
    "ABORT_REGISTRY_LIMIT",
    "AGENT_MANUAL_ABORT_AUDIT_EVENT",
    "AbortAuditSink",
    "AbortPipeline",
    "AbortTurnAccepted",
    "AbortTurnRejected",
    "AbortTurnResult",
    "AgentManualAbortAuditRecord",
    "InMemoryAbortAuditSink",
    "InProcessFakeDurableEffects",
    "TurnAbortHandle",
    "clear_abort_registry_for_tests",
    "configure_abort_audit_sink",
    "get_abort_audit_sink",
    "get_abort_pipeline",
]
