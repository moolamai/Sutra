"""Python mirror of ``@moolam/runtime-harness`` StreamingTurnHost.

Emits A P6 HarnessFrame variants with a monotonic sequenceIndex allocator.
Used by ``POST /v1/agent/turn/stream`` — does not redefine frame shapes.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from . import PROTOCOL_VERSION
from .contract_models import (
    HarnessFrame,
    HarnessFrameVariant,
    MeterEvent,
    SyncAdvisory,
    ToolStatusState,
    parse_harness_frame,
)

logger = logging.getLogger("sutra.orchestrator.stream")

STREAMING_TURN_MAX_FRAMES = 256
STREAMING_TURN_PROTOCOL_VERSION = PROTOCOL_VERSION

# Shared with TS ``STREAMING_TURN_SSE_HEARTBEAT_SECONDS_DEFAULT``.
ENV_SSE_HEARTBEAT_SECONDS = "SUTRA_SSE_HEARTBEAT_SECONDS"
SSE_HEARTBEAT_SECONDS_DEFAULT = 15.0

StreamingTurnFailureClass = Literal[
    "missing_subject",
    "cross_subject",
    "schema_violation",
    "duplicate_sequence",
    "sequence_gap",
    "stream_already_terminated",
    "stream_budget_exceeded",
    "missing_terminal",
    "idempotency_conflict",
]


@dataclass(frozen=True)
class StreamingTurnEmitOk:
    frame: HarnessFrameVariant
    subject_id: str
    device_id: str | None = None
    ok: Literal[True] = True


@dataclass(frozen=True)
class StreamingTurnEmitRejected:
    failure_class: StreamingTurnFailureClass
    issue_path: str
    detail: str
    subject_id: str | None = None
    device_id: str | None = None
    ok: Literal[False] = False


StreamingTurnEmitResult = StreamingTurnEmitOk | StreamingTurnEmitRejected


def sse_heartbeat_seconds() -> float:
    """Configurable heartbeat interval (seconds). ``<= 0`` disables timed heartbeats."""
    raw = os.environ.get(ENV_SSE_HEARTBEAT_SECONDS)
    if raw is None or not str(raw).strip():
        return SSE_HEARTBEAT_SECONDS_DEFAULT
    try:
        return float(raw)
    except ValueError:
        return SSE_HEARTBEAT_SECONDS_DEFAULT


def format_sse_frame(frame: HarnessFrameVariant) -> str:
    """Encode one harness frame as an SSE event (id = sequenceIndex)."""
    payload = HarnessFrame(frame).model_dump_json(exclude_none=True)
    return (
        f"id: {frame.sequenceIndex}\n"
        f"event: harness.frame\n"
        f"data: {payload}\n\n"
    )


def format_sse_heartbeat() -> str:
    """SSE comment keepalive — proxies treat comments as heartbeats."""
    return ":heartbeat\n\n"


class StreamingTurnHost:
    """Subject-scoped frame emitter (Python mirror of the TS host)."""

    def __init__(
        self,
        *,
        subject_id: str,
        correlation_id: str,
        device_id: str | None = None,
        protocol_version: str = STREAMING_TURN_PROTOCOL_VERSION,
        on_frame: Callable[[HarnessFrameVariant], None] | None = None,
        on_telemetry: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        sid = subject_id.strip() if isinstance(subject_id, str) else ""
        cid = correlation_id.strip() if isinstance(correlation_id, str) else ""
        if not sid:
            raise ValueError("StreamingTurnHost requires non-empty subject_id")
        if not cid:
            raise ValueError("StreamingTurnHost requires non-empty correlation_id")
        self.subject_id = sid
        self.correlation_id = cid
        self.device_id = device_id
        self.protocol_version = protocol_version
        self._frames: list[HarnessFrameVariant] = []
        self._next_sequence = 0
        self._terminated = False
        self._on_frame = on_frame
        self._on_telemetry = on_telemetry

    @property
    def is_terminated(self) -> bool:
        return self._terminated

    @property
    def sequence_length(self) -> int:
        return len(self._frames)

    def peek_next_sequence_index(self) -> int:
        return self._next_sequence

    def get_frames(self) -> list[HarnessFrameVariant]:
        return list(self._frames)

    def emit_session_start(
        self, pinned_at: str | None = None
    ) -> StreamingTurnEmitResult:
        pinned = pinned_at or datetime.now(timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
        return self._emit(
            {
                "type": "SESSION_START",
                "protocolVersion": self.protocol_version,
                "pinnedAt": pinned,
            }
        )

    def emit_thought_delta(self, delta: str) -> StreamingTurnEmitResult:
        return self._emit({"type": "THOUGHT_DELTA", "delta": delta})

    def emit_answer_delta(self, delta: str) -> StreamingTurnEmitResult:
        return self._emit({"type": "ANSWER_DELTA", "delta": delta})

    def emit_tool_status(
        self,
        *,
        tool_call_id: str,
        status: ToolStatusState,
        detail: str | None = None,
    ) -> StreamingTurnEmitResult:
        body: dict[str, Any] = {
            "type": "TOOL_STATUS",
            "toolCallId": tool_call_id,
            "status": status,
        }
        if detail is not None:
            body["detail"] = detail
        return self._emit(body)

    def emit_advisory_attach(self, advisory: SyncAdvisory) -> StreamingTurnEmitResult:
        return self._emit(
            {
                "type": "ADVISORY_ATTACH",
                "advisory": advisory.model_dump(mode="json"),
            }
        )

    def emit_meter_tick(self, tick: MeterEvent) -> StreamingTurnEmitResult:
        return self._emit(
            {"type": "METER_TICK", "tick": tick.model_dump(mode="json")}
        )

    def emit_turn_complete(self, turn_id: str) -> StreamingTurnEmitResult:
        return self._emit({"type": "TURN_COMPLETE", "turnId": turn_id})

    def emit_harness_error(
        self,
        *,
        code: str,
        message: str,
        recoverable: bool,
    ) -> StreamingTurnEmitResult:
        return self._emit(
            {
                "type": "HARNESS_ERROR",
                "code": code,
                "message": message,
                "recoverable": recoverable,
            }
        )

    def terminate_with_error(
        self,
        *,
        code: str,
        message: str,
        recoverable: bool,
    ) -> StreamingTurnEmitResult:
        if self._terminated:
            rejected = StreamingTurnEmitRejected(
                failure_class="stream_already_terminated",
                issue_path="stream",
                detail="stream already closed; cannot emit HARNESS_ERROR",
                subject_id=self.subject_id,
                device_id=self.device_id,
            )
            self._telemetry(rejected, frame_type="HARNESS_ERROR")
            return rejected
        return self.emit_harness_error(
            code=code, message=message, recoverable=recoverable
        )

    def _emit(self, body: dict[str, Any]) -> StreamingTurnEmitResult:
        if self._terminated:
            rejected = StreamingTurnEmitRejected(
                failure_class="stream_already_terminated",
                issue_path="stream",
                detail="cannot append after TURN_COMPLETE or HARNESS_ERROR",
                subject_id=self.subject_id,
                device_id=self.device_id,
            )
            self._telemetry(rejected)
            return rejected
        if len(self._frames) >= STREAMING_TURN_MAX_FRAMES:
            rejected = StreamingTurnEmitRejected(
                failure_class="stream_budget_exceeded",
                issue_path="frames",
                detail=f"frame budget {STREAMING_TURN_MAX_FRAMES} exceeded",
                subject_id=self.subject_id,
                device_id=self.device_id,
            )
            self._telemetry(rejected)
            return rejected

        candidate = {
            **body,
            "sequenceIndex": self._next_sequence,
            "correlationId": self.correlation_id,
            "subjectId": self.subject_id,
        }
        parsed = parse_harness_frame(candidate, device_id=self.device_id)
        if parsed["outcome"] != "accepted":
            failure = parsed.get("failureClass", "schema_violation")
            mapped: StreamingTurnFailureClass
            if failure == "missing_subject":
                mapped = "missing_subject"
            else:
                mapped = "schema_violation"
            rejected = StreamingTurnEmitRejected(
                failure_class=mapped,
                issue_path=str(parsed.get("issuePath", "(root)")),
                detail=f"A P6 harness frame rejected: {failure}",
                subject_id=parsed.get("subjectId"),
                device_id=self.device_id,
            )
            self._telemetry(rejected, frame_type=body.get("type"))
            return rejected

        frame: HarnessFrameVariant = parsed["frame"]
        if frame.subjectId != self.subject_id:
            rejected = StreamingTurnEmitRejected(
                failure_class="cross_subject",
                issue_path="subjectId",
                detail="frame subjectId does not match stream scope",
                subject_id=self.subject_id,
                device_id=self.device_id,
            )
            self._telemetry(rejected, frame_type=frame.type)
            return rejected
        if frame.sequenceIndex != self._next_sequence:
            rejected = StreamingTurnEmitRejected(
                failure_class=(
                    "duplicate_sequence"
                    if frame.sequenceIndex < self._next_sequence
                    else "sequence_gap"
                ),
                issue_path="sequenceIndex",
                detail=(
                    f"expected sequenceIndex {self._next_sequence}, "
                    f"got {frame.sequenceIndex}"
                ),
                subject_id=self.subject_id,
                device_id=self.device_id,
            )
            self._telemetry(
                rejected, frame_type=frame.type, sequence_index=frame.sequenceIndex
            )
            return rejected

        self._frames.append(frame)
        self._next_sequence += 1
        if frame.type in ("TURN_COMPLETE", "HARNESS_ERROR"):
            self._terminated = True
        if self._on_frame is not None:
            self._on_frame(frame)
        ok = StreamingTurnEmitOk(
            frame=frame, subject_id=self.subject_id, device_id=self.device_id
        )
        self._telemetry(ok, frame_type=frame.type, sequence_index=frame.sequenceIndex)
        return ok

    def _telemetry(
        self,
        result: StreamingTurnEmitResult,
        *,
        frame_type: str | None = None,
        sequence_index: int | None = None,
    ) -> None:
        if self._on_telemetry is None:
            return
        event: dict[str, Any] = {
            "event": "runtime.harness.emit",
            "outcome": "ok" if result.ok else "rejected",
            "subjectId": result.subject_id,
            "correlationId": self.correlation_id,
        }
        if self.device_id is not None:
            event["deviceId"] = self.device_id
        if frame_type is not None:
            event["frameType"] = frame_type
        if sequence_index is not None:
            event["sequenceIndex"] = sequence_index
        if not result.ok:
            event["failureClass"] = result.failure_class
        self._on_telemetry(event)


# ── In-flight idempotency (double POST for same key) ─────────────────────────

_inflight_lock = threading.Lock()
_inflight: dict[str, float] = {}


def stream_idempotency_key(
    *,
    subject_id: str,
    session_id: str,
    idempotency_key: str | None,
) -> str:
    token = (idempotency_key or "").strip() or session_id
    return f"{subject_id}:{token}"


def try_begin_stream(key: str) -> bool:
    """Return False if a stream with ``key`` is already in flight."""
    with _inflight_lock:
        if key in _inflight:
            return False
        _inflight[key] = time.monotonic()
        return True


def end_stream(key: str) -> None:
    with _inflight_lock:
        _inflight.pop(key, None)


def clear_inflight_for_tests() -> None:
    with _inflight_lock:
        _inflight.clear()


def new_turn_id(session_id: str) -> str:
    return f"turn-{session_id}-{uuid.uuid4().hex[:8]}"


def iter_reference_turn_frames(
    host: StreamingTurnHost,
    *,
    reply: str,
    turn_id: str,
) -> Iterator[HarnessFrameVariant]:
    """Emit the reference stream: SESSION_START → ANSWER_DELTA → TURN_COMPLETE."""
    r = host.emit_session_start()
    if not r.ok:
        raise RuntimeError(r.detail)
    yield r.frame

    r = host.emit_answer_delta(reply)
    if not r.ok:
        raise RuntimeError(r.detail)
    yield r.frame

    r = host.emit_turn_complete(turn_id)
    if not r.ok:
        raise RuntimeError(r.detail)
    yield r.frame


__all__ = [
    "ENV_SSE_HEARTBEAT_SECONDS",
    "SSE_HEARTBEAT_SECONDS_DEFAULT",
    "STREAMING_TURN_MAX_FRAMES",
    "STREAMING_TURN_PROTOCOL_VERSION",
    "StreamingTurnHost",
    "StreamingTurnEmitOk",
    "StreamingTurnEmitRejected",
    "StreamingTurnEmitResult",
    "clear_inflight_for_tests",
    "end_stream",
    "format_sse_frame",
    "format_sse_heartbeat",
    "iter_reference_turn_frames",
    "new_turn_id",
    "sse_heartbeat_seconds",
    "stream_idempotency_key",
    "try_begin_stream",
]
