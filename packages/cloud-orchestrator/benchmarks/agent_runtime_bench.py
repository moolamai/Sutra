"""Python AgentRuntime.run_turn overhead — DeterministicFakeProvider (zero-sleep).

Measures cloud turn-handler composition (router + planner bind + fake generate),
not remote LLM latency. Subject-scoped; never emits utterance bodies.
"""

from __future__ import annotations

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.agent_runtime import AgentRuntime
from sutra_orchestrator.contract_models import (
    AgentTurnRequest,
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
)
from sutra_orchestrator.model_provider import DeterministicFakeProvider
from sutra_orchestrator.sync_service import InMemoryMasterStateStore
from sutra_orchestrator.task_router import TaskRouter, demo_task_graph

from .harness import BENCH_DEVICE_ID, BENCH_SUBJECT_ID, bench


def _hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


def _seed_state(subject_id: str, device: str = "edge-bench") -> CognitiveState:
    return CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        deviceIds=[device],
        activeConceptId="math.ratios",
        mode="exploratory",
        mastery={
            "math.ratios": ConceptMastery(
                conceptId="math.ratios",
                alpha={device: 2.0},
                beta={device: 2.0},
                lastExercisedAt=_hlc(1_700_000_000_000, 0, device),
            ),
            "math.fractions": ConceptMastery(
                conceptId="math.fractions",
                alpha={device: 5.0},
                beta={device: 1.0},
                lastExercisedAt=_hlc(1_700_000_000_000, 1, device),
            ),
        },
        frictionLog=[],
        profile=SubjectProfile(
            ageBand="child",
            track="cbse-class-7-maths",
            language="hi-IN",
            updatedAt=_hlc(1_700_000_000_000, 2, device),
        ),
        stateVector={"session": _hlc(1_700_000_000_000, 3, device)},
    )


def _friction() -> FrictionSample:
    return FrictionSample(
        conceptId="math.ratios",
        hesitationMs=500,
        inputVelocity=2.5,
        revisionCount=0,
        assistanceRequested=False,
        outcome="correct",
        capturedAt=_hlc(1_700_000_000_100, 0, "edge-bench"),
    )


def build_runtime(subject_id: str = BENCH_SUBJECT_ID) -> AgentRuntime:
    store = InMemoryMasterStateStore()
    store.put(_seed_state(subject_id))
    return AgentRuntime(
        TaskRouter(demo_task_graph(), redis_url=None),
        store,
        model_provider=DeterministicFakeProvider(),
    )


def run() -> None:
    subject_id = BENCH_SUBJECT_ID
    rt = build_runtime(subject_id)
    friction = _friction()
    # Warm path used for timed iterations — same request shape, fresh session id.
    counter = {"n": 0}

    def _once() -> None:
        counter["n"] += 1
        req = AgentTurnRequest(
            protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
            subjectId=subject_id,
            sessionId=f"bench-sess-{counter['n']}",
            utterance="benchmark utterance",
            friction=friction,
        )
        resp = rt.run_turn(req)
        if not resp.nextConceptId:
            raise RuntimeError("agent_runtime bench: missing nextConceptId")
        if not resp.reply or "[directive]" in resp.reply:
            raise RuntimeError("agent_runtime bench: unexpected reply shape")

    bench(
        "py agent_runtime run_turn (fake provider)",
        _once,
        warmup=15,
        iterations=80,
        subject_id=subject_id,
        device_id=BENCH_DEVICE_ID,
    )


if __name__ == "__main__":
    run()
