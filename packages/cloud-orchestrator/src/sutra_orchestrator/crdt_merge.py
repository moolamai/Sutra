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

import json
import time

from . import PROTOCOL_VERSION
from .contract_models import (
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
    SyncAdvisory,
)

# SYNC-02 — shared named constant with TS ``MAX_CLOCK_SKEW_MS`` (24h).
MAX_CLOCK_SKEW_MS = 1000 * 60 * 60 * 24


class IrreconcilableStateError(Exception):
    """Structural impossibility (different subjects / broken schema).

    The ONLY unrecoverable merge condition; everything else self-heals
    into advisories."""


def merge_states(
    local: CognitiveState,
    remote: CognitiveState,
    *,
    known_concept_ids: set[str] | frozenset[str] | None = None,
    now_ms: int | None = None,
) -> tuple[CognitiveState, list[SyncAdvisory]]:
    """Join two replicas of one subject's cognitive state.

    Args:
        local: the cloud master replica.
        remote: the incoming edge replica (already schema-validated by
            FastAPI/Pydantic at the boundary).
        known_concept_ids: optional task-graph whitelist. Mastery keys absent
            from this set emit ``UNKNOWN_CONCEPT_QUARANTINED`` (SYNC-06) while
            shard bytes remain in the merged document for later adoption.
            ``None`` skips the check (backward compatible).
        now_ms: wall-clock "now" for SYNC-02 skew clamp (injectable for
            fixtures). Defaults to ``time.time() * 1000``.

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
    remote = _clamp_clock_skew(remote, advisories, now_ms=now_ms)

    merged_mastery = _merge_mastery(local.mastery, remote.mastery)
    _quarantine_unknown_concepts(merged_mastery, known_concept_ids, advisories)
    _detect_state_vector_regression(local.stateVector, remote.stateVector, advisories)
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
    if local_session > remote_session:
        session_winner = local
    elif remote_session > local_session:
        session_winner = remote
    else:
        # Equal session HLC: preferring "local" breaks permutation convergence
        # when mode/activeConceptId differ. Pick a payload-max side.
        session_winner = _prefer_session_side(local, remote)

    if local.profile.updatedAt > remote.profile.updatedAt:
        profile_winner = local.profile
    elif remote.profile.updatedAt > local.profile.updatedAt:
        profile_winner = remote.profile
    else:
        profile_winner = _prefer_profile(local.profile, remote.profile)

    merged = CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
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


def _clamp_clock_skew(
    state: CognitiveState,
    advisories: list[SyncAdvisory],
    *,
    now_ms: int | None = None,
) -> CognitiveState:
    """SYNC-02 — clamp remote HLCs beyond ``now + MAX_CLOCK_SKEW_MS``.

    Mirrors TS ``clampClockSkew``: profile.updatedAt + stateVector only.
    Advisory detail lists original→clamped pairs.
    """
    now = int(time.time() * 1000) if now_ms is None else now_ms
    horizon = now + MAX_CLOCK_SKEW_MS
    pairs: list[str] = []

    def clamp_one(hlc: str) -> str:
        physical = int(hlc[:15])
        if physical <= horizon:
            return hlc
        clamped = f"{horizon:015d}{hlc[15:]}"
        pairs.append(f"{hlc}→{clamped}")
        return clamped

    clamped_state = state.model_copy(
        update={
            "profile": state.profile.model_copy(
                update={"updatedAt": clamp_one(state.profile.updatedAt)}
            ),
            "stateVector": {k: clamp_one(v) for k, v in state.stateVector.items()},
        }
    )
    if pairs:
        advisories.append(
            SyncAdvisory(
                code="CLOCK_SKEW_CLAMPED",
                detail=(
                    f"{len(pairs)} HLC timestamp(s) exceeded the {MAX_CLOCK_SKEW_MS}ms "
                    f"skew horizon and were clamped; original→clamped: {'; '.join(pairs)}"
                ),
            )
        )
    return clamped_state


def _quarantine_unknown_concepts(
    mastery: dict[str, ConceptMastery],
    known_concept_ids: set[str] | frozenset[str] | None,
    advisories: list[SyncAdvisory],
) -> None:
    """SYNC-06 / UNKNOWN_CONCEPT_QUARANTINED — report, do not drop evidence."""
    if known_concept_ids is None:
        return
    quarantined = sorted(cid for cid in mastery if cid not in known_concept_ids)
    if not quarantined:
        return
    advisories.append(
        SyncAdvisory(
            code="UNKNOWN_CONCEPT_QUARANTINED",
            detail=(
                f"{len(quarantined)} unknown conceptId(s) quarantined "
                f"(evidence preserved): {', '.join(quarantined)}"
            ),
        )
    )


def _detect_state_vector_regression(
    stored: dict[str, str],
    submitted: dict[str, str],
    advisories: list[SyncAdvisory],
) -> None:
    """SYNC-06 / STATE_VECTOR_REGRESSION — submitted strictly dominated by stored.

    Lexicographic HLC order is the total order. Merge still proceeds via
    pointwise max; advisory names the regressed entries.
    """
    genesis = "000000000000000:000000:genesis"
    keys = set(stored) | set(submitted)
    regressed: list[str] = []
    submitted_ahead = False
    for key in keys:
        s = stored.get(key, genesis)
        u = submitted.get(key, genesis)
        if u > s:
            submitted_ahead = True
        elif u < s:
            regressed.append(key)
    if submitted_ahead or not regressed:
        return
    regressed.sort()
    advisories.append(
        SyncAdvisory(
            code="STATE_VECTOR_REGRESSION",
            detail=(
                "submitted stateVector strictly dominated by stored; "
                f"regressed entries: {', '.join(regressed)}"
            ),
        )
    )


def _prefer_session_side(local: CognitiveState, remote: CognitiveState) -> CognitiveState:
    """Deterministic LWW payload preference when session HLCs are equal."""

    def canon(s: CognitiveState) -> str:
        return json.dumps(
            {"mode": s.mode, "activeConceptId": s.activeConceptId},
            sort_keys=True,
            separators=(",", ":"),
        )

    return local if canon(local) >= canon(remote) else remote


def _prefer_profile(a: SubjectProfile, b: SubjectProfile) -> SubjectProfile:
    """Deterministic profile preference when ``updatedAt`` clocks are equal."""

    def canon(p: SubjectProfile) -> str:
        return json.dumps(p.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))

    return a if canon(a) >= canon(b) else b


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


def _prefer_friction_sample(a: FrictionSample, b: FrictionSample) -> FrictionSample:
    """Deterministic preference when two samples share ``capturedAt``.

    Lexicographic max of a key-sorted JSON form — independent of merge order.
    First-wins over concat order is NOT commutative (found by TS law fuzz).
    """

    def canon(s: FrictionSample) -> str:
        return json.dumps(s.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))

    return a if canon(a) >= canon(b) else b


def _merge_friction_logs(
    a: list[FrictionSample], b: list[FrictionSample]
) -> tuple[list[FrictionSample], int]:
    """G-Set union keyed by capturedAt; duplicate keys resolve deterministically."""
    by_key: dict[str, FrictionSample] = {}
    duplicates = 0

    def consider(sample: FrictionSample) -> None:
        nonlocal duplicates
        existing = by_key.get(sample.capturedAt)
        if existing is None:
            by_key[sample.capturedAt] = sample
            return
        duplicates += 1
        by_key[sample.capturedAt] = _prefer_friction_sample(existing, sample)

    for sample in a:
        consider(sample)
    for sample in b:
        consider(sample)
    ordered = sorted(by_key.values(), key=lambda s: s.capturedAt)
    return ordered, duplicates


def _merge_vectors(a: dict[str, str], b: dict[str, str]) -> dict[str, str]:
    """Pointwise HLC max (lexicographic order == HLC total order)."""
    return {key: max(a.get(key, ""), b.get(key, "")) for key in set(a) | set(b)}
