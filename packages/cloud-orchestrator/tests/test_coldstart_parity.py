"""CAST-05 cold-start parity: TaskRouter matches shared goldens (edge route_core).

Same fixture bytes as playground ``coldstart_parity.test.mjs`` /
edge-agent ``coldstart_parity.test.mjs``. Pack file is teacher-cbse-slice
(no network); inlineGraph cases stay offline too.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest

from sutra_orchestrator.contract_models import ConceptMastery, FrictionSample
from sutra_orchestrator.domain_graph_loader import load_task_graph
from sutra_orchestrator.task_router import (
    CAST_05_1_OBLIGATION_ID,
    ConceptNode,
    TaskGraph,
    TaskRouter,
    mastery_evidence_counts,
)

REPO_PACKAGES = Path(__file__).resolve().parents[2]
PACK = REPO_PACKAGES / "domain-loader" / "fixtures" / "packs" / "teacher-cbse-slice.json"
GOLDENS = (
    REPO_PACKAGES
    / "domain-loader"
    / "fixtures"
    / "packs"
    / "teacher-cbse-slice.coldstart-goldens.json"
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


def _graph_from_inline(inline: dict) -> TaskGraph:
    nodes: dict[str, ConceptNode] = {}
    for n in inline["nodes"][:64]:
        nodes[n["conceptId"]] = ConceptNode(
            n["conceptId"],
            n.get("title", n["conceptId"]),
            tuple(n.get("prerequisites") or ()),
        )
    return TaskGraph(
        nodes=nodes,
        advance_threshold=float(inline.get("advanceThreshold", 0.85)),
        remediate_threshold=float(inline.get("remediateThreshold", 0.4)),
    )


def _router_for_case(case: dict, device: str) -> TaskRouter:
    if case.get("inlineGraph"):
        return TaskRouter(_graph_from_inline(case["inlineGraph"]), redis_url=None)
    meta = load_task_graph(
        PACK,
        subject_id="subj.cold.parity.boot",
        device_id=device,
        emit_events=False,
    )
    return TaskRouter(meta.graph, redis_url=None)


def _run_case(router: TaskRouter, case: dict, device: str) -> dict:
    friction = case["friction"]
    return router.route_turn(
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


def test_coldstart_goldens_schema_and_bounds() -> None:
    goldens = json.loads(GOLDENS.read_text(encoding="utf-8"))
    assert goldens["schemaVersion"] == "teacher-cbse-slice.coldstart-goldens.v1"
    assert goldens["packId"] == "teacher-cbse-slice"
    assert goldens["packFile"] == "teacher-cbse-slice.json"
    assert PACK.is_file()
    assert PACK.name == goldens["packFile"]
    assert 4 <= len(goldens["cases"]) <= 64


def test_parity_task_router_matches_coldstart_goldens(
    caplog: pytest.LogCaptureFixture,
) -> None:
    goldens = json.loads(GOLDENS.read_text(encoding="utf-8"))
    device = goldens["deviceId"]
    assert len(device) >= 4

    with caplog.at_level(logging.INFO, logger="sutra_orchestrator.task_router"):
        for case in goldens["cases"]:
            router = _router_for_case(case, device)
            replays = int(case.get("replay") or 1)
            assert 1 <= replays <= 8
            prior = None
            for _ in range(replays):
                out = _run_case(router, case, device)
                expect = case["expect"]
                assert out["next_concept_id"] == expect["nextConceptId"], case["id"]
                assert out["mode"] == expect["mode"], case["id"]
                for needle in expect.get("rationaleIncludes") or []:
                    assert needle in out["routing_rationale"], (
                        case["id"],
                        needle,
                        out["routing_rationale"],
                    )
                if expect.get("gateBlocked"):
                    assert CAST_05_1_OBLIGATION_ID in out["routing_rationale"]
                if prior is not None:
                    assert out["next_concept_id"] == prior["next_concept_id"]
                    assert out["mode"] == prior["mode"]
                prior = out

    blob = " ".join(r.getMessage() for r in caplog.records)
    assert "subj.cold.parity" in blob or "coldstart.gate" in blob
    assert "LEARNER_UTTERANCE" not in blob


def test_subject_isolation_in_coldstart_goldens() -> None:
    goldens = json.loads(GOLDENS.read_text(encoding="utf-8"))
    ids = [c["subjectId"] for c in goldens["cases"]]
    assert len(set(ids)) == len(ids)


def test_gate_evidence_agrees_with_expect_unassessed() -> None:
    """Mastery evidence → unassessed roots matches golden gate fields."""
    goldens = json.loads(GOLDENS.read_text(encoding="utf-8"))
    device = goldens["deviceId"]
    for case in goldens["cases"]:
        if case.get("inlineGraph"):
            graph = _graph_from_inline(case["inlineGraph"])
            roots = graph.root_concept_ids()
        else:
            meta = load_task_graph(PACK, subject_id=case["subjectId"], emit_events=False)
            roots = meta.graph.root_concept_ids()
        counts = mastery_evidence_counts(
            _mastery_map(device, case.get("mastery") or {})
        )
        unassessed = [
            r
            for r in roots
            if counts.get(r, 0) < 3
        ]
        assert list(unassessed) == list(case["expect"]["unassessedRoots"]), case["id"]
