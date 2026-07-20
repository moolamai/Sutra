"""Replace directive stub with provider invocation in run_turn.

"""

from __future__ import annotations

import pytest

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.agent_runtime import AgentRuntime
from sutra_orchestrator.contract_models import (
    AgentTurnRequest,
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
)
from sutra_orchestrator.model_provider import (
    MODEINVO_MUST_TURN,
    DeterministicFakeProvider,
    ModelProviderConfigError,
    ModelProviderEmptyError,
    assemble_turn_prompt,
    default_charter_for_profile,
    run_model_provider_conformance,
)
from sutra_orchestrator.planner import (
    Goal,
    GraphPlanner,
    assert_plan_bound_in_turn_context,
)
from sutra_orchestrator.sync_service import InMemoryMasterStateStore
from sutra_orchestrator.task_router import TaskRouter, demo_task_graph
from sutra_orchestrator.trajectory_capture import CloudTrajectoryHookResult


def hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


def make_state(subject_id: str) -> CognitiveState:
    device = "cloud-mi-a"
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
                lastExercisedAt=hlc(1_700_000_000_000, 0, device),
            ),
            "math.fractions": ConceptMastery(
                conceptId="math.fractions",
                alpha={device: 5.0},
                beta={device: 1.0},
                lastExercisedAt=hlc(1_700_000_000_000, 1, device),
            ),
        },
        frictionLog=[],
        profile=SubjectProfile(
            ageBand="child",
            track="cbse-class-7-maths",
            language="hi-IN",
            updatedAt=hlc(1_700_000_000_000, 2, device),
        ),
        stateVector={"session": hlc(1_700_000_000_000, 3, device)},
    )


def friction() -> FrictionSample:
    return FrictionSample(
        conceptId="math.ratios",
        hesitationMs=800,
        inputVelocity=3.0,
        revisionCount=0,
        assistanceRequested=False,
        outcome="correct",
        capturedAt=hlc(1_700_000_000_100, 0, "edge-mi"),
    )


def turn_request(subject_id: str, utterance: str = "SECRET_MI_UTTERANCE") -> AgentTurnRequest:
    return AgentTurnRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        sessionId="sess-mi",
        utterance=utterance,
        friction=friction(),
    )


class SpyTrajectoryHook:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def capture_after_reflect(self, **kwargs: object) -> CloudTrajectoryHookResult:
        self.calls.append(dict(kwargs))
        return CloudTrajectoryHookResult(
            captured=True,
            subject_id=str(kwargs["subject_id"]),
            turn_id="turn-spy",
        )


class RaisingTrajectoryHook(SpyTrajectoryHook):
    def capture_after_reflect(self, **kwargs: object) -> CloudTrajectoryHookResult:
        raise RuntimeError("capture hook unavailable")


def runtime(
    subject_id: str,
    provider: DeterministicFakeProvider | None = None,
    trajectory_hook: SpyTrajectoryHook | None = None,
) -> AgentRuntime:
    store = InMemoryMasterStateStore()
    store.put(make_state(subject_id))
    return AgentRuntime(
        TaskRouter(demo_task_graph(), redis_url=None),
        store,
        model_provider=provider or DeterministicFakeProvider(),
        trajectory_capture_hook=trajectory_hook,
    )


def test_conformance_suite_still_100_percent_against_fake() -> None:
    report = run_model_provider_conformance(
        DeterministicFakeProvider(),
        subject_id="subj-mi-conf",
    )
    assert report.exit_code == 0
    assert report.passed_count == len(report.verdicts)


def test_happy_path_run_turn_returns_model_text_not_directive_stub() -> None:
    fake = DeterministicFakeProvider()
    rt = runtime("subj-mi-happy", fake)
    resp = rt.run_turn(turn_request("subj-mi-happy"))
    assert resp.reply.startswith("[fake:deterministic-fake]")
    assert not resp.reply.startswith("[directive]")
    assert "[directive]" not in resp.reply
    assert fake.last_prompt is not None
    assert "active_step:" in fake.last_prompt
    assert "rationale:" in fake.last_prompt
    plan = rt.get_active_plan("subj-mi-happy")
    assert plan is not None
    assert_plan_bound_in_turn_context(context=fake.last_prompt, plan=plan)
    assert MODEINVO_MUST_TURN  # obligation text is loaded


