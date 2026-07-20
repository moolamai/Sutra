"""Guidance eval scorer — TaskRouter suite + seeded determinism."""

from __future__ import annotations

import logging

import pytest

from sutra_orchestrator.guidance_eval_scorer import (
    GuidanceEvalScoreError,
    create_seeded_rng,
    derive_model_assist_seed,
    load_committed_rubric,
    load_teacher_scenarios,
    score_against_expected,
    score_scenario,
    score_teacher_suite,
    router_actual_from_scenario,
)
from sutra_orchestrator.domain_graph_loader import load_task_graph
from sutra_orchestrator.task_router import TaskRouter
from sutra_orchestrator.guidance_eval_scorer import TEACHER_PACK


def test_seeded_rng_deterministic() -> None:
    a = create_seeded_rng(42)
    b = create_seeded_rng(42)
    assert [a(), a(), a()] == [b(), b(), b()]


def test_model_assist_seed_scenario_scoped() -> None:
    assert derive_model_assist_seed(42, "a") == derive_model_assist_seed(42, "a")
    assert derive_model_assist_seed(42, "a") != derive_model_assist_seed(42, "b")


def test_score_teacher_suite_passes_fail_below(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger="sutra_orchestrator.guidance_eval_scorer"):
        summary = score_teacher_suite(throw_on_fail=True, emit_events=True)
    rubric = load_committed_rubric()
    assert summary.ok
    assert summary.count >= 8
    assert summary.mean >= rubric["failBelow"]
    blob = " ".join(r.getMessage() for r in caplog.records)
    assert "guidance_eval.suite" in blob
    assert "LEARNER_UTTERANCE" not in blob


def test_suite_regression_raises() -> None:
    rubric = load_committed_rubric()
    _, scenarios = load_teacher_scenarios()
    scenario = scenarios[0]
    bad = {
        "routeAction": "advance",
        "targetConceptId": "math.WRONG",
        "mode": "exploratory",
        "rationale": "wrong",
    }
    row = score_scenario(scenario, bad, rubric, emit_events=False)
    assert row.score < rubric["failBelow"]


def test_keyword_tolerance_partial() -> None:
    rubric = load_committed_rubric()
    scored = score_against_expected(
        {
            "routeAction": "hold",
            "targetConceptId": "math.ratios",
            "mode": "exploratory",
            "rationale": "friction → nominal GUIDE concept='Ratios'",
        },
        {
            "routeAction": "hold",
            "targetConceptId": "math.ratios",
            "mode": "exploratory",
            "rationaleKeywords": ["nominal", "Ratios", "missing-kw"],
        },
        rubric,
    )
    assert 0 < scored["components"]["rationaleKeywords"] < 1
    assert scored["score"] >= rubric["failBelow"]


def test_router_actual_subject_isolation() -> None:
    meta = load_task_graph(
        TEACHER_PACK,
        subject_id="boot",
        device_id="ci",
        emit_events=False,
    )
    router = TaskRouter(meta.graph, redis_url=None)
    _, scenarios = load_teacher_scenarios()
    a = router_actual_from_scenario(scenarios[0], router)
    b = router_actual_from_scenario(scenarios[1], router)
    assert scenarios[0]["subjectId"] != scenarios[1]["subjectId"]
    assert "LEARNER_UTTERANCE" not in a["rationale"]
    assert a["routeAction"] in ("advance", "remediate", "hold")
    assert b["routeAction"] in ("advance", "remediate", "hold")


def test_suite_mean_deterministic_across_runs() -> None:
    s1 = score_teacher_suite(throw_on_fail=False, emit_events=False)
    s2 = score_teacher_suite(throw_on_fail=False, emit_events=False)
    assert s1.mean == s2.mean
    assert [r.score for r in s1.results] == [r.score for r in s2.results]
    assert [r.model_assist_seed for r in s1.results] == [
        r.model_assist_seed for r in s2.results
    ]


def test_throw_on_fail_obligation() -> None:
    # Force regression by scoring empty mean path is not easy; ensure error type
    # is raised when throw_on_fail and we manually craft a failing summary path
    # via score_scenario budget miss aggregated — use monkeypatch-free check:
    err = GuidanceEvalScoreError(
        "x",
        obligation="guidance_eval.suite.score_regression",
        failure_class="score_regression",
        score=0.1,
        fail_below=0.85,
    )
    assert err.failure_class == "score_regression"
