"""Hypothesis strategies mirroring ``packages/sync-protocol/tests/arbitraries.mjs``.

Side-by-side map (TS → Python)
------------------------------
+----------------------------------+----------------------------------+
| TS (arbitraries.mjs)             | Python (this module)             |
+==================================+==================================+
| ``CI_ARBITRARY_SEED`` / runs     | ``CI_STRATEGY_SEED`` / ``CI_NUM`` |
| ``deviceIdArb``                  | ``device_ids``                   |
| ``subjectIdArb``                 | ``subject_ids``                  |
| ``conceptIdArb``                 | ``concept_ids``                  |
| ``hlcArb``                       | ``hlcs``                         |
| ``equalHlcDifferentDevicesArb``  | ``equal_hlc_different_devices``  |
| ``gCounterShardsArb``            | ``g_counter_shards``             |
| ``conceptMasteryArb``            | ``concept_mastery``              |
| ``frictionSampleArb``            | ``friction_sample``              |
| ``frictionSampleSetArb``         | ``friction_sample_set``          |
| ``frictionLogBoundedArb``        | ``friction_log_bounded``         |
| ``profileArb``                   | ``subject_profile``              |
| ``stateVectorArb``               | ``state_vector``                 |
| ``masteryMapArb``                | ``mastery_map``                  |
| ``cognitiveStateArb``            | ``cognitive_states``             |
| ``replicaPairArb``               | ``replica_pairs``                |
| ``emitArbitraryEvent``           | ``emit_strategy_event``          |
+----------------------------------+----------------------------------+

Every emitted value is intended to pass the Pydantic wire models in
``sutra_orchestrator.contract_models``. Law suites live in .
"""

from __future__ import annotations

import json
import sys
from typing import Any

from hypothesis import strategies as st

from sutra_orchestrator import PROTOCOL_VERSION

CI_STRATEGY_SEED = 0xA01_C0D3
CI_NUM = 10_000

MAX_SHARDS = 8
MAX_FRICTION_SAMPLES = 16
MAX_CONCEPTS = 6

FORBIDDEN_DEVICE_IDS = frozenset(
    {
        "toString",
        "valueOf",
        "constructor",
        "__proto__",
        "hasOwnProperty",
        "toLocaleString",
        "isPrototypeOf",
        "propertyIsEnumerable",
    }
)

GUIDANCE_MODES = (
    "exploratory",
    "guided",
    "reinforcement",
    "prerequisite-remediation",
    "diagnostic",
)
AGE_BANDS = ("child", "adolescent", "adult")
OUTCOMES = ("correct", "partial", "incorrect", "ungraded")

_FINITE_NONNEG = st.floats(0.0, 1e6, allow_nan=False, allow_infinity=False).map(abs)


def emit_strategy_event(event: dict[str, Any]) -> None:
    """Structured observability — never learner content."""
    sys.stdout.write(json.dumps({"event": "crdt.strategy", **event}) + "\n")
    sys.stdout.flush()


def encode_hlc(physical: int, logical: int, device_id: str) -> str:
    return f"{physical:015d}:{logical:06d}:{device_id}"


device_ids = st.from_regex(r"[A-Za-z0-9_-]{4,16}", fullmatch=True).filter(
    lambda d: d not in FORBIDDEN_DEVICE_IDS
)

subject_ids = st.from_regex(r"[a-z][a-z0-9_-]{2,32}", fullmatch=True)

concept_ids = st.from_regex(r"[a-z][a-z0-9._-]{2,24}", fullmatch=True)


@st.composite
def hlcs(draw: st.DrawFn) -> str:
    """Controllable HLC — mirrors ``hlcArb``."""
    # Wire regex is ``\\d{15}``; keep physical within 15 decimal digits.
    physical = draw(st.integers(0, 999_999_999_999_999))
    logical = draw(st.integers(0, 999_999))
    device_id = draw(device_ids)
    return encode_hlc(physical, logical, device_id)


