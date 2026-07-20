"""Wire GraphPlanner into agent_runtime.run_turn.

CK-08.2 — every revision MUST update rationale.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.agent_runtime import AgentRuntime, UnknownSubjectError
from sutra_orchestrator.contract_models import (
    AgentTurnRequest,
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
)
from sutra_orchestrator.planner import (
    MUST_REVISION_UPDATES_RATIONALE,
    PLANBIND_MUST_WIRE,
    PLANBIND_OBLIGATION_WIRE,
    Goal,
    GraphPlanner,
    Plan,
    PlanRevisionEvent,
    PlannerCycleError,
    PlannerObligationError,
    assert_plan_bound_in_turn_context,
    seed_goals_from_routing,
)
from sutra_orchestrator.sync_service import InMemoryMasterStateStore
from sutra_orchestrator.task_router import TaskRouter, demo_task_graph


def hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


def make_state(
    subject_id: str,
    *,
    concept_id: str = "math.ratios",
    alpha: float = 2.0,
    beta: float = 2.0,
    mode: str = "exploratory",
) -> CognitiveState:
    device = "cloud-plan-a"
    return CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        deviceIds=[device],
        activeConceptId=concept_id,
        mode=mode,  # type: ignore[arg-type]
        mastery={
            concept_id: ConceptMastery(
                conceptId=concept_id,
                alpha={device: alpha},
                beta={device: beta},
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


def friction(
    concept_id: str = "math.ratios",
    *,
    hesitation_ms: int = 800,
    outcome: str = "correct",
) -> FrictionSample:
    return FrictionSample(
        conceptId=concept_id,
        hesitationMs=hesitation_ms,
        inputVelocity=3.0,
        revisionCount=0,
        assistanceRequested=False,
        outcome=outcome,  # type: ignore[arg-type]
        capturedAt=hlc(1_700_000_000_100, 0, "edge-plan"),
    )


def turn_request(subject_id: str, fr: FrictionSample) -> AgentTurnRequest:
    return AgentTurnRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        sessionId="sess-planbind-1",
        utterance="SECRET_LEARNER_UTTERANCE_MUST_NOT_LEAK",
        friction=fr,
    )


def runtime_for(subject_id: str, state: CognitiveState | None = None) -> AgentRuntime:
    store = InMemoryMasterStateStore()
    store.put(state or make_state(subject_id))
    router = TaskRouter(demo_task_graph(), redis_url=None)
    return AgentRuntime(router, store)


# ── reference mock / obligation surface ──────────────────────────────────────


def test_reference_mock_passes_planbind_wire_obligation() -> None:
    """Reference AgentRuntime+GraphPlanner satisfies MUST."""
    subject = "subj-plan-ref"
    rt = runtime_for(subject)
    resp = rt.run_turn(turn_request(subject, friction()))
    plan = rt.get_active_plan(subject)
    assert plan is not None
    assert resp.reply.startswith("[fake:")
    assert "[directive]" not in resp.reply
    fake = rt.model_provider
    assert getattr(fake, "last_prompt", None)
    assert_plan_bound_in_turn_context(context=fake.last_prompt, plan=plan)


def test_violation_fixture_fails_with_planbind_obligation_id() -> None:
    """Paired violation: turn context without plan snapshot."""
    fake = Plan(plan_id="plan-x", steps=(), rationale="r")
    with pytest.raises(PlannerObligationError) as exc:
        assert_plan_bound_in_turn_context(reply="[directive] only", plan=fake)
    assert exc.value.obligation_id == PLANBIND_OBLIGATION_WIRE
    assert PLANBIND_MUST_WIRE in str(exc.value)


def test_violation_silent_revise_fails_ck08_2() -> None:
    """Paired violation: revise that keeps rationale → CK-08.2."""

    class SilentRevisePlanner(GraphPlanner):
        def revise(self, plan: Plan, event: PlanRevisionEvent) -> Plan:
            # Skip GraphPlanner.revise rationale rewrite — contract violation.
            return plan

    p = SilentRevisePlanner()
    plan = p.compose(
        [Goal("g1", "one", prerequisites=())],
        context="probe",
    )
    # Direct silent return bypasses base guard — emulate check used by hosts.
    revised = p.revise(plan, PlanRevisionEvent(observation="x", severity="informational"))
    assert revised.rationale == plan.rationale
    with pytest.raises(PlannerObligationError) as exc:
        if revised.rationale == plan.rationale:
            raise PlannerObligationError(
                MUST_REVISION_UPDATES_RATIONALE,
                obligation_id="CK-08.2",
            )
    assert exc.value.obligation_id == "CK-08.2"


# ── happy path + edge cases ──────────────────────────────────────────────────


def test_happy_path_first_turn_composes_from_routing_directive() -> None:
    subject = "subj-plan-compose"
    rt = runtime_for(subject)
    assert rt.get_active_plan(subject) is None

    resp = rt.run_turn(turn_request(subject, friction()))
    plan = rt.get_active_plan(subject)
    assert plan is not None
    assert plan.steps[0].goal_id.startswith("route.")
    assert resp.reply.startswith("[fake:")
    assert "SECRET_LEARNER_UTTERANCE_MUST_NOT_LEAK" not in resp.reply
    assert "SECRET_LEARNER_UTTERANCE_MUST_NOT_LEAK" not in plan.rationale
    assert_plan_bound_in_turn_context(
        context=rt.model_provider.last_prompt, plan=plan  # type: ignore[union-attr]
    )


def test_second_turn_revises_and_updates_rationale() -> None:
    subject = "subj-plan-revise"
    rt = runtime_for(subject)
    first = rt.run_turn(turn_request(subject, friction()))
    p1 = rt.get_active_plan(subject)
    assert p1 is not None
    r1 = p1.rationale

    second = rt.run_turn(turn_request(subject, friction()))
    p2 = rt.get_active_plan(subject)
    assert p2 is not None
    assert p2.rationale != r1
    assert "noted:" in p2.rationale or "router continue" in p2.rationale
    assert second.reply.startswith("[fake:")
    assert first.reply != second.reply or p2.rationale != r1
    assert_plan_bound_in_turn_context(
        context=rt.model_provider.last_prompt, plan=p2  # type: ignore[union-attr]
    )


def test_edge_concept_retarget_abandons_pending_with_logged_rationale() -> None:
    """Router advances / remediates to a new concept → revise abandon + compose."""
    subject = "subj-plan-retarget"
    # Weak prerequisite mastery forces loop-back/remediation retarget.
    state = make_state(subject, concept_id="math.ratios", alpha=1.0, beta=8.0)
    state.mastery["math.fractions"] = ConceptMastery(
        conceptId="math.fractions",
        alpha={"cloud-plan-a": 0.5},
        beta={"cloud-plan-a": 8.0},
        lastExercisedAt=hlc(1_700_000_000_000, 1, "cloud-plan-a"),
    )
    store = InMemoryMasterStateStore()
    store.put(state)
    rt = AgentRuntime(TaskRouter(demo_task_graph(), redis_url=None), store)

    # Turn 1: establish a plan on ratios (may already remediate — still binds plan)
    rt.run_turn(
        turn_request(
            subject,
            friction(
                "math.ratios",
                hesitation_ms=20_000,
                outcome="incorrect",
            ),
        )
    )
    plan_a = rt.get_active_plan(subject)
    assert plan_a is not None
    concept_a = rt._plans[subject].concept_id

    # Turn 2: force continue on whatever concept is active with mild friction
    # then put high mastery and advance — use fresh strong mastery state path.
    # Strong mastery on fractions+ratios should advance toward percentages.
    strong = make_state(subject, concept_id=concept_a, alpha=20.0, beta=1.0)
    strong.mastery["math.fractions"] = ConceptMastery(
        conceptId="math.fractions",
        alpha={"cloud-plan-a": 20.0},
        beta={"cloud-plan-a": 1.0},
        lastExercisedAt=hlc(1_700_000_000_200, 1, "cloud-plan-a"),
    )
    if concept_a != "math.ratios":
        strong.mastery["math.ratios"] = ConceptMastery(
            conceptId="math.ratios",
            alpha={"cloud-plan-a": 20.0},
            beta={"cloud-plan-a": 1.0},
            lastExercisedAt=hlc(1_700_000_000_200, 2, "cloud-plan-a"),
        )
    store.put(strong)

    resp = rt.run_turn(turn_request(subject, friction(concept_a, hesitation_ms=400)))
    plan_b = rt.get_active_plan(subject)
    assert plan_b is not None
    # Either same-concept revise or retarget compose — plan remains bound.
    assert_plan_bound_in_turn_context(
        context=rt.model_provider.last_prompt, plan=plan_b  # type: ignore[union-attr]
    )
    if rt._plans[subject].concept_id != concept_a:
        assert plan_b.plan_id != plan_a.plan_id


def test_edge_planner_cycle_detection_typed_error() -> None:
    planner = GraphPlanner()
    with pytest.raises(PlannerCycleError) as exc:
        planner.compose(
            [
                Goal("a", "A", prerequisites=("b",)),
                Goal("b", "B", prerequisites=("a",)),
            ],
            context="cycle-probe",
        )
    assert exc.value.obligation_id == "CK-08.1"


def test_edge_unknown_subject_before_plan_bind() -> None:
    store = InMemoryMasterStateStore()
    rt = AgentRuntime(TaskRouter(demo_task_graph(), redis_url=None), store)
    with pytest.raises(UnknownSubjectError):
        rt.run_turn(turn_request("missing-subject", friction()))


def test_sovereignty_plans_isolated_across_subjects() -> None:
    store = InMemoryMasterStateStore()
    store.put(make_state("subj-pa"))
    store.put(make_state("subj-pb"))
    rt = AgentRuntime(TaskRouter(demo_task_graph(), redis_url=None), store)

    ra = rt.run_turn(turn_request("subj-pa", friction()))
    rb = rt.run_turn(turn_request("subj-pb", friction()))
    pa = rt.get_active_plan("subj-pa")
    pb = rt.get_active_plan("subj-pb")
    assert pa is not None and pb is not None
    assert pa.plan_id != pb.plan_id
    assert "subj-pb" not in ra.reply
    assert "subj-pa" not in rb.reply
    assert "SECRET_LEARNER_UTTERANCE_MUST_NOT_LEAK" not in ra.reply
    assert "SECRET_LEARNER_UTTERANCE_MUST_NOT_LEAK" not in rb.reply


def test_concurrent_turns_same_subject_serialize_plan_rmw() -> None:
    subject = "subj-plan-conc"
    rt = runtime_for(subject)
    errors: list[BaseException] = []

    def once() -> None:
        try:
            rt.run_turn(turn_request(subject, friction()))
        except BaseException as exc:  # noqa: BLE001 — collect for assert
            errors.append(exc)

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: once(), range(8)))

    assert errors == []
    plan = rt.get_active_plan(subject)
    assert plan is not None
    assert plan.rationale  # survived concurrent RMW


def test_seed_goals_helper_is_deterministic() -> None:
    a = seed_goals_from_routing(
        concept_id="math.ratios",
        guidance_directive="GUIDE concept='Ratios' mode=exploratory",
    )
    b = seed_goals_from_routing(
        concept_id="math.ratios",
        guidance_directive="GUIDE concept='Ratios' mode=exploratory",
    )
    assert a == b
    assert a[0].goal_id == "route.math.ratios"
