"""Teacher CBSE-slice pack — load + TaskRouter routing on mastery fixtures."""

from __future__ import annotations

import copy
import json
import logging
from pathlib import Path

import pytest

from sutra_orchestrator.contract_models import ConceptMastery, FrictionSample
from sutra_orchestrator.domain_graph_loader import (
    TaskGraphLoadError,
    load_task_graph,
    load_task_graph_from_object,
)
from sutra_orchestrator.task_router import TaskRouter

REPO_PACKAGES = Path(__file__).resolve().parents[2]
PACK = REPO_PACKAGES / "domain-loader" / "fixtures" / "packs" / "teacher-cbse-slice.json"
INVENTORY = (
    Path(__file__).resolve().parents[3]
    / "domains"
    / "teacher"
    / "data"
    / "task-graph-concept-ids.json"
)


def _mastery(device: str, concept_id: str, mean_approx: float) -> ConceptMastery:
    """Beta-Bernoulli sketch: mean ≈ (alpha+1)/(alpha+beta+2)."""
    if mean_approx >= 0.9:
        alpha, beta = 20.0, 1.0
    elif mean_approx <= 0.2:
        alpha, beta = 1.0, 20.0
    else:
        alpha, beta = 5.0, 5.0
    return ConceptMastery(
        conceptId=concept_id,
        alpha={device: alpha},
        beta={device: beta},
        lastExercisedAt=f"001700000000000:000000:{device}",
    )


def test_teacher_pack_loads_with_pack_thresholds(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger="sutra_orchestrator.domain_graph_loader"):
        meta = load_task_graph(
            PACK,
            subject_id="subj.teacher.py.load",
            device_id="dev-py-teacher",
            emit_events=True,
        )
    assert meta.pack_id == "teacher-cbse-slice"
    assert meta.version_stamp == "teacher-cbse-slice@1.0.0"
    assert meta.advance_threshold == 0.85
    assert meta.remediate_threshold == 0.4
    assert meta.graph.nodes["math.ratios"].prerequisites == ("math.fractions",)
    assert "math.unitary_method" in meta.graph.nodes
    blob = " ".join(r.getMessage() for r in caplog.records)
    assert "subj.teacher.py.load" in blob
    assert "dev-py-teacher" in blob
    assert "LEARNER_UTTERANCE" not in blob


def test_teacher_pack_concepts_subset_of_domain_inventory() -> None:
    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    allowed = {c["conceptId"] for c in inventory["concepts"]}
    meta = load_task_graph(
        PACK,
        subject_id="subj.teacher.inv",
        device_id="dev-py",
        emit_events=False,
    )
    for cid in meta.graph.nodes:
        assert cid in allowed


def test_router_advance_on_teacher_pack() -> None:
    meta = load_task_graph(
        PACK,
        subject_id="subj.teacher.advance",
        device_id="cloud-test",
        emit_events=False,
    )
    router = TaskRouter(meta.graph, redis_url=None)
    device = "dev-teacher"
    mastery = {
        "math.fractions": _mastery(device, "math.fractions", 0.95),
    }
    out = router.route_turn(
        subject_id="subj.teacher.advance",
        active_concept_id="math.fractions",
        mode="exploratory",
        friction=FrictionSample(
            conceptId="math.fractions",
            hesitationMs=100,
            inputVelocity=3.0,
            revisionCount=0,
            assistanceRequested=False,
            outcome="correct",
            capturedAt=f"001700000000000:000001:{device}",
        ),
        mastery=mastery,
    )
    assert out["next_concept_id"] == "math.ratios"
    assert "0.85" in out["routing_rationale"]


def test_router_remediate_fractions_on_weak_prereq() -> None:
    meta = load_task_graph(
        PACK,
        subject_id="subj.teacher.remediate",
        device_id="cloud-test",
        emit_events=False,
    )
    router = TaskRouter(meta.graph, redis_url=None)
    device = "dev-teacher"
    mastery = {
        "math.ratios": _mastery(device, "math.ratios", 0.5),
        "math.fractions": _mastery(device, "math.fractions", 0.15),
    }
    out = router.route_turn(
        subject_id="subj.teacher.remediate",
        active_concept_id="math.ratios",
        mode="guided",
        friction=FrictionSample(
            conceptId="math.ratios",
            hesitationMs=20_000,
            inputVelocity=0.5,
            revisionCount=3,
            assistanceRequested=True,
            outcome="incorrect",
            capturedAt=f"001700000000000:000002:{device}",
        ),
        mastery=mastery,
    )
    assert out["next_concept_id"] == "math.fractions"
    assert out["mode"] == "prerequisite-remediation"


def test_router_probe_hold_when_mastery_mid_band() -> None:
    """Neither advance nor remediate — continue / probe hold on active concept."""
    meta = load_task_graph(
        PACK,
        subject_id="subj.teacher.probe",
        device_id="cloud-test",
        emit_events=False,
    )
    router = TaskRouter(meta.graph, redis_url=None)
    device = "dev-teacher"
    mastery = {
        "math.ratios": _mastery(device, "math.ratios", 0.5),
        "math.fractions": _mastery(device, "math.fractions", 0.9),
    }
    out = router.route_turn(
        subject_id="subj.teacher.probe",
        active_concept_id="math.ratios",
        mode="exploratory",
        friction=FrictionSample(
            conceptId="math.ratios",
            hesitationMs=200,
            inputVelocity=2.0,
            revisionCount=0,
            assistanceRequested=False,
            outcome="correct",
            capturedAt=f"001700000000000:000003:{device}",
        ),
        mastery=mastery,
    )
    assert out["next_concept_id"] == "math.ratios"
    assert out["mode"] == "exploratory"


def test_unknown_concept_quarantines_without_crash() -> None:
    meta = load_task_graph(
        PACK,
        subject_id="subj.teacher.unknown",
        device_id="cloud-test",
        emit_events=False,
    )
    router = TaskRouter(meta.graph, redis_url=None)
    device = "dev-teacher"
    out = router.route_turn(
        subject_id="subj.teacher.unknown",
        active_concept_id="math.not_in_pack",
        mode="diagnostic",
        friction=FrictionSample(
            conceptId="math.not_in_pack",
            hesitationMs=100,
            inputVelocity=1.0,
            revisionCount=0,
            assistanceRequested=False,
            outcome="correct",
            capturedAt=f"001700000000000:000004:{device}",
        ),
        mastery={},
    )
    assert out["next_concept_id"] == "math.not_in_pack"
    assert "GUIDE" in out["guidance_directive"]


def test_subject_isolation_load_scoped_by_subject_id(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.INFO, logger="sutra_orchestrator.domain_graph_loader"):
        load_task_graph(
            PACK,
            subject_id="subj-A-only",
            device_id="dev-A",
            emit_events=True,
        )
    blob = " ".join(r.getMessage() for r in caplog.records)
    assert "subj-A-only" in blob
    assert "subj-B" not in blob


def test_cyclic_mutation_rejected() -> None:
    raw = copy.deepcopy(json.loads(PACK.read_text(encoding="utf-8")))
    raw["edges"].append(
        {
            "fromConceptId": "math.fractions",
            "toConceptId": "math.unitary_method",
            "type": "prerequisite",
        }
    )
    with pytest.raises(TaskGraphLoadError) as exc:
        load_task_graph_from_object(
            raw,
            subject_id="subj.teacher.cycle",
            device_id="dev-py",
            emit_events=False,
        )
    assert exc.value.failure_class == "cycle"
