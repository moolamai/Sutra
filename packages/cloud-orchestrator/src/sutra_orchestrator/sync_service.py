"""Sync service — owns master state documents and CRDT reconciliation.

The cloud side of the sync protocol, isolated from HTTP concerns so any
transport (REST, GraphQL, gRPC) can mount it. The reference store is an
in-process dict keeping ``uvicorn main:app`` runnable with zero infra; a
production deployment persists documents to Postgres (JSONB, keyed by
``subject_id``) behind the same ``MasterStateStore`` shape.
"""

from __future__ import annotations

import logging

from .contract_models import CognitiveState, SyncRequest, SyncResponse
from .crdt_merge import merge_states

logger = logging.getLogger(__name__)


class MasterStateStore:
    """In-memory master-document store. Replace with a JSONB-backed store
    in production; the sync service only needs get/put semantics."""

    def __init__(self) -> None:
        self._states: dict[str, CognitiveState] = {}

    def get(self, subject_id: str) -> CognitiveState | None:
        return self._states.get(subject_id)

    def put(self, state: CognitiveState) -> None:
        self._states[state.subjectId] = state


class SyncService:
    """CRDT reconciliation entry point.

    Idempotent by construction: replaying the same SyncRequest yields the
    identical merged document (join idempotence), so retries after network
    drops need no dedup bookkeeping. Structural impossibilities raise
    ``IrreconcilableStateError`` for the transport layer to map to a
    non-retryable status.
    """

    def __init__(self, store: MasterStateStore) -> None:
        self._store = store

    def reconcile(self, request: SyncRequest) -> SyncResponse:
        edge = request.edgeState
        master = self._store.get(edge.subjectId) or edge

        merged, advisories = merge_states(master, edge)
        self._store.put(merged)

        logger.info(
            "sync ok: subject=%s device=%s samples=%d advisories=%d",
            edge.subjectId,
            request.deviceId,
            len(edge.frictionLog),
            len(advisories),
        )
        return SyncResponse(
            mergedState=merged,
            # Reference engine compacts every merged sample immediately; a
            # production deployment may defer compaction to a batch job.
            compactedSampleTimestamps=[s.capturedAt for s in merged.frictionLog],
            advisories=advisories,
        )
