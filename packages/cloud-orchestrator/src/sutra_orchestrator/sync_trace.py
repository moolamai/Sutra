"""W3C Trace Context extract for sync wire headers .

Parses ``SyncRequest.headers.traceparent`` before CRDT merge so cloud-side
logging / future OTel middleware continue the edge attempt span. Never raises
on malformed input — absent or invalid headers yield no context.
"""

from __future__ import annotations

import logging
import re
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Iterator

from .contract_models import SyncRequest, SyncWireHeaders

logger = logging.getLogger(__name__)

_TRACEPARENT_RE = re.compile(
    r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$",
    re.IGNORECASE,
)

__all__ = [
    "SyncTraceContext",
    "continue_sync_trace",
    "current_sync_trace",
    "extract_sync_trace",
]


@dataclass(frozen=True, slots=True)
class SyncTraceContext:
    """Metadata-only remote trace link extracted from the sync envelope."""

    version: str
    trace_id: str
    parent_span_id: str
    flags: str
    tracestate: str | None = None


_current: ContextVar[SyncTraceContext | None] = ContextVar(
    "sutra_sync_trace", default=None
)


def current_sync_trace() -> SyncTraceContext | None:
    return _current.get()


def extract_sync_trace(
    headers: SyncWireHeaders | dict[str, str] | None,
) -> SyncTraceContext | None:
    """Parse W3C traceparent from SyncRequest.headers. Soft-fail on garbage."""
    if headers is None:
        return None
    if isinstance(headers, SyncWireHeaders):
        raw_parent = headers.traceparent
        raw_state = headers.tracestate
    else:
        raw_parent = headers.get("traceparent") or headers.get("TRACEPARENT")
        raw_state = headers.get("tracestate") or headers.get("TRACESTATE")
    if not raw_parent or not isinstance(raw_parent, str):
        return None
    match = _TRACEPARENT_RE.match(raw_parent.strip())
    if not match:
        logger.info(
            "sync.trace.extract_skipped reason=malformed_traceparent subject_scope=headers_only"
        )
        return None
    version, trace_id, parent_span_id, flags = match.groups()
    tracestate = None
    if isinstance(raw_state, str) and raw_state.strip():
        tracestate = raw_state.strip()[:512]
    return SyncTraceContext(
        version=version.lower(),
        trace_id=trace_id.lower(),
        parent_span_id=parent_span_id.lower(),
        flags=flags.lower(),
        tracestate=tracestate,
    )


@contextmanager
def continue_sync_trace(request: SyncRequest) -> Iterator[SyncTraceContext | None]:
    """Bind extracted remote context for the duration of CRDT merge."""
    ctx = extract_sync_trace(request.headers)
    if ctx is None:
        yield None
        return
    token = _current.set(ctx)
    logger.info(
        "sync.trace.continue subject_id=%s device_id=%s sync_attempt_id=%s "
        "trace_id=%s parent_span_id=%s outcome=linked",
        request.edgeState.subjectId,
        request.deviceId,
        request.syncAttemptId,
        ctx.trace_id,
        ctx.parent_span_id,
    )
    try:
        yield ctx
    finally:
        _current.reset(token)
