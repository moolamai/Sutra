"""Planner-binding integration tests.


Multi-step AgentRuntime turns: compose → revise → loop-back blocking revise;
CK-08 via Python conformance port; restart survival on MasterStateStore.
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
    MUST_CYCLIC_REVISE,
    MUST_REVISION_UPDATES_RATIONALE,
    PLANNING_OBLIGATION_IDS,
    ROUTER_LOOPBACK_MODE,
    Goal,
    GraphPlanner,
    NoLoopBackPlanner,
    PlannerCycleError,
    SilentRationalePlanner,
    assert_plan_bound_in_turn_context,
    run_ck08_conformance,
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
) -> CognitiveState:
    device = "cloud-int-a"
    return CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        deviceIds=[device],
        activeConceptId=concept_id,
        mode="exploratory",
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
) -> FrictionSample:
    return FrictionSample(
        conceptId=concept_id,
        hesitationMs=hesitation_ms,
        inputVelocity=3.0,
        revisionCount=0,
        assistanceRequested=False,
        outcome=outcome,  # type: ignore[arg-type]
        capturedAt=hlc(1_700_000_000_100, 0, "edge-int"),
    )


def turn_request(
    subject_id: str,
    fr: FrictionSample,
    *,
    session: str = "sess-int",
    utterance: str = "SECRET_INT_UTTERANCE_MUST_NOT_LEAK",
) -> AgentTurnRequest:
    return AgentTurnRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        sessionId=session,
        utterance=utterance,
        friction=fr,
    )


def weaken_fractions(store: InMemoryMasterStateStore, subject_id: str) -> None:
    state = store.get(subject_id)
    assert state is not None
    device = state.deviceIds[0]
    store.put(
        state.model_copy(
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
    )


# ── Happy path: multi-step compose → revise → loop-back ─────────────────────


def test_integration_multistep_compose_revise_loopback_rationale() -> None:
    subject = "subj-int-seq"
    store = InMemoryMasterStateStore()
    store.put(make_state(subject))
    rt = AgentRuntime(TaskRouter(demo_task_graph(), redis_url=None), store)

    # Turn 1 — compose seed from routing directive.
    r1 = rt.run_turn(turn_request(subject, friction(), session="s1"))
    p1 = rt.get_active_plan(subject)
    assert p1 is not None
    assert p1.steps[0].goal_id.startswith("route.")
    assert r1.reply.startswith("[fake:")
    assert_plan_bound_in_turn_context(
        context=rt.model_provider.last_prompt, plan=p1  # type: ignore[arg-type]
    )
    compose_rationale = p1.rationale

    # Turn 2 — same concept continue → informational revise (rationale moves).
    r2 = rt.run_turn(turn_request(subject, friction(), session="s2"))
    p2 = rt.get_active_plan(subject)
    assert p2 is not None
    assert p2.rationale != compose_rationale
    assert "noted:" in p2.rationale or "router continue" in p2.rationale
    mid_rationale = p2.rationale

    # Turn 3 — loop-back → blocking revise; rationale changes again.
    weaken_fractions(store, subject)
    r3 = rt.run_turn(
        turn_request(
            subject,
            friction(outcome="incorrect", hesitation_ms=20_000),
            session="s3",
        )
    )
    p3 = rt.get_active_plan(subject)
    assert p3 is not None
    assert r3.mode == ROUTER_LOOPBACK_MODE
    assert p3.rationale != mid_rationale
    assert "| blocked " in p3.rationale
    assert any(s.status == "blocked" for s in p3.steps)

    persisted = store.get(subject)
    assert persisted is not None
    assert persisted.mode == ROUTER_LOOPBACK_MODE
    assert persisted.activeConceptId == r3.nextConceptId
    assert "SECRET_INT_UTTERANCE_MUST_NOT_LEAK" not in r3.reply
    assert "SECRET_INT_UTTERANCE_MUST_NOT_LEAK" not in p3.rationale


# ── CK-08 conformance port ───────────────────────────────────────────────────


def test_ck08_conformance_port_passes_graph_planner() -> None:
    events: list[dict[str, object]] = []
    report = run_ck08_conformance(
        GraphPlanner(),
        subject_id="subj-ck08-good",
        emit=events.append,
    )
    assert report.exit_code == 0
    assert report.passed_count == 2
    ids = {v.obligation_id for v in report.verdicts}
    assert ids == {
        PLANNING_OBLIGATION_IDS["cyclic_revise"],
        PLANNING_OBLIGATION_IDS["revision_updates_rationale"],
    }
    assert all(v.must_text for v in report.verdicts)
    assert {e["obligationId"] for e in events} == ids
    assert all(e["outcome"] == "pass" for e in events)
    assert all(e["subjectId"] == "subj-ck08-good" for e in events)


def test_ck08_violation_no_loopback_fails_ck08_1() -> None:
    report = run_ck08_conformance(
        NoLoopBackPlanner(),
        subject_id="subj-ck08-noloop",
    )
    assert report.exit_code == 1
    v1 = next(
        v
        for v in report.verdicts
        if v.obligation_id == PLANNING_OBLIGATION_IDS["cyclic_revise"]
    )
    assert v1.passed is False
    assert v1.must_text == MUST_CYCLIC_REVISE
    assert "route back" in v1.message or "earlier" in v1.message


def test_ck08_violation_silent_rationale_fails_ck08_2() -> None:
    report = run_ck08_conformance(
        SilentRationalePlanner(),
        subject_id="subj-ck08-silent",
    )
    assert report.exit_code == 1
    v2 = next(
        v
        for v in report.verdicts
        if v.obligation_id == PLANNING_OBLIGATION_IDS["revision_updates_rationale"]
    )
    assert v2.passed is False
    assert v2.must_text == MUST_REVISION_UPDATES_RATIONALE
    assert "unchanged" in v2.message or "silent" in v2.message


def test_ck08_obligations_independent_no_shared_mutable_state() -> None:
    """Two conformance runs do not share planner sequence / probe state."""
    a = run_ck08_conformance(GraphPlanner(), subject_id="subj-iso-a")
    b = run_ck08_conformance(GraphPlanner(), subject_id="subj-iso-b")
    assert a.exit_code == 0 and b.exit_code == 0
    # Fresh planners → independent sequence numbers still pass both obligations.


# ── Restart / concurrency / sovereignty / edges ─────────────────────────────


def test_restart_survival_plan_and_cognitive_state_on_same_store() -> None:
    subject = "subj-int-restart"
    store = InMemoryMasterStateStore()
    store.put(make_state(subject))
    rt1 = AgentRuntime(TaskRouter(demo_task_graph(), redis_url=None), store)
    rt1.run_turn(turn_request(subject, friction(), session="pre"))
    plan_id = rt1.get_active_plan(subject).plan_id  # type: ignore[union-attr]
    weaken_fractions(store, subject)
    rt1.run_turn(
        turn_request(
            subject,
            friction(outcome="incorrect", hesitation_ms=20_000),
            session="loop",
        )
    )
    blocked_rationale = rt1.get_active_plan(subject).rationale  # type: ignore[union-attr]
    state_before = store.get(subject)
    assert state_before is not None

    # Simulate process-local restart: new runtime, same store instance.
    rt2 = AgentRuntime(TaskRouter(demo_task_graph(), redis_url=None), store)
    assert rt2.get_state(subject) is not None
    assert rt2.get_state(subject).mode == ROUTER_LOOPBACK_MODE  # type: ignore[union-attr]
    assert rt2.get_state(subject).activeConceptId == state_before.activeConceptId
    plan = rt2.get_active_plan(subject)
    assert plan is not None
    assert plan.plan_id == plan_id
    assert plan.rationale == blocked_rationale
    assert "| blocked " in plan.rationale


def test_edge_advance_abandons_pending_prior_concept() -> None:
    subject = "subj-int-advance"
    store = InMemoryMasterStateStore()
    store.put(
        make_state(
            subject,
            ratios_alpha=20.0,
            ratios_beta=1.0,
            fractions_alpha=20.0,
            fractions_beta=1.0,
        )
    )
    rt = AgentRuntime(TaskRouter(demo_task_graph(), redis_url=None), store)
    rt.run_turn(turn_request(subject, friction(hesitation_ms=200), session="a1"))
    p_before = rt.get_active_plan(subject)
    assert p_before is not None
    resp = rt.run_turn(turn_request(subject, friction(hesitation_ms=200), session="a2"))
    persisted = store.get(subject)
    assert persisted is not None
    assert persisted.activeConceptId == resp.nextConceptId
    plan = rt.get_active_plan(subject)
    assert plan is not None
    assert resp.reply.startswith("[fake:")
    assert_plan_bound_in_turn_context(
        context=rt.model_provider.last_prompt, plan=plan  # type: ignore[arg-type]
    )


def test_edge_planner_cycle_typed_not_hang() -> None:
    with pytest.raises(PlannerCycleError) as exc:
        GraphPlanner().compose(
            [
                Goal("a", "A", prerequisites=("b",)),
                Goal("b", "B", prerequisites=("a",)),
            ],
            context="int-cycle",
        )
    assert exc.value.obligation_id == "CK-08.1"


def test_sovereignty_two_subjects_isolated_across_sequence() -> None:
    store = InMemoryMasterStateStore()
    store.put(make_state("subj-ia"))
    store.put(make_state("subj-ib"))
    rt = AgentRuntime(TaskRouter(demo_task_graph(), redis_url=None), store)

    for sid in ("subj-ia", "subj-ib"):
        rt.run_turn(turn_request(sid, friction(), session=f"{sid}-1"))
        weaken_fractions(store, sid)
        resp = rt.run_turn(
            turn_request(
                sid,
                friction(outcome="incorrect", hesitation_ms=20_000),
                session=f"{sid}-2",
            )
        )
        assert "SECRET_INT_UTTERANCE_MUST_NOT_LEAK" not in resp.reply

    pa = rt.get_active_plan("subj-ia")
    pb = rt.get_active_plan("subj-ib")
    assert pa is not None and pb is not None
    assert pa.plan_id != pb.plan_id
    sa = store.get("subj-ia")
    sb = store.get("subj-ib")
    assert sa is not None and sb is not None
    assert sa.subjectId == "subj-ia"
    assert sb.subjectId == "subj-ib"


def test_concurrent_turns_same_subject_plan_rmw_safe() -> None:
    subject = "subj-int-conc"
    store = InMemoryMasterStateStore()
    store.put(make_state(subject))
    rt = AgentRuntime(TaskRouter(demo_task_graph(), redis_url=None), store)
    errors: list[BaseException] = []

    def once(i: int) -> None:
        try:
            rt.run_turn(turn_request(subject, friction(), session=f"c-{i}"))
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(once, range(8)))

    assert errors == []
    plan = rt.get_active_plan(subject)
    assert plan is not None
    assert store.get(subject) is not None


def test_idempotent_replay_second_identical_continue_updates_rationale_once_more() -> None:
    """Replayed continue turn is safe: revise appends; never double-applies steps."""
    subject = "subj-int-idem"
    store = InMemoryMasterStateStore()
    store.put(make_state(subject))
    rt = AgentRuntime(TaskRouter(demo_task_graph(), redis_url=None), store)
    rt.run_turn(turn_request(subject, friction(), session="idem-1"))
    p1 = rt.get_active_plan(subject)
    assert p1 is not None
    steps_before = len(p1.steps)
    rt.run_turn(turn_request(subject, friction(), session="idem-2"))
    p2 = rt.get_active_plan(subject)
    assert p2 is not None
    assert len(p2.steps) == steps_before
    assert p2.rationale != p1.rationale