def test_prompt_includes_plan_active_step_and_routing_rationale() -> None:
    plan = GraphPlanner().compose(
        [Goal("g1", "work", prerequisites=())],
        context="mi",
    )
    prompt = assemble_turn_prompt(
        charter=default_charter_for_profile(
            track="math", language="en", age_band="adult"
        ),
        age_band="adult",
        track="math",
        language="en",
        mode="guided",
        guidance_directive="GUIDE concept='X' mode=guided",
        routing_rationale="friction → nominal | continue",
        plan=plan,
        utterance="hello",
    )
    assert "[plan]" in prompt
    assert f"plan_id={plan.plan_id}" in prompt
    assert "active_step: s1:" in prompt
    assert "rationale: friction → nominal | continue" in prompt
    assert "### system" in prompt
    assert "### user" in prompt
    assert_plan_bound_in_turn_context(context=prompt, plan=plan)


def test_edge_provider_timeout_returns_directive_degraded_not_raise() -> None:
    rt = runtime("subj-mi-to", DeterministicFakeProvider(force_timeout=True))
    resp = rt.run_turn(turn_request("subj-mi-to"))
    assert resp.degraded is True
    assert resp.reply.startswith("GUIDE concept=")
    assert resp.routingRationale
    assert resp.freshnessMarker is not None
    assert resp.freshnessMarker.source == "last-known-good"
    # Durable persist happened before generate — routing fields survive.
    state = rt.get_state("subj-mi-to")
    assert state is not None
    assert state.activeConceptId is not None


def test_edge_empty_provider_output_typed_error() -> None:
    rt = runtime("subj-mi-empty", DeterministicFakeProvider(force_empty=True))
    with pytest.raises(ModelProviderEmptyError):
        rt.run_turn(turn_request("subj-mi-empty"))


def test_edge_missing_provider_fail_fast_at_construction() -> None:
    store = InMemoryMasterStateStore()
    with pytest.raises(ModelProviderConfigError):
        AgentRuntime(
            TaskRouter(demo_task_graph(), redis_url=None),
            store,
            require_model_provider_binding=True,
        )


def test_sovereignty_utterance_not_echoed_in_model_reply() -> None:
    secret = "SECRET_MI_UTTERANCE_MUST_NOT_LEAK"
    fake = DeterministicFakeProvider()
    rt = runtime("subj-mi-sov", fake)
    resp = rt.run_turn(turn_request("subj-mi-sov", utterance=secret))
    assert secret not in resp.reply
    # Prompt may contain utterance for the model; reply digest never does.
    assert fake.last_prompt is not None
    assert secret in fake.last_prompt


def test_plan_context_change_changes_fake_digest() -> None:
    fake = DeterministicFakeProvider()
    rt = runtime("subj-mi-plan", fake)
    r1 = rt.run_turn(turn_request("subj-mi-plan", utterance="turn-one"))
    p1 = fake.last_prompt
    r2 = rt.run_turn(turn_request("subj-mi-plan", utterance="turn-one"))
    p2 = fake.last_prompt
    assert p1 is not None and p2 is not None
    # Second turn revises plan rationale → prompt/digest/reply move.
    assert p1 != p2
    assert r1.reply != r2.reply


def test_cloud_runtime_invokes_capture_only_after_completed_response() -> None:
    hook = SpyTrajectoryHook()
    rt = runtime("subj-mi-hook", trajectory_hook=hook)
    response = rt.run_turn(turn_request("subj-mi-hook"))

    assert len(hook.calls) == 1
    call = hook.calls[0]
    assert call["subject_id"] == "subj-mi-hook"
    assert call["reply"] == response.reply
    assert "active_step:" in str(call["prompt"])
    assert call["captured_at"] == friction().capturedAt

    failed_hook = SpyTrajectoryHook()
    failed = runtime(
        "subj-mi-hook-failed",
        DeterministicFakeProvider(force_empty=True),
        failed_hook,
    )
    with pytest.raises(ModelProviderEmptyError):
        failed.run_turn(turn_request("subj-mi-hook-failed"))
    assert failed_hook.calls == []

    hook_failure = runtime(
        "subj-mi-hook-error",
        trajectory_hook=RaisingTrajectoryHook(),
    )
    response_after_hook_failure = hook_failure.run_turn(
        turn_request("subj-mi-hook-error")
    )
    assert response_after_hook_failure.reply
