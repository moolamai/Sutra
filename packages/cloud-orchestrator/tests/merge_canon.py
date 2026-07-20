"""Canonicalization + merge-safe helpers — Python twin of ``merge_canon.mjs``.

Used by law / convergence suites against ``merge_states``.
"""

from __future__ import annotations

import json
import time
from typing import Any

from sutra_orchestrator.contract_models import CognitiveState
from sutra_orchestrator.crdt_merge import merge_states


def merge_safe_physical_max() -> int:
    """Keep generated HLCs inside a generous skew horizon (+1h)."""
    return int(time.time() * 1000) + 60 * 60 * 1000


def sort_keys_deep(value: Any) -> Any:
    if isinstance(value, list):
        return [sort_keys_deep(v) for v in value]
    if isinstance(value, dict):
        return {k: sort_keys_deep(value[k]) for k in sorted(value)}
    return value


def canonicalize_state(state: CognitiveState | dict[str, Any]) -> str:
    """Canonical JSON for join-semilattice equality (not object identity)."""
    if isinstance(state, CognitiveState):
        data = state.model_dump(mode="json")
    else:
        data = dict(state)
    normalized = {
        **data,
        "deviceIds": sorted(list(data.get("deviceIds") or [])),
        "frictionLog": sorted(
            list(data.get("frictionLog") or []),
            key=lambda s: s["capturedAt"] if isinstance(s, dict) else s.capturedAt,
        ),
    }
    return json.dumps(sort_keys_deep(normalized), separators=(",", ":"), ensure_ascii=True)


def make_merge_safe(
    state: dict[str, Any], *, max_physical: int | None = None
) -> dict[str, Any]:
    """Rewrite every HLC string's physical component into the merge-safe window."""
    cap = max_physical if max_physical is not None else merge_safe_physical_max()

    def rewrite(hlc: str) -> str:
        if not isinstance(hlc, str) or len(hlc) < 22:
            return hlc
        try:
            physical = int(hlc[:15])
        except ValueError:
            return hlc
        if physical <= cap:
            return hlc
        return f"{cap:015d}{hlc[15:]}"

    mastery = {
        k: {**m, "lastExercisedAt": rewrite(m["lastExercisedAt"])}
        for k, m in (state.get("mastery") or {}).items()
    }
    return {
        **state,
        "profile": {
            **state["profile"],
            "updatedAt": rewrite(state["profile"]["updatedAt"]),
        },
        "mastery": mastery,
        "frictionLog": [
            {**s, "capturedAt": rewrite(s["capturedAt"])} for s in state.get("frictionLog") or []
        ],
        "stateVector": {
            k: rewrite(v) for k, v in (state.get("stateVector") or {}).items()
        },
    }


def as_state(value: CognitiveState | dict[str, Any]) -> CognitiveState:
    if isinstance(value, CognitiveState):
        return value
    return CognitiveState.model_validate(value)


def merge_pair(
    left: CognitiveState | dict[str, Any],
    right: CognitiveState | dict[str, Any],
) -> CognitiveState:
    merged, _ = merge_states(as_state(left), as_state(right))
    return merged


def fold_merge(replicas: list[CognitiveState | dict[str, Any]]) -> CognitiveState:
    if not replicas:
        raise ValueError("FOLD_MERGE_EMPTY: need at least one replica")
    acc = as_state(replicas[0])
    for nxt in replicas[1:]:
        acc = merge_pair(acc, nxt)
    return acc


def apply_compaction_handshake(
    state: CognitiveState | dict[str, Any],
    compacted_sample_timestamps: list[str],
) -> dict[str, Any]:
    drop = set(compacted_sample_timestamps)
    data = (
        state.model_dump(mode="json")
        if isinstance(state, CognitiveState)
        else dict(state)
    )
    return {
        **data,
        "frictionLog": [s for s in data.get("frictionLog") or [] if s["capturedAt"] not in drop],
    }


def fold_merge_with_compaction_handshake(
    replicas: list[CognitiveState | dict[str, Any]],
    *,
    split_at: int = 1,
) -> tuple[CognitiveState, list[str]]:
    if not replicas:
        raise ValueError("FOLD_MERGE_EMPTY: need at least one replica")
    cut = min(max(1, split_at), len(replicas) - 1)
    mid = fold_merge(replicas[: cut + 1])
    compacted = [s.capturedAt for s in mid.frictionLog]
    for nxt in replicas[cut + 1 :]:
        mid = merge_pair(mid, apply_compaction_handshake(nxt, compacted))
    return mid, compacted


def permute_from_seed(n: int, seed: int) -> list[int]:
    """Deterministic Fisher–Yates from a uint32 seed."""
    arr = list(range(n))
    s = seed & 0xFFFFFFFF
    for i in range(n - 1, 0, -1):
        s = (s * 1664525 + 1013904223) & 0xFFFFFFFF
        j = s % (i + 1)
        arr[i], arr[j] = arr[j], arr[i]
    return arr


def permute_replicas(
    replicas: list[Any], order: list[int]
) -> list[Any]:
    return [replicas[i] for i in order]
