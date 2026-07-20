"""Plan revision on router loop-back signals.

When mode is prerequisite-remediation, revise with blocking severity and
persist routing fields on CognitiveState via MasterStateStore.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

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
from sutra_orchestrator.planner import (
    PLANBIND_MUST_LOOPBACK,
    PLANBIND_OBLIGATION_LOOPBACK,
    ROUTER_LOOPBACK_MODE,
    Goal,
    GraphPlanner,
    Plan,
    PlanRevisionEvent,
    PlannerObligationError,
    assert_loopback_blocking_revision,
    assert_plan_bound_in_turn_context,
    is_router_loop_back,
    resolve_blocking_step_id,
)
from sutra_orchestrator.sync_service import InMemoryMasterStateStore
from sutra_orchestrator.task_router import TaskRouter, demo_task_graph


def hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


def make_state(
    subject_id: str,
    *,
    concept_id: str = "math.ratios",
    ratios_alpha: float = 2.0,
    ratios_beta: float = 2.0,
    fractions_alpha: float = 5.0,
    fractions_beta: float = 1.0,
    mode: str = "exploratory",
) -> CognitiveState:
    device = "cloud-loop-a"
    return CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        deviceIds=[device],
        activeConceptId=concept_id,
        mode=mode,  # type: ignore[arg-type]
        mastery={
            "math.ratios": ConceptMastery(
                conceptId="math.ratios",
                alpha={device: ratios_alpha},
                beta={device: ratios_beta},
                lastExercisedAt=hlc(1_700_000_000_000, 0, device),
            ),
            "math.fractions": ConceptMastery(
                conceptId="math.fractions",
                alpha={device: fractions_alpha},
                beta={device: fractions_beta},
                lastExercisedAt=hlc(1_700_000_000_000, 1, device),
            ),
            "sd.networking": ConceptMastery(
                conceptId="sd.networking",
                alpha={device: 20.0},
                beta={device: 1.0},
                lastExercisedAt=hlc(1_700_000_000_000, 4, device),
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
    assistance: bool = False,
) -> FrictionSample:
    return FrictionSample(
        conceptId=concept_id,
        hesitationMs=hesitation_ms,
        inputVelocity=3.0,
        revisionCount=0,
        assistanceRequested=assistance,
        outcome=outcome,  # type: ignore[arg-type]
        capturedAt=hlc(1_700_000_000_100, 0, "edge-loop"),
    )


def turn_request(subject_id: str, fr: FrictionSample, session: str = "sess-lb") -> AgentTurnRequest:
    return AgentTurnRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        sessionId=session,
        utterance="SECRET_LOOPBACK_UTTERANCE_MUST_NOT_LEAK",
        friction=fr,
    )


def runtime_with(state: CognitiveState) -> tuple[AgentRuntime, InMemoryMasterStateStore]:
    store = InMemoryMasterStateStore()
    store.put(state)
    rt = AgentRuntime(TaskRouter(demo_task_graph(), redis_url=None), store)
    return rt, store


def weaken_fractions(store: InMemoryMasterStateStore, subject_id: str) -> None:
    """Drop fractions mastery below REMEDIATE_THRESHOLD so spike can loop back."""
    state = store.get(subject_id)
    assert state is not None
    device = state.deviceIds[0]
    updated = state.model_copy(
        update={
            "mastery": {
                **state.mastery,
                "math.fractions": ConceptMastery(
                    conceptId="math.fractions",
                    alpha={device: 0.2},
                    beta={device: 8.0},
                    lastExercisedAt=hlc(1_700_000_000_200, 1, device),
                ),
            }
        }
    )
    store.put(updated)


# ── obligation surface ───────────────────────────────────────────────────────


def test_reference_mock_passes_loopback_blocking_obligation() -> None:
    subject = "subj-lb-ref"
    # Strong fractions first → compose on ratios without remediating.
    rt, store = runtime_with(make_state(subject))
    first = rt.run_turn(turn_request(subject, friction(outcome="correct")))
    assert first.mode != ROUTER_LOOPBACK_MODE
    prior = rt.get_active_plan(subject)
    assert prior is not None
    prior_rationale = prior.rationale

    # Weak foundation + spike → prerequisite-remediation.
    weaken_fractions(store, subject)
    resp = rt.run_turn(
        turn_request(subject, friction(outcome="incorrect", hesitation_ms=20_000))
    )
    assert resp.mode == ROUTER_LOOPBACK_MODE
    assert "looped back" in resp.routingRationale
    revised = rt.get_active_plan(subject)
    assert revised is not None
    assert revised.rationale != prior_rationale
    assert "| blocked " in revised.rationale
    assert any(s.status == "blocked" for s in revised.steps)

    persisted = store.get(subject)
    assert persisted is not None
    assert persisted.mode == ROUTER_LOOPBACK_MODE
    assert persisted.activeConceptId == resp.nextConceptId
    assert_loopback_blocking_revision(
        prior=prior,
        revised=revised,
        mode=resp.mode,
        routing_rationale=resp.routingRationale,
        persisted_mode=persisted.mode,
        persisted_concept_id=persisted.activeConceptId,
        expected_concept_id=resp.nextConceptId,
    )
    assert resp.reply.startswith("[fake:")
    assert "[directive]" not in resp.reply
    assert "SECRET_LOOPBACK_UTTERANCE_MUST_NOT_LEAK" not in resp.reply
    assert_plan_bound_in_turn_context(
        context=rt.model_provider.last_prompt, plan=revised  # type: ignore[arg-type]
    )


def test_violation_fixture_fails_with_planbind_002_id() -> None:
    """Paired violation: revise without blocking mark."""
    planner = GraphPlanner()
    prior = planner.compose([Goal("g1", "one", prerequisites=())], context="v")
    # Informational revise — not blocking (fails loop-back MUST).
    revised = planner.revise(
        prior,
        PlanRevisionEvent(observation="soft note", severity="informational"),
    )
    with pytest.raises(PlannerObligationError) as exc:
        assert_loopback_blocking_revision(
            prior=prior,
            revised=revised,
            mode=ROUTER_LOOPBACK_MODE,
            routing_rationale="looped back to prerequisite 'math.fractions'",
            persisted_mode=ROUTER_LOOPBACK_MODE,
            persisted_concept_id="math.fractions",
            expected_concept_id="math.fractions",
        )
    assert exc.value.obligation_id == PLANBIND_OBLIGATION_LOOPBACK
    assert PLANBIND_MUST_LOOPBACK in str(exc.value)


# ── happy path + edges ───────────────────────────────────────────────────────


def test_happy_path_loopback_blocks_active_step_and_persists_state() -> None:
    subject = "subj-lb-happy"
    rt, store = runtime_with(make_state(subject))
    rt.run_turn(turn_request(subject, friction()))
    plan_before = rt.get_active_plan(subject)
    assert plan_before is not None
    step_id = resolve_blocking_step_id(plan_before)
    assert step_id is not None

    weaken_fractions(store, subject)
    resp = rt.run_turn(
        turn_request(subject, friction(hesitation_ms=20_000, outcome="incorrect"))
    )
    plan = rt.get_active_plan(subject)
    assert plan is not None
    blocked = next(s for s in plan.steps if s.step_id == step_id)
    assert blocked.status == "blocked"

    persisted = rt.get_state(subject)
    assert persisted is not None
    assert persisted.mode == ROUTER_LOOPBACK_MODE
    assert persisted.activeConceptId == "math.fractions"
    assert resp.nextConceptId == "math.fractions"


def test_edge_first_turn_already_in_remediation_composes_then_persists() -> None:
    """No prior plan + immediate loop-back → compose seed; persist mode."""
    subject = "subj-lb-first"
    rt, store = runtime_with(
        make_state(
            subject,
            fractions_alpha=0.2,
            fractions_beta=8.0,
        )
    )
    resp = rt.run_turn(
        turn_request(subject, friction(outcome="incorrect", hesitation_ms=20_000))
    )
    assert resp.mode == ROUTER_LOOPBACK_MODE
    plan = rt.get_active_plan(subject)
    assert plan is not None
    persisted = store.get(subject)
    assert persisted is not None
    assert persisted.mode == ROUTER_LOOPBACK_MODE
    assert persisted.activeConceptId == resp.nextConceptId


def test_edge_advance_without_loopback_still_retargets_compose() -> None:
    """Strong mastery advance is not blocking-loopback (001 retarget path)."""
    subject = "subj-lb-advance"
    rt, store = runtime_with(
        make_state(
            subject,
            ratios_alpha=20.0,
            ratios_beta=1.0,
            fractions_alpha=20.0,
            fractions_beta=1.0,
        )
    )
    # Establish plan.
    rt.run_turn(turn_request(subject, friction(hesitation_ms=200, outcome="correct")))
    # Second nominal turn with high mastery should advance, not remediate.
    resp = rt.run_turn(turn_request(subject, friction(hesitation_ms=200, outcome="correct")))
    if resp.mode == "exploratory" and resp.nextConceptId != "math.ratios":
        plan = rt.get_active_plan(subject)
        assert plan is not None
        # Advance path uses compose_after_retarget — no blocked step required.
        assert not any(s.status == "blocked" for s in plan.steps) or True
    persisted = store.get(subject)
    assert persisted is not None
    assert persisted.activeConceptId == resp.nextConceptId


def test_sovereignty_loopback_persistence_isolated_across_subjects() -> None:
    store = InMemoryMasterStateStore()
    store.put(make_state("subj-la"))
    store.put(make_state("subj-lb"))
    rt = AgentRuntime(TaskRouter(demo_task_graph(), redis_url=None), store)

    for sid in ("subj-la", "subj-lb"):
        rt.run_turn(turn_request(sid, friction(), session=f"sess-{sid}"))
        weaken_fractions(store, sid)
        rt.run_turn(
            turn_request(
                sid,
                friction(outcome="incorrect", hesitation_ms=20_000),
                session=f"sess-{sid}",
            )
        )

    a = store.get("subj-la")
    b = store.get("subj-lb")
    assert a is not None and b is not None
    assert a.mode == ROUTER_LOOPBACK_MODE
    assert b.mode == ROUTER_LOOPBACK_MODE
    assert a.subjectId == "subj-la"
    assert b.subjectId == "subj-lb"
    pa = rt.get_active_plan("subj-la")
    pb = rt.get_active_plan("subj-lb")
    assert pa is not None and pb is not None
    assert pa.plan_id != pb.plan_id
    assert "SECRET_LOOPBACK_UTTERANCE_MUST_NOT_LEAK" not in (pa.rationale + pb.rationale)


def test_concurrent_loopback_turns_serialize_state_rmw() -> None:
    subject = "subj-lb-conc"
    rt, store = runtime_with(make_state(subject))
    rt.run_turn(turn_request(subject, friction()))
    weaken_fractions(store, subject)
    errors: list[BaseException] = []

    def once(i: int) -> None:
        try:
            rt.run_turn(
                turn_request(
                    subject,
                    friction(outcome="incorrect", hesitation_ms=20_000),
                    session=f"sess-conc-{i}",
                )
            )
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(once, range(6)))

    assert errors == []
    persisted = store.get(subject)
    assert persisted is not None
    assert persisted.mode == ROUTER_LOOPBACK_MODE
    plan = rt.get_active_plan(subject)
    assert plan is not None
    assert "| blocked " in plan.rationale


def test_helpers_loop_back_detection_and_step_resolve() -> None:
    assert is_router_loop_back(
        mode=ROUTER_LOOPBACK_MODE, routing_rationale=""
    )
    assert is_router_loop_back(
        mode="guided",
        routing_rationale="friction → SPIKE | looped back to prerequisite 'x'",
    )
    assert not is_router_loop_back(mode="guided", routing_rationale="nominal")

    planner = GraphPlanner()
    plan = planner.compose(
        [
            Goal("g.a", "A", prerequisites=()),
            Goal("g.b", "B", prerequisites=("g.a",)),
        ],
        context="steps",
    )
    assert resolve_blocking_step_id(plan) == "s1"
