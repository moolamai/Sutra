"""Dependency-light smoke test: contract models, CRDT merge algebra, and
the graph planner.

Run:  python smoke_test.py   (needs only pydantic)
"""

import sys

sys.path.insert(0, "src")

from sutra_orchestrator.contract_models import (
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
)
from sutra_orchestrator.crdt_merge import merge_states
from sutra_orchestrator.planner import Goal, GraphPlanner, PlanRevisionEvent


def hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


def make_state(device: str, alpha: float, session_ms: int) -> CognitiveState:
    return CognitiveState(
        subjectId="anika-k",
        deviceIds=[device],
        activeConceptId="math.ratios",
        mode="exploratory",
        mastery={
            "math.ratios": ConceptMastery(
                conceptId="math.ratios",
                alpha={device: alpha},
                beta={device: 1.0},
                lastExercisedAt=hlc(session_ms, 0, device),
            )
        },
        frictionLog=[
            FrictionSample(
                conceptId="math.ratios",
                hesitationMs=1200,
                inputVelocity=3.2,
                revisionCount=0,
                assistanceRequested=False,
                outcome="correct",
                capturedAt=hlc(session_ms, 1, device),
            )
        ],
        profile=SubjectProfile(
            ageBand="child",
            track="cbse-class-7-maths",
            language="hi-IN",
            updatedAt=hlc(session_ms, 2, device),
        ),
        stateVector={"session": hlc(session_ms, 3, device)},
    )


a = make_state("edge-aaaa", alpha=3.0, session_ms=1_000_000)
b = make_state("edge-bbbb", alpha=5.0, session_ms=2_000_000)

ab, _ = merge_states(a, b)
ba, _ = merge_states(b, a)
aa, _ = merge_states(a, a)

assert ab.model_dump() == ba.model_dump(), "merge must be commutative"
assert aa.model_dump() == a.model_dump(), "merge must be idempotent"
assert ab.mastery["math.ratios"].alpha == {"edge-aaaa": 3.0, "edge-bbbb": 5.0}
assert len(ab.frictionLog) == 2, "G-Set union must keep both samples"
assert ab.mode == "exploratory" and ab.activeConceptId == "math.ratios"
assert sorted(ab.deviceIds) == ["edge-aaaa", "edge-bbbb"]

# Idempotent re-sync: merging the merged doc with an original changes nothing.
again, advisories = merge_states(ab, a)
assert again.model_dump()["mastery"] == ab.model_dump()["mastery"]
assert any(adv.code == "DUPLICATE_SAMPLE_DROPPED" for adv in advisories)

print("CRDT merge algebra: commutative, idempotent, dedup OK")
print(f"posterior mean after merge: {ab.mastery['math.ratios'].mastery_mean:.3f}")

# Planner: topological composition + invalidating loop-back.
planner = GraphPlanner()
plan = planner.compose(
    [
        Goal("g.advanced", "Advanced topic", prerequisites=("g.basics",)),
        Goal("g.basics", "Foundations", prerequisites=()),
    ],
    context="smoke",
)
assert [s.goal_id for s in plan.steps] == ["g.basics", "g.advanced"], "prerequisites order first"
assert planner.next_step(plan).goal_id == "g.basics"

plan = planner.revise(plan, PlanRevisionEvent(observation="foundation shaky", severity="invalidating"))
assert "looped back" in plan.rationale, "invalidating revision must loop back and say so"
assert planner.next_step(plan) is not None

print("Graph planner: topological order, loop-back revision OK")