@st.composite
def equal_hlc_different_devices(draw: st.DrawFn) -> dict[str, Any]:
    """Equal physical+logical, different deviceIds — LWW tie surface."""
    physical = draw(st.integers(0, 999_999_999_999_999))
    logical = draw(st.integers(0, 999_999))
    device_a = draw(device_ids)
    device_b = draw(device_ids.filter(lambda d: d != device_a))
    return {
        "physical": physical,
        "logical": logical,
        "a": encode_hlc(physical, logical, device_a),
        "b": encode_hlc(physical, logical, device_b),
        "deviceA": device_a,
        "deviceB": device_b,
    }


@st.composite
def g_counter_shards(
    draw: st.DrawFn,
    *,
    device_pool: list[str] | None = None,
    max_shards: int = MAX_SHARDS,
) -> dict[str, float]:
    """Empty / single / multi G-Counter shard maps — mirrors ``gCounterShardsArb``."""
    if device_pool is not None and len(device_pool) > 0:
        kinds = ["empty", "single"] if len(device_pool) == 1 else ["empty", "single", "multi"]
        kind = draw(st.sampled_from(kinds))
        if kind == "empty":
            return {}
        if kind == "single":
            did = draw(st.sampled_from(device_pool))
            return {did: draw(_FINITE_NONNEG)}
        ids = draw(
            st.lists(
                st.sampled_from(device_pool),
                min_size=2,
                max_size=min(max_shards, len(device_pool)),
                unique=True,
            )
        )
        return {i: draw(_FINITE_NONNEG) for i in ids}

    kind = draw(st.sampled_from(["empty", "single", "multi"]))
    if kind == "empty":
        return {}
    if kind == "single":
        did = draw(device_ids)
        return {did: draw(_FINITE_NONNEG)}
    ids = draw(st.lists(device_ids, min_size=2, max_size=max_shards, unique=True))
    return {i: draw(_FINITE_NONNEG) for i in ids}


@st.composite
def concept_mastery(
    draw: st.DrawFn,
    *,
    concept_id: str | None = None,
    device_pool: list[str] | None = None,
) -> dict[str, Any]:
    cid = concept_id if concept_id is not None else draw(concept_ids)
    if device_pool is not None:
        last = encode_hlc(
            draw(st.integers(0, 999_999_999_999_999)),
            draw(st.integers(0, 999_999)),
            draw(st.sampled_from(device_pool)),
        )
    else:
        last = draw(hlcs())
    return {
        "conceptId": cid,
        "alpha": draw(g_counter_shards(device_pool=device_pool)),
        "beta": draw(g_counter_shards(device_pool=device_pool)),
        "lastExercisedAt": last,
    }


@st.composite
def friction_sample(
    draw: st.DrawFn,
    *,
    captured_at: str | None = None,
    concept_id: str | None = None,
) -> dict[str, Any]:
    return {
        "conceptId": concept_id if concept_id is not None else draw(concept_ids),
        "hesitationMs": draw(st.integers(0, 600_000)),
        "inputVelocity": draw(st.floats(0.0, 500.0, allow_nan=False, allow_infinity=False).map(abs)),
        "revisionCount": draw(st.integers(0, 10_000)),
        "assistanceRequested": draw(st.booleans()),
        "outcome": draw(st.sampled_from(OUTCOMES)),
        "capturedAt": captured_at if captured_at is not None else draw(hlcs()),
    }


@st.composite
def friction_sample_set(
    draw: st.DrawFn,
    *,
    max_samples: int = MAX_FRICTION_SAMPLES,
    collision_bias: bool = True,
) -> list[dict[str, Any]]:
    """Empty / unique / colliding capturedAt — mirrors ``frictionSampleSetArb``."""
    kinds = ["empty", "unique", "colliding"] if collision_bias else ["empty", "unique"]
    kind = draw(st.sampled_from(kinds))
    if kind == "empty":
        return []
    if kind == "unique":
        n = draw(st.integers(1, max_samples))
        stamps = draw(st.lists(hlcs(), min_size=n, max_size=n, unique=True))
        return [draw(friction_sample(captured_at=h)) for h in stamps]
    n = draw(st.integers(2, max(2, min(6, max_samples))))
    shared = draw(hlcs())
    samples = [draw(friction_sample()) for _ in range(n)]
    out: list[dict[str, Any]] = []
    for i, s in enumerate(samples):
        if i < 2 or i % 2 == 0:
            out.append({**s, "capturedAt": shared})
        else:
            out.append(s)
    return out


