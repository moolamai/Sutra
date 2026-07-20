"""CAST-05.1 cold-start gate wired into TaskRouter route_turn."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from sutra_orchestrator.contract_models import ConceptMastery, FrictionSample
from sutra_orchestrator.domain_graph_loader import load_task_graph
from sutra_orchestrator.task_router import (
    CAST_05_1_OBLIGATION_ID,
    CAST_05_MIN_ROOT_FRICTION_SAMPLES,
    ConceptNode,
    TaskGraph,
    TaskRouter,
    cold_start_blocks_advance,
    list_unassessed_roots,
    mastery_evidence_counts,
)

REPO_PACKAGES = Path(__file__).resolve().parents[2]
PACK = REPO_PACKAGES / "domain-loader" / "fixtures" / "packs" / "teacher-cbse-slice.json"


def _mastery(device: str, concept_id: str, alpha: float, beta: float) -> ConceptMastery:
    return ConceptMastery(
        conceptId=concept_id,
        alpha={device: alpha},
        beta={device: beta},
        lastExercisedAt=f"001700000000000:000000:{device}",
    )


def _friction(device: str, concept_id: str, *, hesitation: int = 100) -> FrictionSample:
    return FrictionSample(
        conceptId=concept_id,
        hesitationMs=hesitation,
        inputVelocity=3.0,
        revisionCount=0,
        assistanceRequested=False,
        outcome="correct",
        capturedAt=f"001700000000000:000001:{device}",
    )


def test_root_concept_ids_are_entry_nodes() -> None:
    g = TaskGraph(
        nodes={
            "math.fractions": ConceptNode("math.fractions", "Fractions", ()),
            "math.ratios": ConceptNode("math.ratios", "Ratios", ("math.fractions",)),
        }
    )
    assert g.root_concept_ids() == ("math.fractions",)


def test_mastery_evidence_counts_match_alpha_beta() -> None:
    device = "dev-ev"
    mastery = {
        "math.fractions": _mastery(device, "math.fractions", 20.0, 1.0),
    }
    assert mastery_evidence_counts(mastery)["math.fractions"] == 21


def test_route_turn_blocks_advance_when_root_unassessed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    meta = load_task_graph(PACK, subject_id="subj.cold.block", emit_events=False)
    router = TaskRouter(meta.graph, redis_url=None)
    device = "dev-cold"
    # High mastery on a non-root with an unassessed root → advance quarantined.
    mastery = {
        "math.fractions": _mastery(device, "math.fractions", 1.0, 0.0),
        "math.ratios": _mastery(device, "math.ratios", 20.0, 1.0),
    }
    assert mastery_evidence_counts(mastery)["math.fractions"] < CAST_05_MIN_ROOT_FRICTION_SAMPLES

    with caplog.at_level(logging.INFO):
        out = router.route_turn(
            subject_id="subj.cold.block",
            active_concept_id="math.ratios",
            mode="exploratory",
            friction=_friction(device, "math.ratios"),
            mastery=mastery,
        )

    assert out["mode"] == "diagnostic"
    assert out["next_concept_id"] == "math.fractions"
    assert CAST_05_1_OBLIGATION_ID in out["routing_rationale"]
    assert "advance quarantined" in out["routing_rationale"]
    assert out["next_concept_id"] != "math.equivalent_ratios"
    assert any("coldstart.gate" in r.message and "block_advance" in r.message for r in caplog.records)


def test_route_turn_high_confidence_empty_mastery_diagnostic() -> None:
    """First turn with no posterior seed — never advance."""
    meta = load_task_graph(PACK, subject_id="subj.cold.empty", emit_events=False)
    router = TaskRouter(meta.graph, redis_url=None)
    out = router.route_turn(
        subject_id="subj.cold.empty",
        active_concept_id="math.fractions",
        mode="exploratory",
        friction=_friction("dev-empty", "math.fractions"),
        mastery={},
    )
    assert out["mode"] == "diagnostic"
    assert out["next_concept_id"] == "math.fractions"
    assert CAST_05_1_OBLIGATION_ID in out["routing_rationale"]


def test_route_turn_partial_root_still_blocks() -> None:
    """Two-root graph: assessing one root does not unlock advance."""
    g = TaskGraph(
        nodes={
            "root.a": ConceptNode("root.a", "A", ()),
            "root.b": ConceptNode("root.b", "B", ()),
            "child": ConceptNode("child", "Child", ("root.a", "root.b")),
        }
    )
    router = TaskRouter(g, redis_url=None)
    device = "dev-part"
    mastery = {
        "root.a": _mastery(device, "root.a", 20.0, 1.0),
        "root.b": _mastery(device, "root.b", 1.0, 0.0),
        "child": _mastery(device, "child", 20.0, 1.0),
    }
    assert cold_start_blocks_advance(g.root_concept_ids(), mastery_evidence_counts(mastery))
    out = router.route_turn(
        subject_id="subj.cold.partial",
        active_concept_id="child",
        mode="exploratory",
        friction=_friction(device, "child"),
        mastery=mastery,
    )
    assert out["mode"] == "diagnostic"
    assert out["next_concept_id"] == "root.b"
    assert "root.b" in out["routing_rationale"]


def test_route_turn_allows_advance_when_root_assessed() -> None:
    meta = load_task_graph(PACK, subject_id="subj.cold.ok", emit_events=False)
    router = TaskRouter(meta.graph, redis_url=None)
    device = "dev-ok"
    mastery = {
        "math.fractions": _mastery(device, "math.fractions", 20.0, 1.0),
    }
    out = router.route_turn(
        subject_id="subj.cold.ok",
        active_concept_id="math.fractions",
        mode="exploratory",
        friction=_friction(device, "math.fractions"),
        mastery=mastery,
    )
    assert out["next_concept_id"] == "math.ratios"
    assert out["mode"] == "exploratory"


def test_unknown_concept_quarantine_does_not_retarget_root() -> None:
    meta = load_task_graph(PACK, subject_id="subj.cold.unknown", emit_events=False)
    router = TaskRouter(meta.graph, redis_url=None)
    out = router.route_turn(
        subject_id="subj.cold.unknown",
        active_concept_id="math.not_in_pack",
        mode="diagnostic",
        friction=_friction("dev-unk", "math.not_in_pack"),
        mastery={},
    )
    assert out["next_concept_id"] == "math.not_in_pack"
    assert out["mode"] == "diagnostic"
    assert CAST_05_1_OBLIGATION_ID in out["routing_rationale"]


def test_subject_isolation_counts_are_caller_scoped() -> None:
    roots = ("root.a",)
    subj_a = {"root.a": 0}
    subj_b = {"root.a": CAST_05_MIN_ROOT_FRICTION_SAMPLES}
    assert cold_start_blocks_advance(roots, subj_a) is True
    assert cold_start_blocks_advance(roots, subj_b) is False
    assert list_unassessed_roots(roots, subj_a) == ("root.a",)
