"""Teacher CBSE-slice: TaskRouter decisions match committed route goldens.

Same fixture bytes as playground ``teacher_route_parity.test.mjs``.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest

from sutra_orchestrator.contract_models import ConceptMastery, FrictionSample
from sutra_orchestrator.domain_graph_loader import (
    TaskGraphLoadError,
    bundled_teacher_pack_path,
    load_task_graph,
    load_task_graph_from_object,
    resolve_production_task_graph,
)
from sutra_orchestrator.task_router import TaskRouter

REPO_PACKAGES = Path(__file__).resolve().parents[2]
PACK = REPO_PACKAGES / "domain-loader" / "fixtures" / "packs" / "teacher-cbse-slice.json"
GOLDENS = (
    REPO_PACKAGES
    / "domain-loader"
    / "fixtures"
    / "packs"
    / "teacher-cbse-slice.route-goldens.json"
)


def _mastery_map(
    device: str, mastery: dict[str, dict[str, float]]
) -> dict[str, ConceptMastery]:
    out: dict[str, ConceptMastery] = {}
    for cid, ab in mastery.items():
        out[cid] = ConceptMastery(
            conceptId=cid,
            alpha={device: float(ab["alpha"])},
            beta={device: float(ab["beta"])},
            lastExercisedAt=f"001700000000000:000000:{device}",
        )
    return out


def test_bundled_teacher_pack_matches_domain_loader_fixtures() -> None:
    bundled = bundled_teacher_pack_path().read_bytes()
    fixtures = PACK.read_bytes()
    assert bundled == fixtures


def test_resolve_production_defaults_to_teacher_pack() -> None:
    meta = resolve_production_task_graph(
        subject_id="subj.prod.teacher",
        device_id="cloud-test",
        emit_events=False,
    )
    assert meta.pack_id == "teacher-cbse-slice"
    assert meta.version_stamp == "teacher-cbse-slice@1.0.0"
    assert meta.advance_threshold == 0.85
    assert "math.unitary_method" in meta.graph.nodes


def test_parity_task_router_matches_route_goldens(
    caplog: pytest.LogCaptureFixture,
) -> None:
    goldens = json.loads(GOLDENS.read_text(encoding="utf-8"))
    device = goldens["deviceId"]
    meta = load_task_graph(
        PACK,
        subject_id="subj.parity.py.boot",
        device_id=device,
        emit_events=False,
    )
    assert goldens["packId"] == meta.pack_id
    assert len(goldens["cases"]) >= 4
    assert len(goldens["cases"]) <= 64

    router = TaskRouter(meta.graph, redis_url=None)
    with caplog.at_level(logging.INFO, logger="sutra_orchestrator.task_router"):
        for case in goldens["cases"]:
            friction = case["friction"]
            out = router.route_turn(
                subject_id=case["subjectId"],
                active_concept_id=case["activeConceptId"],
                mode=case["mode"],
                friction=FrictionSample(
                    conceptId=friction["conceptId"],
                    hesitationMs=friction["hesitationMs"],
                    inputVelocity=friction["inputVelocity"],
                    revisionCount=friction["revisionCount"],
                    assistanceRequested=friction["assistanceRequested"],
                    outcome=friction["outcome"],
                    capturedAt=f"001700000000000:000001:{device}",
                ),
                mastery=_mastery_map(device, case.get("mastery") or {}),
            )
            assert out["next_concept_id"] == case["expect"]["nextConceptId"], case["id"]
            assert out["mode"] == case["expect"]["mode"], case["id"]

    blob = " ".join(r.getMessage() for r in caplog.records)
    assert "subj.parity.advance" in blob
    assert "LEARNER_UTTERANCE" not in blob


def test_subject_isolation_in_goldens() -> None:
    goldens = json.loads(GOLDENS.read_text(encoding="utf-8"))
    ids = [c["subjectId"] for c in goldens["cases"]]
    assert len(set(ids)) == len(ids)


def test_cyclic_teacher_pack_rejected() -> None:
    raw = json.loads(PACK.read_text(encoding="utf-8"))
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
            subject_id="subj.parity.cycle",
            device_id="dev-py",
            emit_events=False,
        )
    assert exc.value.failure_class == "cycle"