@st.composite
def friction_log_bounded(
    draw: st.DrawFn,
    *,
    max_samples: int = 6,
    device_id: str = "edge-fric",
) -> list[dict[str, Any]]:
    """Bounded unique-by-construction friction log — mirrors ``frictionLogBoundedArb``."""
    n = draw(st.integers(0, max_samples))
    if n == 0:
        return []
    seed = device_id[:64]
    samples = [draw(friction_sample(captured_at=encode_hlc(0, 0, "edge-seed"))) for _ in range(n)]
    return [
        {**s, "capturedAt": encode_hlc(1_000_000 + i, i, seed)} for i, s in enumerate(samples)
    ]


@st.composite
def subject_profile(draw: st.DrawFn, *, device_id: str | None = None) -> dict[str, Any]:
    updated = (
        draw(hlcs())
        if device_id is None
        else encode_hlc(
            draw(st.integers(0, 999_999_999_999_999)),
            draw(st.integers(0, 999_999)),
            device_id,
        )
    )
    return {
        "ageBand": draw(st.sampled_from(AGE_BANDS)),
        "track": draw(st.from_regex(r"[a-z][a-z0-9-]{2,40}", fullmatch=True)),
        "language": draw(st.sampled_from(("en-IN", "hi-IN", "ta-IN", "en", "hi"))),
        "updatedAt": updated,
    }


@st.composite
def state_vector(
    draw: st.DrawFn,
    *,
    device_id: str | None = None,
    equal_timestamp_bias: bool = True,
) -> dict[str, str]:
    """Plain or adversarial equal-HLC vectors — mirrors ``stateVectorArb``."""
    use_adv = equal_timestamp_bias and draw(st.booleans())
    if use_adv:
        pair = draw(equal_hlc_different_devices())
        return {
            "session": pair["a"],
            "profile": pair["b"],
            f"device:{pair['deviceA']}": pair["a"],
            f"device:{pair['deviceB']}": pair["b"],
        }
    key0 = draw(st.sampled_from(("session", "profile", "mastery", "mode")))
    h0 = (
        draw(hlcs())
        if device_id is None
        else encode_hlc(
            draw(st.integers(0, 999_999_999_999_999)),
            draw(st.integers(0, 999_999)),
            device_id,
        )
    )
    out: dict[str, str] = {key0: h0, "session": h0}
    if draw(st.booleans()):
        extra_key = draw(st.sampled_from(("active", "friction")))
        out[extra_key] = (
            draw(hlcs())
            if device_id is None
            else encode_hlc(
                draw(st.integers(0, 999_999_999_999_999)),
                draw(st.integers(0, 999_999)),
                device_id,
            )
        )
    return out


@st.composite
def mastery_map(
    draw: st.DrawFn,
    *,
    concept_id_list: list[str] | None = None,
    device_pool: list[str] | None = None,
) -> dict[str, Any]:
    if concept_id_list is not None:
        if not concept_id_list:
            return {}
        return {
            cid: draw(concept_mastery(concept_id=cid, device_pool=device_pool))
            for cid in concept_id_list
        }
    kind = draw(st.sampled_from(["empty", "single", "multi"]))
    if kind == "empty":
        return {}
    if kind == "single":
        cid = draw(concept_ids)
        return {cid: draw(concept_mastery(concept_id=cid, device_pool=device_pool))}
    ids = draw(st.lists(concept_ids, min_size=2, max_size=MAX_CONCEPTS, unique=True))
    return {cid: draw(concept_mastery(concept_id=cid, device_pool=device_pool)) for cid in ids}


