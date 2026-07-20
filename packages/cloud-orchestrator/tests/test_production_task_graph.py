"""Production task-graph resolution — file / Postgres / TASK_GRAPH_PACK."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sutra_orchestrator.contract_models import ConceptMastery, FrictionSample
from sutra_orchestrator.domain_graph_loader import (
    ENV_TASK_GRAPH_PACK,
    TaskGraphLoadError,
    bundled_demo_pack_path,
    resolve_production_task_graph,
)
from sutra_orchestrator.task_router import TaskRouter, demo_task_graph

REPO_PACKAGES = Path(__file__).resolve().parents[2]
GOLDEN = REPO_PACKAGES / "domain-loader" / "fixtures" / "golden-packs"
CYCLIC = GOLDEN / "cyclic-reject.json"
MISSING = GOLDEN / "missing-node-reject.json"
DEMO = bundled_demo_pack_path()


def test_bundled_demo_pack_exists() -> None:
    assert DEMO.is_file()
    assert DEMO.name == "demo-math-sd-slice.json"


def test_resolve_production_defaults_to_teacher_pack() -> None:
    meta = resolve_production_task_graph(
        env={},
        subject_id="subj.prod.default",
        device_id="cloud-test",
        emit_events=False,
    )
    assert meta.pack_id == "teacher-cbse-slice"
    assert meta.version_stamp == "teacher-cbse-slice@1.0.0"
    assert "math.fractions" in meta.graph.nodes
    assert "math.unitary_method" in meta.graph.nodes
    assert meta.graph.advance_threshold == 0.85
    assert meta.graph.remediate_threshold == 0.4


def test_resolve_production_honors_task_graph_pack_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pack = json.loads(DEMO.read_text(encoding="utf-8"))
    pack["packId"] = "env-override-pack"
    pack["version"] = "2.0.0"
    path = tmp_path / "override.json"
    path.write_text(json.dumps(pack), encoding="utf-8")
    monkeypatch.setenv(ENV_TASK_GRAPH_PACK, str(path))
    meta = resolve_production_task_graph(
        subject_id="subj.prod.env",
        device_id="cloud-test",
        emit_events=False,
    )
    assert meta.pack_id == "env-override-pack"
    assert meta.version_stamp == "env-override-pack@2.0.0"


def test_resolve_production_postgres_row_missing_thresholds() -> None:
    row = json.loads(DEMO.read_text(encoding="utf-8"))
    del row["thresholds"]
    meta = resolve_production_task_graph(
        pack_row=row,
        subject_id="subj.prod.pg",
        device_id="cloud-test",
        emit_events=False,
    )
    assert meta.advance_threshold == 0.85
    assert meta.remediate_threshold == 0.4
    assert meta.graph.advance_threshold == 0.85
    assert meta.source_path == "<postgres>"


def test_resolve_production_rejects_cyclic_pack() -> None:
    with pytest.raises(TaskGraphLoadError) as exc:
        resolve_production_task_graph(
            pack_path=CYCLIC,
            subject_id="subj.prod.cycle",
            device_id="cloud-test",
            emit_events=False,
        )
    assert exc.value.failure_class == "cycle"


def test_resolve_production_rejects_missing_node() -> None:
    with pytest.raises(TaskGraphLoadError) as exc:
        resolve_production_task_graph(
            pack_path=MISSING,
            subject_id="subj.prod.missing",
            device_id="cloud-test",
            emit_events=False,
        )
    assert exc.value.failure_class == "missing_edge_endpoint"


def test_router_routes_on_file_backed_pack() -> None:
    meta = resolve_production_task_graph(
        pack_path=DEMO,
        subject_id="subj.prod.route",
        device_id="cloud-test",
        emit_events=False,
    )
    router = TaskRouter(meta.graph, redis_url=None)
    device = "dev-prod"
    mastery = {
        "math.fractions": ConceptMastery(
            conceptId="math.fractions",
            alpha={device: 20.0},
            beta={device: 1.0},
            lastExercisedAt="001700000000000:000000:dev-prod",
        ),
        # Demo pack has a second root (sd.networking); CAST-05.1 blocks advance until assessed.
        "sd.networking": ConceptMastery(
            conceptId="sd.networking",
            alpha={device: 20.0},
            beta={device: 1.0},
            lastExercisedAt="001700000000000:000002:dev-prod",
        ),
    }
    # High mastery + no friction spike → advance along pack edges.
    out = router.route_turn(
        subject_id="subj.prod.route",
        active_concept_id="math.fractions",
        mode="exploratory",
        friction=FrictionSample(
            conceptId="math.fractions",
            hesitationMs=100,
            inputVelocity=3.0,
            revisionCount=0,
            assistanceRequested=False,
            outcome="correct",
            capturedAt="001700000000000:000001:dev-prod",
        ),
        mastery=mastery,
    )
    assert out["next_concept_id"] == "math.ratios"
    assert "0.85" in out["routing_rationale"]


def test_demo_task_graph_loads_bundled_pack_not_inline_duplicate() -> None:
    g = demo_task_graph()
    assert "math.percentages" in g.nodes
    assert g.nodes["math.ratios"].prerequisites == ("math.fractions",)
    assert g.advance_threshold == 0.85


def test_main_module_does_not_call_demo_on_production_path() -> None:
    import sutra_orchestrator.main as main_mod
    import ast

    tree = ast.parse(Path(main_mod.__file__).read_text(encoding="utf-8"))
    imported_names: set[str] = set()
    called_names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                imported_names.add(alias.asname or alias.name)
        elif isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Name):
                called_names.add(fn.id)
            elif isinstance(fn, ast.Attribute):
                called_names.add(fn.attr)
    assert "resolve_production_task_graph" in called_names
    assert "demo_task_graph" not in imported_names
    assert "demo_task_graph" not in called_names
    src = Path(main_mod.__file__).read_text(encoding="utf-8")
    assert "TASK_GRAPH_PACK" in src

def test_main_lifespan_wires_file_backed_graph(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "permissive_dev")
    monkeypatch.delenv(ENV_TASK_GRAPH_PACK, raising=False)

    from fastapi.testclient import TestClient
    import sutra_orchestrator.main as main_mod

    with TestClient(main_mod.app) as client:
        assert client.app.state.task_graph_pack_id == "teacher-cbse-slice"
        assert client.app.state.task_graph_version_stamp == "teacher-cbse-slice@1.0.0"
        r = client.get("/v1/health")
        assert r.status_code in (200, 503)
