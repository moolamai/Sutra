"""Teacher guidance-eval goldens — TaskRouter matches expected routeAction/target."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest

from sutra_orchestrator.contract_models import ConceptMastery, FrictionSample
from sutra_orchestrator.domain_graph_loader import load_task_graph
from sutra_orchestrator.task_router import HESITATION_SPIKE_MS, TaskRouter

REPO = Path(__file__).resolve().parents[3]
PACK = REPO / "packages" / "domain-loader" / "fixtures" / "packs" / "teacher-cbse-slice.json"
SCENARIOS = REPO / "evals" / "guidance" / "scenarios"
MANIFEST = SCENARIOS / "teacher" / "manifest.json"


def _load_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def _infer_route_action(out: dict, active: str, spiked: bool) -> str:
    if out["mode"] == "prerequisite-remediation":
        return "remediate"
    if out["next_concept_id"] != active and not spiked:
        return "advance"
    return "hold"


def _spiked(friction: dict) -> bool:
    return (
        friction["hesitationMs"] > HESITATION_SPIKE_MS
        or friction["assistanceRequested"]
        or friction["outcome"] == "incorrect"
    )


@pytest.fixture(scope="module")
def teacher_router() -> TaskRouter:
    meta = load_task_graph(
        PACK,
        subject_id="subj.eval.teacher.boot",
        device_id="ci",
        emit_events=False,
    )
    assert meta.pack_id == "teacher-cbse-slice"
    return TaskRouter(meta.graph, redis_url=None)


def test_teacher_manifest_has_at_least_eight() -> None:
    man = _load_manifest()
    assert man["packId"] == "teacher-cbse-slice"
    assert len(man["scenarios"]) >= 8


@pytest.mark.parametrize(
    "rel",
    _load_manifest()["scenarios"],
    ids=lambda r: Path(r).stem,
)
def test_teacher_golden_matches_task_router(
    teacher_router: TaskRouter,
    rel: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    scenario = json.loads((SCENARIOS / rel).read_text(encoding="utf-8"))
    device = scenario["deviceId"]
    mastery = {
        cid: ConceptMastery(
            conceptId=m["conceptId"],
            alpha=m["alpha"],
            beta=m["beta"],
            lastExercisedAt=m["lastExercisedAt"],
        )
        for cid, m in scenario["masterySeed"].items()
    }
    friction = scenario["turnFriction"]
    with caplog.at_level(logging.INFO, logger="sutra_orchestrator.task_router"):
        out = teacher_router.route_turn(
            subject_id=scenario["subjectId"],
            active_concept_id=scenario["activeConceptId"],
            mode=scenario["mode"],
            friction=FrictionSample(
                conceptId=friction["conceptId"],
                hesitationMs=friction["hesitationMs"],
                inputVelocity=friction["inputVelocity"],
                revisionCount=friction["revisionCount"],
                assistanceRequested=friction["assistanceRequested"],
                outcome=friction["outcome"],
                capturedAt=friction["capturedAt"],
            ),
            mastery=mastery,
        )

    spiked = _spiked(friction)
    action = _infer_route_action(out, scenario["activeConceptId"], spiked)
    exp = scenario["expected"]
    assert action == exp["routeAction"]
    assert out["next_concept_id"] == exp["targetConceptId"]
    assert out["mode"] == exp["mode"]

    blob = (out["routing_rationale"] + " " + out["guidance_directive"]).lower()
    for kw in exp["rationaleKeywords"]:
        assert kw.lower() in blob, f"{rel}: missing keyword {kw!r} in {blob[:240]!r}"

    log_blob = " ".join(r.getMessage() for r in caplog.records)
    assert scenario["subjectId"] in log_blob
    assert "LEARNER_UTTERANCE" not in log_blob


def test_subject_isolation_across_teacher_goldens() -> None:
    man = _load_manifest()
    ids = []
    for rel in man["scenarios"]:
        s = json.loads((SCENARIOS / rel).read_text(encoding="utf-8"))
        ids.append(s["subjectId"])
    assert len(set(ids)) == len(ids)


def test_edge_hesitation_boundary_is_hold_not_remediate(
    teacher_router: TaskRouter,
) -> None:
    rel = "teacher/hold-hesitation-boundary.json"
    scenario = json.loads((SCENARIOS / rel).read_text(encoding="utf-8"))
    assert scenario["turnFriction"]["hesitationMs"] == 14_999
    assert scenario["expected"]["routeAction"] == "hold"
    # fractions are weak — would remediate if spiked; boundary must not spike.
    assert scenario["masterySeed"]["math.fractions"]["beta"]["dev-eval-teacher"] == 20
