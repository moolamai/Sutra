"""Sync audit records for SYNC-06 operator evidence.

One append-only row per reconciliation: advisories verbatim, device id,
protocol version, and pre/post state-vector summary. Writers MUST run
inside the master-state ``subject_guard`` transaction so a committed
state change always has its audit row.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Mapping, Sequence


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class SyncAuditRecord:
    """One sync_audit row payload (no raw learner content)."""

    subject_id: str
    device_id: str
    sync_attempt_id: str
    protocol_version: str
    # Verbatim ``{code, detail}`` objects from SyncAdvisory — never a lossy summary.
    advisories: tuple[Mapping[str, str], ...]
    state_vector_before: Mapping[str, str]
    state_vector_after: Mapping[str, str]
    # Operator listing uses this for newest-first keyset cursors (DB default if omitted).
    created_at: datetime = field(default_factory=_utc_now)

    def advisory_codes(self) -> tuple[str, ...]:
        return tuple(str(a["code"]) for a in self.advisories)


def advisories_verbatim(
    advisories: Sequence[object],
) -> tuple[Mapping[str, str], ...]:
    """Serialize SyncAdvisory models (or mappings) without dropping fields."""
    out: list[Mapping[str, str]] = []
    for item in advisories:
        if hasattr(item, "model_dump"):
            dumped = item.model_dump()  # type: ignore[union-attr]
            out.append({"code": str(dumped["code"]), "detail": str(dumped["detail"])})
        else:
            mapping = dict(item)  # type: ignore[arg-type]
            out.append({"code": str(mapping["code"]), "detail": str(mapping["detail"])})
    return tuple(out)
