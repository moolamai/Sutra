"""Guidance-eval scorer — keyword-tolerant rubric + seeded determinism.

Mirrors ``evals/guidance/src/score.mjs`` scoring math. Suite runners invoke
``TaskRouter`` and gate on ``rubric.failBelow``.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from .contract_models import ConceptMastery, FrictionSample
from .domain_graph_loader import load_task_graph
from .task_router import HESITATION_SPIKE_MS, TaskRouter

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[4]
GUIDANCE_ROOT = REPO_ROOT / "evals" / "guidance"
RUBRIC_PATH = GUIDANCE_ROOT / "rubric.json"
SCENARIOS_DIR = GUIDANCE_ROOT / "scenarios"
TEACHER_PACK = (
    REPO_ROOT
    / "packages"
    / "domain-loader"
    / "fixtures"
    / "packs"
    / "teacher-cbse-slice.json"
)


class GuidanceEvalScoreError(Exception):
    def __init__(
        self,
        message: str,
        *,
        obligation: str,
        failure_class: str,
        subject_id: str | None = None,
        device_id: str | None = None,
        scenario_id: str | None = None,
        score: float | None = None,
        fail_below: float | None = None,
    ) -> None:
        super().__init__(message)
        self.obligation = obligation
        self.failure_class = failure_class
        self.subject_id = subject_id
        self.device_id = device_id
        self.scenario_id = scenario_id
        self.score = score
        self.fail_below = fail_below


def create_seeded_rng(seed: int) -> Callable[[], float]:
    """Mulberry32 — same family as TS createSeededRng."""
    state = seed & 0xFFFFFFFF

    def next_float() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = (t ^ (t >> 15)) & 0xFFFFFFFF
        t = (t * (1 | t)) & 0xFFFFFFFF
        t ^= (t + ((t ^ (t >> 7)) * (61 | t))) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return next_float


def derive_model_assist_seed(scenario_seed: int, scenario_id: str) -> int:
    h = scenario_seed & 0xFFFFFFFF
    for ch in scenario_id:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def resolve_scenario_seed(scenario: Mapping[str, Any], rubric: Mapping[str, Any]) -> int:
    if isinstance(scenario.get("seed"), int):
        return int(scenario["seed"]) & 0xFFFFFFFF
    if isinstance(rubric.get("seedDefault"), int):
        return int(rubric["seedDefault"]) & 0xFFFFFFFF
    return 42


def load_committed_rubric() -> dict[str, Any]:
    return json.loads(RUBRIC_PATH.read_text(encoding="utf-8"))


def load_teacher_scenarios(
    manifest_rel: str = "teacher/manifest.json",
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = json.loads((SCENARIOS_DIR / manifest_rel).read_text(encoding="utf-8"))
    scenarios: list[dict[str, Any]] = []
    for rel in manifest.get("scenarios") or []:
        scenarios.append(
            json.loads((SCENARIOS_DIR / rel).read_text(encoding="utf-8"))
        )
    return manifest, scenarios


def score_against_expected(
    actual: Mapping[str, Any],
    expected: Mapping[str, Any],
    rubric: Mapping[str, Any],
) -> dict[str, Any]:
    w = rubric["weights"]
    km = rubric["keywordMatch"]
    components = {
        "routeAction": 1.0 if actual.get("routeAction") == expected.get("routeAction") else 0.0,
        "targetConceptId": (
            1.0
            if actual.get("targetConceptId") == expected.get("targetConceptId")
            else 0.0
        ),
        "mode": (
            1.0
            if expected.get("mode") is None or actual.get("mode") == expected.get("mode")
            else 0.0
        ),
        "rationaleKeywords": 0.0,
    }
    hay = str(actual.get("rationale") or "")
    if km.get("caseInsensitive", True):
        hay = hay.lower()
    matched: list[str] = []
    keywords = list(expected.get("rationaleKeywords") or [])
    for kw in keywords:
        needle = kw.lower() if km.get("caseInsensitive", True) else kw
        if needle in hay:
            matched.append(kw)
    if km.get("requireAll"):
        components["rationaleKeywords"] = (
            1.0 if len(matched) == len(keywords) else 0.0
        )
    else:
        components["rationaleKeywords"] = (
            1.0 if not keywords else len(matched) / len(keywords)
        )
    score = (
        components["routeAction"] * w["routeAction"]
        + components["targetConceptId"] * w["targetConceptId"]
        + components["mode"] * w["mode"]
        + components["rationaleKeywords"] * w["rationaleKeywords"]
    )
    return {"score": score, "components": components, "matchedKeywords": matched}


def infer_route_action(
    *,
    next_concept_id: str,
    mode: str,
    active_concept_id: str,
    spiked: bool,
) -> str:
    if mode == "prerequisite-remediation":
        return "remediate"
    if next_concept_id != active_concept_id and not spiked:
        return "advance"
    return "hold"


def is_friction_spike(friction: Mapping[str, Any], spike_ms: int = HESITATION_SPIKE_MS) -> bool:
    return (
        int(friction["hesitationMs"]) > spike_ms
        or bool(friction["assistanceRequested"])
        or friction["outcome"] == "incorrect"
    )


@dataclass
class ScenarioScore:
    ok: bool
    scenario_id: str
    subject_id: str
    score: float
    components: dict[str, float]
    matched_keywords: list[str]
    seed: int
    model_assist_seed: int
    actual: dict[str, Any]
    expected: dict[str, Any]


@dataclass
class SuiteScore:
    ok: bool
    mean: float
    fail_below: float
    count: int
    results: list[ScenarioScore] = field(default_factory=list)


def router_actual_from_scenario(
    scenario: Mapping[str, Any],
    router: TaskRouter,
) -> dict[str, Any]:
    mastery = {
        cid: ConceptMastery(
            conceptId=m["conceptId"],
            alpha=m["alpha"],
            beta=m["beta"],
            lastExercisedAt=m["lastExercisedAt"],
        )
        for cid, m in (scenario.get("masterySeed") or {}).items()
    }
    friction = scenario["turnFriction"]
    spiked = is_friction_spike(friction)
    out = router.route_turn(
        subject_id=str(scenario["subjectId"]),
        active_concept_id=str(scenario["activeConceptId"]),
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
    rationale = f"{out['routing_rationale']} {out['guidance_directive']}"
    return {
        "routeAction": infer_route_action(
            next_concept_id=out["next_concept_id"],
            mode=out["mode"],
            active_concept_id=str(scenario["activeConceptId"]),
            spiked=spiked,
        ),
        "targetConceptId": out["next_concept_id"],
        "mode": out["mode"],
        "rationale": rationale,
    }


def score_scenario(
    scenario: Mapping[str, Any],
    actual: Mapping[str, Any],
    rubric: Mapping[str, Any],
    *,
    emit_events: bool = True,
) -> ScenarioScore:
    seed = resolve_scenario_seed(scenario, rubric)
    model_assist_seed = derive_model_assist_seed(seed, str(scenario["scenarioId"]))
    rng = create_seeded_rng(model_assist_seed)
    _ = rng()  # exercise seed seam

    scored = score_against_expected(actual, scenario["expected"], rubric)
    pass_ok = scored["score"] >= float(rubric["failBelow"])
    if emit_events:
        logger.info(
            "%s",
            json.dumps(
                {
                    "event": "guidance_eval.score",
                    "outcome": "ok" if pass_ok else "fail",
                    "subjectId": scenario["subjectId"],
                    "deviceId": scenario["deviceId"],
                    "phase": "score",
                    "scenarioId": scenario["scenarioId"],
                    **({} if pass_ok else {"failureClass": "score_below_scenario"}),
                },
                separators=(",", ":"),
            ),
        )
    return ScenarioScore(
        ok=pass_ok,
        scenario_id=str(scenario["scenarioId"]),
        subject_id=str(scenario["subjectId"]),
        score=float(scored["score"]),
        components={k: float(v) for k, v in scored["components"].items()},
        matched_keywords=list(scored["matchedKeywords"]),
        seed=seed,
        model_assist_seed=model_assist_seed,
        actual=dict(actual),
        expected=dict(scenario["expected"]),
    )


def score_teacher_suite(
    *,
    pack_path: Path | None = None,
    throw_on_fail: bool = True,
    emit_events: bool = True,
) -> SuiteScore:
    rubric = load_committed_rubric()
    _, scenarios = load_teacher_scenarios()
    if len(scenarios) > int(rubric["bounds"]["maxScenarios"]):
        raise GuidanceEvalScoreError(
            "suite exceeds maxScenarios",
            obligation="guidance_eval.suite.bounded_scan",
            failure_class="bounded_scan",
        )

    meta = load_task_graph(
        pack_path or TEACHER_PACK,
        subject_id="subj.eval.scorer.boot",
        device_id="ci",
        emit_events=False,
    )
    router = TaskRouter(meta.graph, redis_url=None)
    results: list[ScenarioScore] = []
    for scenario in scenarios:
        actual = router_actual_from_scenario(scenario, router)
        results.append(
            score_scenario(scenario, actual, rubric, emit_events=emit_events)
        )

    mean = sum(r.score for r in results) / len(results) if results else 0.0
    fail_below = float(rubric["failBelow"])
    ok = mean >= fail_below
    if emit_events:
        logger.info(
            "%s",
            json.dumps(
                {
                    "event": "guidance_eval.suite",
                    "outcome": "ok" if ok else "fail",
                    "subjectId": "guidance-eval-suite",
                    "deviceId": "ci",
                    "phase": "aggregate",
                    **({} if ok else {"failureClass": "score_regression"}),
                },
                separators=(",", ":"),
            ),
        )
    summary = SuiteScore(
        ok=ok, mean=mean, fail_below=fail_below, count=len(results), results=results
    )
    if not ok and throw_on_fail:
        worst = min(results, key=lambda r: r.score) if results else None
        raise GuidanceEvalScoreError(
            f"guidance eval suite mean {mean:.4f} < failBelow {fail_below}"
            + (
                f" (worst={worst.scenario_id} score={worst.score:.4f})"
                if worst
                else ""
            ),
            obligation="guidance_eval.suite.score_regression",
            failure_class="score_regression",
            scenario_id=worst.scenario_id if worst else None,
            score=mean,
            fail_below=fail_below,
        )
    return summary
