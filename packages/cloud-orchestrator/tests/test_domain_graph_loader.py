"""Python load_task_graph — same fixture bytes as TS loadTaskGraph."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sutra_orchestrator.domain_graph_loader import (
    TaskGraphLoadError,
    graph_semantics_fingerprint,
    load_task_graph,
    load_task_graph_from_object,
    resolve_thresholds,
)
from sutra_orchestrator.task_router import ADVANCE_THRESHOLD, REMEDIATE_THRESHOLD

REPO_PACKAGES = Path(__file__).resolve().parents[2]
GOLDEN = REPO_PACKAGES / "domain-loader" / "fixtures" / "golden-packs"
VALID = GOLDEN / "valid-dag.json"
CYCLIC = GOLDEN / "cyclic-reject.json"
MISSING = GOLDEN / "missing-node-reject.json"


def test_load_task_graph_happy_path() -> None:
    meta = load_task_graph(
        VALID,
        subject_id="subj.py.load.valid",
        device_id="dev-py",
        emit_events=False,
    )
    assert meta.pack_id == "golden-valid-dag"
    assert meta.version_stamp == "golden-valid-dag@1.0.0"
    assert meta.advance_threshold == ADVANCE_THRESHOLD
    assert meta.remediate_threshold == REMEDIATE_THRESHOLD
    ratios = meta.graph.nodes["math.ratios"]
    assert ratios.prerequisites == ("math.fractions",)


def test_load_task_graph_rejects_cycle() -> None:
    with pytest.raises(TaskGraphLoadError) as exc:
        load_task_graph(
            CYCLIC,
            subject_id="subj.py.load.cycle",
            device_id="dev-py",
            emit_events=False,
        )
    assert exc.value.failure_class == "cycle"
    assert exc.value.cycle_path is not None
    assert exc.value.cycle_path[0] == exc.value.cycle_path[-1]


def test_load_task_graph_rejects_missing_node() -> None:
    with pytest.raises(TaskGraphLoadError) as exc:
        load_task_graph(
            MISSING,
            subject_id="subj.py.load.missing",
            device_id="dev-py",
            emit_events=False,
        )
    assert exc.value.failure_class == "missing_edge_endpoint"


def test_missing_thresholds_never_silent_zero() -> None:
    raw = json.loads(VALID.read_text(encoding="utf-8"))
    del raw["thresholds"]
    meta = load_task_graph_from_object(
        raw,
        subject_id="subj.py.load.thr",
        device_id="dev-py",
        emit_events=False,
    )
    assert meta.advance_threshold == ADVANCE_THRESHOLD
    assert meta.remediate_threshold == REMEDIATE_THRESHOLD
    adv, rem = resolve_thresholds({"advanceThreshold": 0, "remediateThreshold": 0})
    assert adv == ADVANCE_THRESHOLD
    assert rem == REMEDIATE_THRESHOLD


def test_fingerprint_matches_committed_semantics_golden() -> None:
    meta = load_task_graph(
        VALID,
        subject_id="subj.py.load.fp",
        device_id="dev-py",
        emit_events=False,
    )
    fp = graph_semantics_fingerprint(meta)
    expected = json.loads((GOLDEN / "valid-dag.semantics.json").read_text(encoding="utf-8"))
    assert fp == expected


def test_task_router_reexports_load_task_graph() -> None:
    from sutra_orchestrator.task_router import load_task_graph as reexport

    meta = reexport(
        str(VALID),
        subject_id="subj.py.reexport",
        device_id="dev-py",
        emit_events=False,
    )
    assert meta.pack_id == "golden-valid-dag"  # type: ignore[union-attr]
