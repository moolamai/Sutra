"""Smoke test: CRDT merge, graph planner, and cloud run_turn with
DeterministicFakeProvider — no network, no API keys.

Run:  python smoke_test.py
"""

import sys

sys.path.insert(0, "src")

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.agent_runtime import AgentRuntime
from sutra_orchestrator.contract_models import (
    AgentTurnRequest,
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
)
from sutra_orchestrator.crdt_merge import merge_states
from sutra_orchestrator.model_provider import DeterministicFakeProvider
from sutra_orchestrator.planner import Goal, GraphPlanner, PlanRevisionEvent
from sutra_orchestrator.sync_service import InMemoryMasterStateStore
from sutra_orchestrator.task_router import TaskRouter, demo_task_graph


def hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


def make_state(device: str, alpha: float, session_ms: int) -> CognitiveState:
    return CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
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

# AgentRuntime.run_turn via DeterministicFakeProvider.
# Reply is model text (not a [directive] stub); plan revise changes fake digest.
smoke_subject = "smoke-subject-7"
smoke_device = "smoke-edge-aaaa"
store = InMemoryMasterStateStore()
store.put(
    CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=smoke_subject,
        deviceIds=[smoke_device],
        activeConceptId="math.ratios",
        mode="exploratory",
        mastery={
            "math.ratios": ConceptMastery(
                conceptId="math.ratios",
                alpha={smoke_device: 2.0},
                beta={smoke_device: 2.0},
                lastExercisedAt=hlc(3_000_000, 0, smoke_device),
            ),
            "math.fractions": ConceptMastery(
                conceptId="math.fractions",
                alpha={smoke_device: 5.0},
                beta={smoke_device: 1.0},
                lastExercisedAt=hlc(3_000_000, 1, smoke_device),
            ),
        },
        frictionLog=[],
        profile=SubjectProfile(
            ageBand="child",
            track="cbse-class-7-maths",
            language="hi-IN",
            updatedAt=hlc(3_000_000, 2, smoke_device),
        ),
        stateVector={"session": hlc(3_000_000, 3, smoke_device)},
    )
)
fake = DeterministicFakeProvider()
runtime = AgentRuntime(
    TaskRouter(demo_task_graph(), redis_url=None),
    store,
    model_provider=fake,
)

smoke_friction = FrictionSample(
    conceptId="math.ratios",
    hesitationMs=900,
    inputVelocity=3.0,
    revisionCount=0,
    assistanceRequested=False,
    outcome="correct",
    capturedAt=hlc(3_000_000, 4, smoke_device),
)
turn_req = AgentTurnRequest(
    protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
    subjectId=smoke_subject,
    sessionId="smoke-sess-1",
    utterance="Explain ratios simply.",
    friction=smoke_friction,
)

reply_a = runtime.run_turn(turn_req)
assert reply_a.reply.startswith("[fake:"), "run_turn must return model text"
assert "[directive]" not in reply_a.reply, "directive stub must be gone"
assert fake.last_prompt is not None
assert "active_step:" in fake.last_prompt
assert "rationale:" in fake.last_prompt
assert "[plan]" in fake.last_prompt
prompt_a = fake.last_prompt

reply_b = runtime.run_turn(
    AgentTurnRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=smoke_subject,
        sessionId="smoke-sess-2",
        utterance="Explain ratios simply.",
        friction=smoke_friction,
    )
)
prompt_b = fake.last_prompt
assert prompt_b is not None and prompt_a != prompt_b, "plan revise must change prompt"
assert reply_a.reply != reply_b.reply, "plan context must change fake output deterministically"
persisted = store.get(smoke_subject)
assert persisted is not None and persisted.activeConceptId == reply_b.nextConceptId

print("Cloud turn: fake provider model text + plan-grounded digests OK")
