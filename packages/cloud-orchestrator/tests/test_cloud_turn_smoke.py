"""Cloud turn smoke tests with DeterministicFakeProvider.

Locks smoke_test.py contracts: model text (not [directive]); plan changes digest.
"""

from __future__ import annotations

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

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
    DeterministicFakeProvider,
    ModelProviderConfigError,
    ModelProviderEmptyError,
)
from sutra_orchestrator.planner import assert_plan_bound_in_turn_context
from sutra_orchestrator.sync_service import InMemoryMasterStateStore
from sutra_orchestrator.task_router import TaskRouter, demo_task_graph

SMOKE = Path(__file__).resolve().parents[1] / "smoke_test.py"


def hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


def make_state(subject_id: str, device: str = "dev-smoke") -> CognitiveState:
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


def friction(concept_id: str = "math.ratios") -> FrictionSample:
    return FrictionSample(
        conceptId=concept_id,
        hesitationMs=900,
        inputVelocity=3.0,
        revisionCount=0,
        assistanceRequested=False,
        outcome="correct",
        capturedAt=hlc(1_700_000_000_100, 0, "edge-smoke"),
    )


def turn_request(
    subject_id: str,
    *,
    session: str = "sess-smoke",
    utterance: str = "Explain ratios simply.",
) -> AgentTurnRequest:
    return AgentTurnRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        sessionId=session,
        utterance=utterance,
        friction=friction(),
    )


def runtime_for(
    subject_id: str,
    provider: DeterministicFakeProvider | None = None,
) -> tuple[AgentRuntime, InMemoryMasterStateStore, DeterministicFakeProvider]:
    store = InMemoryMasterStateStore()
    store.put(make_state(subject_id))
    fake = provider or DeterministicFakeProvider()
    rt = AgentRuntime(
        TaskRouter(demo_task_graph(), redis_url=None),
        store,
        model_provider=fake,
    )
    return rt, store, fake


# ── Live smoke_test.py ───────────────────────────────────────────────────────


def test_live_smoke_test_includes_fake_provider_cloud_turn() -> None:
    proc = subprocess.run(
        [sys.executable, str(SMOKE)],
        cwd=str(SMOKE.parent),
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr or proc.stdout
    out = proc.stdout
    assert "CRDT merge algebra: commutative, idempotent, dedup OK" in out
    assert "Graph planner: topological order, loop-back revision OK" in out
    assert "Cloud turn: fake provider model text + plan-grounded digests OK" in out


# ── Happy path + plan-grounded digests ───────────────────────────────────────


def test_happy_path_run_turn_model_text_not_directive_stub() -> None:
    rt, store, fake = runtime_for("subj-smoke-happy")
    resp = rt.run_turn(turn_request("subj-smoke-happy"))
    assert resp.reply.startswith("[fake:")
    assert "[directive]" not in resp.reply
    assert fake.last_prompt is not None
    plan = rt.get_active_plan("subj-smoke-happy")
    assert plan is not None
    assert_plan_bound_in_turn_context(context=fake.last_prompt, plan=plan)
    persisted = store.get("subj-smoke-happy")
    assert persisted is not None
    assert persisted.activeConceptId == resp.nextConceptId


def test_plan_context_change_moves_fake_output_deterministically() -> None:
    rt, _, fake = runtime_for("subj-smoke-plan")
    utterance = "Explain ratios simply."
    a = rt.run_turn(turn_request("subj-smoke-plan", session="s1", utterance=utterance))
    prompt_a = fake.last_prompt
    b = rt.run_turn(turn_request("subj-smoke-plan", session="s2", utterance=utterance))
    prompt_b = fake.last_prompt
    assert prompt_a and prompt_b and prompt_a != prompt_b
    assert a.reply != b.reply
    # Idempotent replay of same session path still grounded — third turn moves again.
    c = rt.run_turn(turn_request("subj-smoke-plan", session="s3", utterance=utterance))
    assert c.reply != b.reply


# ── Edges / sovereignty / restart / concurrency ──────────────────────────────


def test_edge_timeout_and_empty_typed_errors() -> None:
    rt_to, store_to, _ = runtime_for(
        "subj-smoke-to", DeterministicFakeProvider(force_timeout=True)
    )
    resp = rt_to.run_turn(turn_request("subj-smoke-to"))
    assert resp.degraded is True
    assert resp.reply.startswith("GUIDE concept=")
    assert resp.freshnessMarker is not None
    assert store_to.get("subj-smoke-to") is not None  # durable before generate degrade

    rt_empty, _, _ = runtime_for(
        "subj-smoke-empty", DeterministicFakeProvider(force_empty=True)
    )
    with pytest.raises(ModelProviderEmptyError):
        rt_empty.run_turn(turn_request("subj-smoke-empty"))


def test_edge_missing_provider_fail_fast_at_construction() -> None:
    store = InMemoryMasterStateStore()
    with pytest.raises(ModelProviderConfigError):
        AgentRuntime(
            TaskRouter(demo_task_graph(), redis_url=None),
            store,
            require_model_provider_binding=True,
        )


def test_restart_survival_plan_and_state_with_fake_provider() -> None:
    subject = "subj-smoke-restart"
    store = InMemoryMasterStateStore()
    store.put(make_state(subject))
    fake = DeterministicFakeProvider()
    rt1 = AgentRuntime(
        TaskRouter(demo_task_graph(), redis_url=None),
        store,
        model_provider=fake,
    )
    r1 = rt1.run_turn(turn_request(subject, session="pre"))
    plan_id = rt1.get_active_plan(subject).plan_id  # type: ignore[union-attr]

    rt2 = AgentRuntime(
        TaskRouter(demo_task_graph(), redis_url=None),
        store,
        model_provider=DeterministicFakeProvider(),
    )
    state = rt2.get_state(subject)
    assert state is not None
    assert state.activeConceptId == r1.nextConceptId
    plan = rt2.get_active_plan(subject)
    assert plan is not None and plan.plan_id == plan_id
    r2 = rt2.run_turn(turn_request(subject, session="post"))
    assert r2.reply.startswith("[fake:")


def test_sovereignty_subjects_isolated_and_utterance_not_in_reply() -> None:
    store = InMemoryMasterStateStore()
    store.put(make_state("subj-sa", device="dev-sa"))
    store.put(make_state("subj-sb", device="dev-sb"))
    fake = DeterministicFakeProvider()
    rt = AgentRuntime(
        TaskRouter(demo_task_graph(), redis_url=None),
        store,
        model_provider=fake,
    )
    secret = "SECRET_SMOKE_UTTERANCE_MUST_NOT_LEAK"
    ra = rt.run_turn(
        turn_request("subj-sa", session="sa", utterance=secret)
    )
    rb = rt.run_turn(
        turn_request("subj-sb", session="sb", utterance=secret)
    )
    assert secret not in ra.reply
    assert secret not in rb.reply
    assert ra.reply != rb.reply  # subject-scoped digests
    assert store.get("subj-sa").subjectId == "subj-sa"  # type: ignore[union-attr]
    assert store.get("subj-sb").subjectId == "subj-sb"  # type: ignore[union-attr]


def test_concurrent_turns_same_subject_serialize_safely() -> None:
    rt, store, _ = runtime_for("subj-smoke-conc")
    errors: list[BaseException] = []

    def once(i: int) -> None:
        try:
            rt.run_turn(turn_request("subj-smoke-conc", session=f"c-{i}"))
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(once, range(8)))

    assert errors == []
    assert rt.get_active_plan("subj-smoke-conc") is not None
    assert store.get("subj-smoke-conc") is not None
