"""Server-side CvRDT join — the Python twin of ``crdt_harness_resolver.ts``.

Both implementations MUST compute identical joins for identical inputs;
the cross-language property-based conformance suite in CI feeds the same
generated replicas to both and diffs the results byte-for-byte.

Merge algebra (join-semilattice — commutative, associative, idempotent):
    mastery.alpha/.beta  → per-device G-Counter shards, pointwise max
    frictionLog          → G-Set keyed by capturedAt (HLC embeds deviceId)
    session registers    → LWW under HLC total order
    stateVector          → pointwise HLC max
"""

from __future__ import annotations

from .contract_models import (
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SyncAdvisory,
)


class IrreconcilableStateError(Exception):
    """Structural impossibility (different subjects / broken schema).

    The ONLY unrecoverable merge condition; everything else self-heals
    into advisories."""


def merge_states(
    local: CognitiveState, remote: CognitiveState
) -> tuple[CognitiveState, list[SyncAdvisory]]:
    """Join two replicas of one subject's cognitive state.

    Args:
        local: the cloud master replica.
        remote: the incoming edge replica (already schema-validated by
            FastAPI/Pydantic at the boundary).

    Returns:
        The converged document and any self-healing advisories.

    Raises:
        IrreconcilableStateError: replicas describe different subjects.
    """
    if local.subjectId != remote.subjectId:
        raise IrreconcilableStateError(
            f"refusing to merge {remote.subjectId!r} into {local.subjectId!r}"
        )

    advisories: list[SyncAdvisory] = []

    merged_mastery = _merge_mastery(local.mastery, remote.mastery)
    merged_log, dropped = _merge_friction_logs(local.frictionLog, remote.frictionLog)
    if dropped:
        advisories.append(
            SyncAdvisory(
                code="DUPLICATE_SAMPLE_DROPPED",
                detail=f"{dropped} duplicate friction sample(s) dropped during union",
            )
        )

    genesis = "000000000000000:000000:genesis"
    local_session = local.stateVector.get("session", genesis)
    remote_session = remote.stateVector.get("session", genesis)
    session_winner = local if local_session >= remote_session else remote
    profile_winner = (
        local.profile if local.profile.updatedAt >= remote.profile.updatedAt else remote.profile
    )

    merged = CognitiveState(
        subjectId=local.subjectId,
        deviceIds=sorted(set(local.deviceIds) | set(remote.deviceIds)),
        activeConceptId=session_winner.activeConceptId,
        mode=session_winner.mode,
        mastery=merged_mastery,
        frictionLog=merged_log,
        profile=profile_winner,
        stateVector=_merge_vectors(local.stateVector, remote.stateVector),
    )
    return merged, advisories


def _merge_mastery(
    a: dict[str, ConceptMastery], b: dict[str, ConceptMastery]
) -> dict[str, ConceptMastery]:
    out: dict[str, ConceptMastery] = {}
    for concept_id in set(a) | set(b):
        ca, cb = a.get(concept_id), b.get(concept_id)
        if ca and cb:
            out[concept_id] = ConceptMastery(
                conceptId=concept_id,
                alpha=_merge_shards(ca.alpha, cb.alpha),
                beta=_merge_shards(ca.beta, cb.beta),
                lastExercisedAt=max(ca.lastExercisedAt, cb.lastExercisedAt),
            )
        else:
            survivor = ca or cb
            assert survivor is not None
            out[concept_id] = survivor
    return out


def _merge_shards(a: dict[str, float], b: dict[str, float]) -> dict[str, float]:
    """Pointwise max over per-device G-Counter shards."""
    return {device: max(a.get(device, 0.0), b.get(device, 0.0)) for device in set(a) | set(b)}


def _merge_friction_logs(
    a: list[FrictionSample], b: list[FrictionSample]
) -> tuple[list[FrictionSample], int]:
    """G-Set union keyed by capturedAt; HLC keys are globally unique."""
    by_key: dict[str, FrictionSample] = {}
    duplicates = 0
    for sample in [*a, *b]:
        if sample.capturedAt in by_key:
            duplicates += 1
        else:
            by_key[sample.capturedAt] = sample
    ordered = sorted(by_key.values(), key=lambda s: s.capturedAt)
    return ordered, duplicates


def _merge_vectors(a: dict[str, str], b: dict[str, str]) -> dict[str, str]:
    """Pointwise HLC max (lexicographic order == HLC total order)."""
    return {key: max(a.get(key, ""), b.get(key, "")) for key in set(a) | set(b)}
