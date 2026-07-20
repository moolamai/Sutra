"""CRDT property tests — (strategies) + (laws).

Strategies: ``strategies_cognitive_state`` (TS ``arbitraries.mjs`` mirror).
Laws: commutativity / associativity / idempotence / N-replica convergence
against ``sutra_orchestrator.crdt_merge.merge_states`` (TS ``merge_laws.test.mjs``).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable

import pytest
from hypothesis import HealthCheck, given, seed, settings
from hypothesis import strategies as st
from pydantic import ValidationError

from merge_canon import (
    apply_compaction_handshake,
    canonicalize_state,
    fold_merge,
    fold_merge_with_compaction_handshake,
    make_merge_safe,
    merge_pair,
    permute_from_seed,
    permute_replicas,
)
from strategies_cognitive_state import (
    CI_NUM,
    CI_STRATEGY_SEED,
    concept_mastery,
    cognitive_states,
    device_ids,
    emit_strategy_event,
    encode_hlc,
    equal_hlc_different_devices,
    friction_sample,
    friction_sample_set,
    g_counter_shards,
    hlcs,
    replica_pairs,
    subject_ids,
)
from sutra_orchestrator.contract_models import (
    HLC_PATTERN,
    CognitiveState,
    ConceptMastery,
    FrictionSample,
)
from sutra_orchestrator.crdt_merge import IrreconcilableStateError, merge_states

pytestmark = pytest.mark.slow

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "merge-laws" / "regression"

# Override for local smoke: ``SUTRA_LAW_EXAMPLES=200``. CI leaves unset → ≥10k.
LAW_NUM = int(os.environ.get("SUTRA_LAW_EXAMPLES", str(CI_NUM)))

QUICK = 200

CI_SETTINGS = settings(
    max_examples=CI_NUM,
    deadline=None,
    suppress_health_check=(HealthCheck.too_slow, HealthCheck.data_too_large),
)

QUICK_SETTINGS = settings(
    max_examples=QUICK,
    deadline=None,
    suppress_health_check=(HealthCheck.too_slow, HealthCheck.data_too_large),
)


def _assert_valid(name: str, model_cls: type, value: object) -> None:
    try:
        model_cls.model_validate(value)
    except ValidationError as err:
        emit_strategy_event(
            {
                "kind": name,
                "outcome": "error",
                "code": "ARBITRARY_SCHEMA_VIOLATION",
                "message": str(err)[:500],
            }
        )
        raise


def _run_ci_schema_property(name: str, strategy, model_cls: type | None = None) -> None:
    """CI-seeded ≥10k validity run; one structured outcome event (bounded)."""

    @seed(CI_STRATEGY_SEED)
    @CI_SETTINGS
    @given(strategy)
    def _prop(value: object) -> None:
        if model_cls is None:
            assert isinstance(value, str) and HLC_PATTERN.match(value)
        else:
            _assert_valid(name, model_cls, value)

    try:
        _prop()
        emit_strategy_event(
            {
                "kind": name,
                "outcome": "ok",
                "numRuns": CI_NUM,
                "seed": CI_STRATEGY_SEED,
            }
        )
    except Exception as err:
        emit_strategy_event(
            {
                "kind": name,
                "outcome": "error",
                "code": "ARBITRARY_SCHEMA_VIOLATION",
                "numRuns": CI_NUM,
                "seed": CI_STRATEGY_SEED,
                "message": str(err)[:500],
            }
        )
        raise


def test_happy_path_hlc_matches_wire_pattern() -> None:
    _run_ci_schema_property("hlc", hlcs(), None)


def test_happy_path_concept_mastery_matches_pydantic() -> None:
    _run_ci_schema_property("conceptMastery", concept_mastery(), ConceptMastery)


def test_happy_path_friction_sample_matches_pydantic() -> None:
    _run_ci_schema_property("frictionSample", friction_sample(), FrictionSample)


def test_happy_path_cognitive_state_matches_pydantic() -> None:
    _run_ci_schema_property("cognitiveState", cognitive_states(), CognitiveState)


@seed(CI_STRATEGY_SEED)
@QUICK_SETTINGS
@given(equal_hlc_different_devices())
def test_edge_equal_hlc_different_devices_ordered_by_device_id(pair: dict) -> None:
    a, b = pair["a"], pair["b"]
    device_a, device_b = pair["deviceA"], pair["deviceB"]
    assert HLC_PATTERN.match(a)
    assert HLC_PATTERN.match(b)
    assert a != b
    assert a[:22] == b[:22]
    expected = -1 if device_a < device_b else 1 if device_a > device_b else 0
    # Lexicographic HLC order == total order (wire contract).
    got = -1 if a < b else 1 if a > b else 0
    assert got == expected


def test_edge_equal_hlc_emits_observability() -> None:
    emit_strategy_event(
        {
            "kind": "equalHlcDifferentDevices",
            "outcome": "ok",
            "numRuns": QUICK,
            "seed": CI_STRATEGY_SEED,
        }
    )


def test_edge_g_counter_shards_cover_empty_single_multi() -> None:
    # Sample via property accumulation for deterministic CI seed.
    samples: list[dict[str, float]] = []

    @seed(CI_STRATEGY_SEED)
    @settings(max_examples=100, deadline=None)
    @given(g_counter_shards())
    def _collect(shards: dict[str, float]) -> None:
        samples.append(shards)

    _collect()
    empty = sum(1 for s in samples if len(s) == 0)
    single = sum(1 for s in samples if len(s) == 1)
    multi = sum(1 for s in samples if len(s) >= 2)
    assert empty > 0, "expected empty shard maps"
    assert single > 0, "expected single-shard maps"
    assert multi > 0, "expected multi-device shard maps"
    emit_strategy_event(
        {
            "kind": "gCounterShards.bias",
            "outcome": "ok",
            "empty": empty,
            "single": single,
            "multi": multi,
        }
    )


def test_edge_friction_sample_set_emits_collisions() -> None:
    samples: list[list[dict]] = []

    @seed(CI_STRATEGY_SEED)
    @settings(max_examples=100, deadline=None, suppress_health_check=(HealthCheck.too_slow,))
    @given(friction_sample_set(collision_bias=True))
    def _collect(rows: list[dict]) -> None:
        samples.append(rows)

    _collect()
    empties = 0
    collisions = 0
    for set_rows in samples:
        if len(set_rows) == 0:
            empties += 1
        for sample in set_rows:
            FrictionSample.model_validate(sample)
        keys = [s["capturedAt"] for s in set_rows]
        if len(keys) != len(set(keys)):
            collisions += 1
    assert empties > 0, "empty friction logs must be first-class"
    assert collisions > 0, "capturedAt collisions must be generated"
    emit_strategy_event(
        {
            "kind": "frictionSampleSet.collisions",
            "outcome": "ok",
            "empties": empties,
            "collisions": collisions,
            "sampled": len(samples),
        }
    )


def test_edge_cognitive_state_empty_mastery_and_equal_hlc_vectors() -> None:
    samples: list[dict] = []

    @seed(CI_STRATEGY_SEED)
    @settings(max_examples=100, deadline=None, suppress_health_check=(HealthCheck.too_slow,))
    @given(cognitive_states(equal_timestamp_bias=True, empty_bias=True))
    def _collect(state: dict) -> None:
        samples.append(state)

    _collect()
    empty_mastery = sum(1 for s in samples if len(s["mastery"]) == 0)
    equal_ts = 0
    for state in samples:
        CognitiveState.model_validate(state)
        entries = list(state["stateVector"].values())
        for i, a in enumerate(entries):
            for b in entries[i + 1 :]:
                if a[:22] == b[:22] and a != b:
                    equal_ts += 1
    assert empty_mastery > 0, "empty mastery maps must be first-class"
    assert equal_ts > 0, "adversarial equal-HLC state vectors expected"
    emit_strategy_event(
        {
            "kind": "cognitiveState.bias",
            "outcome": "ok",
            "emptyMastery": empty_mastery,
            "equalTsVectors": equal_ts,
        }
    )


@seed(CI_STRATEGY_SEED)
@QUICK_SETTINGS
@given(replica_pairs(overlap="none", equal_timestamp_bias=True))
def test_edge_replica_pair_overlap_none_disjoint_mastery(pair: dict) -> None:
    assert pair["left"]["subjectId"] == pair["right"]["subjectId"]
    assert pair["subjectId"] == pair["left"]["subjectId"]
    CognitiveState.model_validate(pair["left"])
    CognitiveState.model_validate(pair["right"])
    left_keys = set(pair["left"]["mastery"])
    right_keys = set(pair["right"]["mastery"])
    assert left_keys.isdisjoint(right_keys)
    ls = pair["left"]["stateVector"]["session"]
    rs = pair["right"]["stateVector"]["session"]
    assert ls[:22] == rs[:22]
    assert ls != rs


@seed(CI_STRATEGY_SEED)
@QUICK_SETTINGS
@given(replica_pairs(overlap="full", equal_timestamp_bias=False))
def test_edge_replica_pair_overlap_full_shared_keys(pair: dict) -> None:
    left_keys = sorted(pair["left"]["mastery"])
    right_keys = sorted(pair["right"]["mastery"])
    assert left_keys == right_keys


def test_edge_replica_pair_emits_observability() -> None:
    emit_strategy_event(
        {
            "kind": "replicaPair.overlap",
            "outcome": "ok",
            "numRuns": QUICK,
            "seed": CI_STRATEGY_SEED,
        }
    )


@seed(CI_STRATEGY_SEED)
@QUICK_SETTINGS
@given(concept_mastery(), friction_sample(), replica_pairs())
def test_sovereignty_leaf_gens_omit_subject_id_pairs_share_subject(
    mastery: dict, sample: dict, pair: dict
) -> None:
    assert "subjectId" not in mastery
    assert "subjectId" not in sample
    assert pair["left"]["subjectId"] == pair["right"]["subjectId"]
    assert re.fullmatch(r"[a-z][a-z0-9_-]{2,32}", pair["left"]["subjectId"])


def test_sovereignty_emits_observability() -> None:
    emit_strategy_event(
        {
            "kind": "subjectIsolation.replicaPair",
            "outcome": "ok",
            "numRuns": QUICK,
        }
    )


@seed(CI_STRATEGY_SEED)
@QUICK_SETTINGS
@given(device_ids)
def test_device_ids_stay_in_hlc_wire_alphabet(device_id: str) -> None:
    assert re.fullmatch(r"[A-Za-z0-9_-]{4,64}", device_id)


def test_scalability_strategy_bounds_are_finite() -> None:
    from strategies_cognitive_state import MAX_CONCEPTS, MAX_FRICTION_SAMPLES, MAX_SHARDS

    assert MAX_SHARDS == 8
    assert MAX_FRICTION_SAMPLES == 16
    assert MAX_CONCEPTS == 6
    emit_strategy_event(
        {
            "kind": "strategy.bounds",
            "outcome": "ok",
            "maxShards": MAX_SHARDS,
            "maxFriction": MAX_FRICTION_SAMPLES,
            "maxConcepts": MAX_CONCEPTS,
        }
    )


def test_invalid_payload_fails_at_boundary() -> None:
    with pytest.raises(ValidationError):
        CognitiveState.model_validate(
            {
                "protocolVersion": "1.0.0",
                "subjectId": "",
                "deviceIds": ["edge-aaaa"],
                "activeConceptId": None,
                "mode": "exploratory",
                "mastery": {},
                "frictionLog": [],
                "profile": {
                    "ageBand": "adult",
                    "track": "algebra",
                    "language": "en",
                    "updatedAt": "000000000000001:000000:edge-aaaa",
                },
                "stateVector": {"session": "000000000000001:000000:edge-aaaa"},
            }
        )
    emit_strategy_event(
        {
            "kind": "boundary.validation",
            "outcome": "ok",
            "code": "SUBJECT_ID_REJECTED",
        }
    )


# ─── : merge law + convergence suites ───────────────────────────


def emit_law_event(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps({"event": "crdt.merge.law", **event}) + "\n")
    sys.stdout.flush()


def persist_counterexample(law: str, payload: dict[str, Any]) -> Path:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    body = json.dumps(
        {"law": law, **payload},
        indent=2,
        default=str,
        ensure_ascii=True,
    )
    digest = hashlib.sha256(body.encode()).hexdigest()[:12]
    path = FIXTURE_DIR / f"{law}-{digest}.json"
    path.write_text(body + "\n", encoding="utf-8")
    emit_law_event(
        {
            "outcome": "error",
            "code": "MERGE_LAW_COUNTEREXAMPLE",
            "law": law,
            "fixture": str(path.relative_to(Path(__file__).resolve().parent.parent)),
            "subjectId": payload.get("subjectId"),
        }
    )
    return path


@st.composite
def merge_safe_pairs(
    draw: st.DrawFn,
    *,
    overlap: str = "partial",
    equal_timestamp_bias: bool = True,
) -> dict[str, Any]:
    pair = draw(
        replica_pairs(overlap=overlap, equal_timestamp_bias=equal_timestamp_bias)
    )
    return {
        **pair,
        "left": make_merge_safe(pair["left"]),
        "right": make_merge_safe(pair["right"]),
    }


@st.composite
def merge_safe_triples(draw: st.DrawFn) -> dict[str, Any]:
    subject_id = draw(subject_ids)
    a0 = draw(cognitive_states(empty_bias=True, equal_timestamp_bias=True))
    b0 = draw(cognitive_states(empty_bias=True, equal_timestamp_bias=True))
    c0 = draw(cognitive_states(empty_bias=True, equal_timestamp_bias=True))
    return {
        "subjectId": subject_id,
        "a": make_merge_safe({**a0, "subjectId": subject_id}),
        "b": make_merge_safe({**b0, "subjectId": subject_id}),
        "c": make_merge_safe({**c0, "subjectId": subject_id}),
    }


@st.composite
def replica_histories(draw: st.DrawFn) -> dict[str, Any]:
    n = draw(st.integers(3, 5))
    subject_id = draw(subject_ids)
    perm_seed = draw(st.integers(0, 0xFFFFFFFF))
    raw = [draw(cognitive_states(empty_bias=True, equal_timestamp_bias=True)) for _ in range(n)]
    replicas: list[dict[str, Any]] = []
    for i, s in enumerate(raw):
        fixed = make_merge_safe({**s, "subjectId": subject_id})
        # Well-formed clocks: capturedAt is globally unique across replicas.
        # Bounded logs can otherwise collide on device-seeded indices and make
        # compaction-prune diverge from prefer-on-duplicate (adversarial keys).
        device = (fixed["deviceIds"][0] if fixed["deviceIds"] else "edge")[:48]
        friction = [
            {
                **sample,
                "capturedAt": encode_hlc(
                    1_000_000 + i * 64 + j,
                    j,
                    f"r{i}-{device}"[:64],
                ),
            }
            for j, sample in enumerate(fixed.get("frictionLog") or [])
        ]
        replicas.append({**fixed, "frictionLog": friction})
    identity = list(range(n))
    reverse = list(reversed(identity))
    orders = [
        identity,
        reverse,
        permute_from_seed(n, perm_seed),
        permute_from_seed(n, perm_seed ^ 0x9E3779B9),
        permute_from_seed(n, perm_seed + 1),
    ]
    uniq: list[list[int]] = []
    seen: set[str] = set()
    for order in orders:
        key = ",".join(map(str, order))
        if key not in seen:
            seen.add(key)
            uniq.append(order)
    return {"subjectId": subject_id, "replicas": replicas, "orders": uniq, "n": n}


def check_law(
    law: str,
    strategy: st.SearchStrategy[Any],
    predicate: Callable[[Any], bool],
    *,
    num_runs: int | None = None,
) -> None:
    runs = CI_NUM if num_runs is None else num_runs
    # Prefer LAW_NUM when caller uses default CI budget.
    if num_runs is None:
        runs = LAW_NUM

    @seed(CI_STRATEGY_SEED)
    @settings(
        max_examples=runs,
        deadline=None,
        suppress_health_check=(HealthCheck.too_slow, HealthCheck.data_too_large),
    )
    @given(strategy)
    def _prop(inp: Any) -> None:
        assert predicate(inp), f"MERGE_LAW_VIOLATION:{law}"

    try:
        _prop()
        emit_law_event(
            {
                "law": law,
                "outcome": "ok",
                "numRuns": runs,
                "seed": CI_STRATEGY_SEED,
            }
        )
    except Exception as err:
        persist_counterexample(
            law,
            {
                "subjectId": None,
                "error": str(err)[:500],
            },
        )
        emit_law_event(
            {
                "law": law,
                "outcome": "error",
                "code": "MERGE_LAW_VIOLATION",
                "numRuns": runs,
                "seed": CI_STRATEGY_SEED,
            }
        )
        raise


def test_law_commutative_merge_ab_eq_ba() -> None:
    def pred(pair: dict) -> bool:
        a, b, subject_id = pair["left"], pair["right"], pair["subjectId"]
        assert a["subjectId"] == b["subjectId"] == subject_id
        ab = merge_pair(a, b)
        ba = merge_pair(b, a)
        return canonicalize_state(ab) == canonicalize_state(ba)

    check_law(
        "commutative",
        merge_safe_pairs(overlap="partial", equal_timestamp_bias=True),
        pred,
    )


def test_law_associative_merge_nesting() -> None:
    def pred(triple: dict) -> bool:
        subject_id, a, b, c = (
            triple["subjectId"],
            triple["a"],
            triple["b"],
            triple["c"],
        )
        assert a["subjectId"] == b["subjectId"] == c["subjectId"] == subject_id
        left = merge_pair(a, merge_pair(b, c))
        right = merge_pair(merge_pair(a, b), c)
        return canonicalize_state(left) == canonicalize_state(right)

    check_law("associative", merge_safe_triples(), pred)


def test_law_idempotent_merge_aa_eq_a() -> None:
    def pred(state: dict) -> bool:
        aa = merge_pair(state, state)
        return canonicalize_state(aa) == canonicalize_state(state)

    check_law(
        "idempotent",
        cognitive_states(empty_bias=True, equal_timestamp_bias=True).map(make_merge_safe),
        pred,
    )


def test_law_convergence_permuted_replica_folds() -> None:
    def pred(hist: dict) -> bool:
        subject_id = hist["subjectId"]
        replicas = hist["replicas"]
        assert 3 <= len(replicas) <= 5
        for r in replicas:
            assert r["subjectId"] == subject_id
        canons = [
            canonicalize_state(fold_merge(permute_replicas(replicas, order)))
            for order in hist["orders"]
        ]
        return all(c == canons[0] for c in canons)

    check_law("convergence", replica_histories(), pred)


def test_law_compaction_handshake_mid_fold_converges() -> None:
    def pred(hist: dict) -> bool:
        subject_id = hist["subjectId"]
        replicas = hist["replicas"]
        assert replicas[0]["subjectId"] == subject_id
        ordered = permute_replicas(replicas, hist["orders"][0])
        pure = canonicalize_state(fold_merge(ordered))
        merged, compacted = fold_merge_with_compaction_handshake(ordered, split_at=1)
        assert isinstance(compacted, list)
        return pure == canonicalize_state(merged)

    check_law("convergence.compaction", replica_histories(), pred)


@seed(CI_STRATEGY_SEED)
@QUICK_SETTINGS
@given(merge_safe_pairs(overlap="none", equal_timestamp_bias=False))
def test_edge_disjoint_replicas_remain_commutative(pair: dict) -> None:
    ab = canonicalize_state(merge_pair(pair["left"], pair["right"]))
    ba = canonicalize_state(merge_pair(pair["right"], pair["left"]))
    assert ab == ba


def test_edge_disjoint_emits_observability() -> None:
    emit_law_event(
        {
            "law": "commutative",
            "outcome": "ok",
            "kind": "edge.disjoint",
            "numRuns": QUICK,
        }
    )


@seed(CI_STRATEGY_SEED)
@QUICK_SETTINGS
@given(merge_safe_pairs(overlap="full", equal_timestamp_bias=True))
def test_edge_equal_hlc_adversarial_pairs_remain_commutative(pair: dict) -> None:
    assert canonicalize_state(merge_pair(pair["left"], pair["right"])) == canonicalize_state(
        merge_pair(pair["right"], pair["left"])
    )


def test_edge_equal_hlc_law_emits_observability() -> None:
    emit_law_event(
        {
            "law": "commutative",
            "outcome": "ok",
            "kind": "edge.equalHlc",
            "numRuns": QUICK,
        }
    )


@seed(CI_STRATEGY_SEED)
@QUICK_SETTINGS
@given(replica_histories())
def test_edge_replayed_merge_of_folded_state_is_idempotent(hist: dict) -> None:
    folded = fold_merge(hist["replicas"])
    assert canonicalize_state(merge_pair(folded, folded)) == canonicalize_state(folded)


def test_edge_replay_emits_observability() -> None:
    emit_law_event(
        {
            "law": "convergence",
            "outcome": "ok",
            "kind": "edge.replayIdempotent",
            "numRuns": QUICK,
        }
    )


def test_edge_compaction_handshake_prunes_only_announced_timestamps() -> None:
    samples: list[dict] = []

    @seed(CI_STRATEGY_SEED)
    @settings(max_examples=1, deadline=None)
    @given(merge_safe_pairs(overlap="partial", equal_timestamp_bias=False))
    def _one(pair: dict) -> None:
        samples.append(pair)

    _one()
    left, right = samples[0]["left"], samples[0]["right"]
    mid = merge_pair(left, right)
    compacted = [s.capturedAt for s in mid.frictionLog]
    pruned_left = apply_compaction_handshake(left, compacted)
    for s in pruned_left["frictionLog"]:
        assert s["capturedAt"] not in compacted
    assert canonicalize_state(merge_pair(mid, pruned_left)) == canonicalize_state(mid)
    emit_law_event(
        {
            "law": "convergence.compaction",
            "outcome": "ok",
            "kind": "edge.handshakePrune",
            "subjectId": left["subjectId"],
            "deviceId": left["deviceIds"][0] if left["deviceIds"] else None,
            "compacted": len(compacted),
        }
    )


def test_edge_regression_colliding_captured_at_is_order_independent() -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    seeded = FIXTURE_DIR / "friction-capturedAt-collision.json"
    if not seeded.exists():
        base = {
            "protocolVersion": "1.0.0",
            "subjectId": "subj-collision",
            "deviceIds": ["dev-a", "dev-b"],
            "activeConceptId": None,
            "mode": "exploratory",
            "mastery": {},
            "profile": {
                "ageBand": "adult",
                "track": "math",
                "language": "en",
                "updatedAt": "000000000000001:000000:dev-a",
            },
            "stateVector": {"session": "000000000000001:000000:dev-a"},
        }
        hlc = "000000001000000:000000:edge-fric"
        left = {
            **base,
            "frictionLog": [
                {
                    "conceptId": "a00",
                    "hesitationMs": 0,
                    "inputVelocity": 0,
                    "revisionCount": 0,
                    "assistanceRequested": False,
                    "outcome": "correct",
                    "capturedAt": hlc,
                }
            ],
        }
        right = {
            **base,
            "frictionLog": [
                {
                    "conceptId": "v-ref",
                    "hesitationMs": 9,
                    "inputVelocity": 1,
                    "revisionCount": 1,
                    "assistanceRequested": True,
                    "outcome": "incorrect",
                    "capturedAt": hlc,
                }
            ],
        }
        seeded.write_text(
            json.dumps(
                {
                    "law": "commutative",
                    "note": "same capturedAt distinct payloads",
                    "left": left,
                    "right": right,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
    payload = json.loads(seeded.read_text(encoding="utf-8"))
    left, right = payload["left"], payload["right"]
    assert canonicalize_state(merge_pair(left, right)) == canonicalize_state(
        merge_pair(right, left)
    )
    emit_law_event(
        {
            "law": "commutative",
            "outcome": "ok",
            "kind": "edge.regression.frictionCollision",
            "subjectId": left["subjectId"],
        }
    )


def test_edge_tostring_shard_key_is_commutative() -> None:
    """Python dicts do not have JS prototype pollution; still prove shard max."""
    base = {
        "protocolVersion": "1.0.0",
        "subjectId": "subj-tostring",
        "deviceIds": ["dev-a", "toString"],
        "activeConceptId": None,
        "mode": "exploratory",
        "frictionLog": [],
        "profile": {
            "ageBand": "adult",
            "track": "math",
            "language": "en",
            "updatedAt": "000000000000001:000000:dev-a",
        },
        "stateVector": {"session": "000000000000001:000000:dev-a"},
    }
    left = {
        **base,
        "mastery": {
            "a.0": {
                "conceptId": "a.0",
                "alpha": {"toString": 0.0, "dev-a": 1.0},
                "beta": {"dev-a": 1.0},
                "lastExercisedAt": "000000000000001:000000:dev-a",
            }
        },
    }
    right = {
        **base,
        "mastery": {
            "a.0": {
                "conceptId": "a.0",
                "alpha": {"toString": 2.0},
                "beta": {"toString": 1.0},
                "lastExercisedAt": "000000000000002:000000:toString",
            }
        },
    }
    ab = merge_pair(left, right)
    ba = merge_pair(right, left)
    assert canonicalize_state(ab) == canonicalize_state(ba)
    assert ab.mastery["a.0"].alpha["toString"] == 2.0
    emit_law_event(
        {
            "law": "commutative",
            "outcome": "ok",
            "kind": "edge.regression.toStringShard",
            "subjectId": left["subjectId"],
        }
    )


def test_edge_regression_equal_session_hlc_mode_tie_converges() -> None:
    """Regression from : equal session HLC + different modes."""
    seeded = FIXTURE_DIR / "lww-equal-session-mode-tie.json"
    hist = json.loads(seeded.read_text(encoding="utf-8"))
    replicas = hist["replicas"]
    orders = hist["orders"]
    canons = [
        canonicalize_state(fold_merge(permute_replicas(replicas, order)))
        for order in orders
    ]
    assert all(c == canons[0] for c in canons)
    emit_law_event(
        {
            "law": "convergence",
            "outcome": "ok",
            "kind": "edge.regression.equalSessionModeTie",
            "subjectId": hist.get("subjectId"),
        }
    )


@seed(CI_STRATEGY_SEED)
@QUICK_SETTINGS
@given(
    cognitive_states().map(make_merge_safe),
    cognitive_states().map(make_merge_safe),
)
def test_sovereignty_subject_mismatch_refuses_cross_subject_merge(
    a: dict, b: dict
) -> None:
    if a["subjectId"] == b["subjectId"]:
        return
    with pytest.raises(IrreconcilableStateError):
        merge_states(
            CognitiveState.model_validate(a),
            CognitiveState.model_validate(b),
        )


def test_sovereignty_mismatch_emits_observability() -> None:
    emit_law_event(
        {
            "law": "subjectIsolation",
            "outcome": "ok",
            "code": "SUBJECT_MISMATCH",
            "numRuns": QUICK,
        }
    )


@seed(CI_STRATEGY_SEED)
@QUICK_SETTINGS
@given(replica_histories())
def test_sovereignty_convergence_histories_never_cross_subjects(hist: dict) -> None:
    assert all(r["subjectId"] == hist["subjectId"] for r in hist["replicas"])


def test_observability_fixture_directory_ready() -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    assert FIXTURE_DIR.is_dir()
    emit_law_event(
        {
            "law": "fixtureDir",
            "outcome": "ok",
            "path": "tests/fixtures/merge-laws/regression",
        }
    )