@st.composite
def cognitive_states(
    draw: st.DrawFn,
    *,
    subject_id: str | None = None,
    device_pool: list[str] | None = None,
    concept_id_list: list[str] | None = None,
    equal_timestamp_bias: bool = True,
    empty_bias: bool = True,
) -> dict[str, Any]:
    """Full CognitiveState dict — mirrors ``cognitiveStateArb``."""
    sid = subject_id if subject_id is not None else draw(subject_ids)
    pool = (
        device_pool
        if device_pool is not None
        else draw(st.lists(device_ids, min_size=1, max_size=MAX_SHARDS, unique=True))
    )
    device_id = draw(st.sampled_from(pool))

    if concept_id_list is not None:
        mastery = draw(mastery_map(concept_id_list=concept_id_list, device_pool=pool))
    elif empty_bias and draw(st.booleans()):
        mastery = {}
    else:
        mastery = draw(mastery_map(device_pool=pool))

    return {
        "protocolVersion": PROTOCOL_VERSION,
        "subjectId": sid,
        "deviceIds": list(pool),
        "activeConceptId": draw(st.one_of(st.none(), concept_ids)),
        "mode": draw(st.sampled_from(GUIDANCE_MODES)),
        "mastery": mastery,
        "frictionLog": draw(friction_log_bounded(max_samples=6, device_id=device_id)),
        "profile": draw(subject_profile(device_id=device_id)),
        "stateVector": draw(
            state_vector(device_id=device_id, equal_timestamp_bias=equal_timestamp_bias)
        ),
    }


@st.composite
def replica_pairs(
    draw: st.DrawFn,
    *,
    overlap: str = "partial",
    equal_timestamp_bias: bool = True,
) -> dict[str, Any]:
    """Same-subject replica pair — mirrors ``replicaPairArb``."""
    assert overlap in ("none", "partial", "full")
    subject_id = draw(subject_ids)
    devices = draw(st.lists(device_ids, min_size=2, max_size=MAX_SHARDS, unique=True))
    concepts = draw(st.lists(concept_ids, min_size=2, max_size=MAX_CONCEPTS, unique=True))
    equal_pair = draw(equal_hlc_different_devices())

    mid = max(1, len(devices) // 2)
    if overlap == "none":
        left_pool = devices[:mid] or [devices[0]]
        right_pool = devices[mid:] or [devices[-1]]
    else:
        left_pool = devices
        right_pool = devices

    if overlap == "none":
        cut = max(1, len(concepts) // 2)
        left_concepts = concepts[:cut]
        right_concepts = concepts[cut:]
    elif overlap == "full":
        left_concepts = concepts
        right_concepts = concepts
    else:
        shared = concepts[: max(1, len(concepts) // 2)]
        left_concepts = concepts[: max(len(shared), len(concepts) - 1)]
        right_concepts = shared + [c for i, c in enumerate(concepts[len(shared) :]) if i % 2 == 0]

    left = draw(
        cognitive_states(
            subject_id=subject_id,
            device_pool=left_pool,
            concept_id_list=left_concepts,
            equal_timestamp_bias=False,
            empty_bias=False,
        )
    )
    right = draw(
        cognitive_states(
            subject_id=subject_id,
            device_pool=right_pool,
            concept_id_list=right_concepts,
            equal_timestamp_bias=False,
            empty_bias=False,
        )
    )
    if equal_timestamp_bias:
        left = {
            **left,
            "stateVector": {**left["stateVector"], "session": equal_pair["a"]},
            "profile": {**left["profile"], "updatedAt": equal_pair["a"]},
        }
        right = {
            **right,
            "stateVector": {**right["stateVector"], "session": equal_pair["b"]},
            "profile": {**right["profile"], "updatedAt": equal_pair["b"]},
        }
    return {"left": left, "right": right, "overlap": overlap, "subjectId": subject_id}
