"""In-memory subject-scoped sync store — idempotent by syncAttemptId."""

from __future__ import annotations

from threading import Lock

from .wire_models import CognitiveState, SyncRequest, SyncResponse

# Bound cache size (NFR — no unbounded growth).
_MAX_ATTEMPTS = 256
_MAX_SUBJECTS = 64


class SyncStore:
    def __init__(self) -> None:
        self._lock = Lock()
        self._states: dict[str, CognitiveState] = {}
        self._attempts: dict[str, SyncResponse] = {}

    def apply(self, req: SyncRequest) -> SyncResponse:
        subject_id = req.edgeState.subjectId.strip()
        if not subject_id:
            raise ValueError("edgeState.subjectId is required")
        if req.edgeState.subjectId != subject_id:
            raise ValueError("edgeState.subjectId must be non-empty")

        attempt_key = f"{subject_id}::{req.syncAttemptId}"

        with self._lock:
            cached = self._attempts.get(attempt_key)
            if cached is not None:
                return cached

            # Adopt edge state as master for this stub (real orchestrator CRDT-merges).
            merged = req.edgeState.model_copy(deep=True)
            if subject_id not in self._states and len(self._states) >= _MAX_SUBJECTS:
                # Evict an arbitrary subject to stay bounded.
                self._states.pop(next(iter(self._states)))
            self._states[subject_id] = merged

            response = SyncResponse(mergedState=merged)
            if len(self._attempts) >= _MAX_ATTEMPTS:
                self._attempts.pop(next(iter(self._attempts)))
            self._attempts[attempt_key] = response
            return response

    def get_state(self, subject_id: str) -> CognitiveState | None:
        with self._lock:
            return self._states.get(subject_id)
