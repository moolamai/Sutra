"""Sync service — owns master state documents and CRDT reconciliation.

The cloud side of the sync protocol, isolated from HTTP concerns so any
transport (REST, GraphQL, gRPC) can mount it. Backends implement
:class:`~sutra_orchestrator.master_state_repository.MasterStateRepository`;
the in-memory store keeps ``uvicorn`` runnable with zero infra, and the
Postgres repository plugs in behind the same protocol.

Every successful reconciliation appends exactly one ``sync_audit`` row
inside the same ``subject_guard`` transaction as the state write (SYNC-06).
"""

from __future__ import annotations

import logging

from . import PROTOCOL_VERSION
from .contract_models import SyncRequest, SyncResponse
from .crdt_merge import merge_states
from .master_state_repository import (
    InMemoryMasterStateStore,
    MasterStateRepository,
    MasterStateStore,
    PostgresMasterStateStore,
)
from .sync_audit_writer import SyncAuditRecord, advisories_verbatim
from .sync_trace import continue_sync_trace

logger = logging.getLogger(__name__)

__all__ = [
    "InMemoryMasterStateStore",
    "MasterStateRepository",
    "MasterStateStore",
    "PostgresMasterStateStore",
    "SyncService",
]


class SyncService:
    """CRDT reconciliation entry point.

    Idempotent by construction: replaying the same SyncRequest yields the
    identical merged document (join idempotence), so retries after network
    drops need no dedup bookkeeping. Structural impossibilities raise
    ``IrreconcilableStateError`` for the transport layer to map to a
    non-retryable status.

    Every reconciliation is read-merge-write under the repository's
    per-subject serialization guard, with a transactional sync_audit append.

    Durability (A-G3): when the store is Postgres-backed, committed state and
    audit rows survive orchestrator process kill / compose restart — covered by
    ``tests/test_restart_durability.py``.
    """

    def __init__(self, store: MasterStateRepository) -> None:
        self._store = store

    def reconcile(self, request: SyncRequest) -> SyncResponse:
        edge = request.edgeState
        subject_id = edge.subjectId

        with self._store.subject_guard(subject_id):
            master = self._store.get_state(subject_id)
            base = master or edge
            state_vector_before = dict(base.stateVector)

            # Extract W3C traceparent before merge .
            with continue_sync_trace(request):
                merged, advisories = merge_states(base, edge)
            self._store.put_state(
                merged,
                expected_subject_id=subject_id,
            )
            self._store.append_sync_audit(
                SyncAuditRecord(
                    subject_id=subject_id,
                    device_id=request.deviceId,
                    sync_attempt_id=str(request.syncAttemptId),
                    protocol_version=PROTOCOL_VERSION,
                    advisories=advisories_verbatim(advisories),
                    state_vector_before=state_vector_before,
                    state_vector_after=dict(merged.stateVector),
                )
            )

        logger.info(
            "sync ok: subject_id=%s device_id=%s samples=%d advisories=%d outcome=ok",
            subject_id,
            request.deviceId,
            len(edge.frictionLog),
            len(advisories),
        )
        return SyncResponse(
            protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
            mergedState=merged,
            # Reference engine compacts every merged sample immediately; a
            # production deployment may defer compaction to a batch job.
            compactedSampleTimestamps=[s.capturedAt for s in merged.frictionLog],
            advisories=advisories,
        )
