"""SYNC-06 advisory regression — STATE_VECTOR_REGRESSION .

Loads the same fixture bytes as the TS suite under
``packages/sync-protocol/fixtures/advisories/``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

from sutra_orchestrator.contract_models import CognitiveState
from sutra_orchestrator.crdt_merge import IrreconcilableStateError, merge_states

FIXTURE = (
    Path(__file__).resolve().parents[1]
    / ".."
    / "sync-protocol"
    / "fixtures"
    / "advisories"
    / "state-vector-regression.json"
).resolve()


def emit_advisory_event(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps({"event": "crdt.advisory", **event}) + "\n")
    sys.stdout.flush()


@pytest.fixture(scope="module")
def fixture() -> dict[str, Any]:
    assert FIXTURE.is_file(), f"missing {FIXTURE}"
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_happy_path_dominated_vector_emits_regression_advisory(
    fixture: dict[str, Any],
) -> None:
    assert fixture["specId"] == "SYNC-06"
    local = CognitiveState.model_validate(fixture["local"])
    remote = CognitiveState.model_validate(fixture["remote"])

    merged, advisories = merge_states(local, remote)

    hits = [a for a in advisories if a.code == fixture["expectAdvisoryCode"]]
    assert len(hits) == 1
    for key in fixture["expectRegressedEntries"]:
        assert key in hits[0].detail
    assert merged.stateVector["session"] == fixture["expectMergedSession"]
    assert merged.subjectId == fixture["local"]["subjectId"]

    emit_advisory_event(
        {
            "outcome": "ok",
            "code": fixture["expectAdvisoryCode"],
            "subjectId": merged.subjectId,
            "deviceId": fixture["remote"]["deviceIds"][0],
            "regressed": fixture["expectRegressedEntries"],
        }
    )


def test_edge_equal_vectors_no_regression_advisory(fixture: dict[str, Any]) -> None:
    local = CognitiveState.model_validate(fixture["local"])
    twin = CognitiveState.model_validate(fixture["local"])
    _, advisories = merge_states(local, twin)
    assert not any(a.code == "STATE_VECTOR_REGRESSION" for a in advisories)
    emit_advisory_event(
        {
            "outcome": "ok",
            "kind": "edge.equal-vectors",
            "subjectId": fixture["local"]["subjectId"],
        }
    )


def test_edge_remote_ahead_not_strict_domination(fixture: dict[str, Any]) -> None:
    local = CognitiveState.model_validate(fixture["local"])
    ahead_raw = json.loads(json.dumps(fixture["remote"]))
    ahead_raw["stateVector"]["session"] = "000000009000000:000000:edge-bbbb"
    ahead = CognitiveState.model_validate(ahead_raw)
    merged, advisories = merge_states(local, ahead)
    assert not any(a.code == "STATE_VECTOR_REGRESSION" for a in advisories)
    assert merged.stateVector["session"] == ahead.stateVector["session"]
    emit_advisory_event(
        {
            "outcome": "ok",
            "kind": "edge.partial-advance",
            "subjectId": fixture["local"]["subjectId"],
            "deviceId": ahead.deviceIds[0],
        }
    )


def test_sovereignty_subject_mismatch_still_refuses(fixture: dict[str, Any]) -> None:
    local = CognitiveState.model_validate(fixture["local"])
    foreign = CognitiveState.model_validate(
        {**fixture["remote"], "subjectId": "other-subject"}
    )
    with pytest.raises(IrreconcilableStateError):
        merge_states(local, foreign)
    emit_advisory_event(
        {
            "outcome": "ok",
            "kind": "subjectIsolation",
            "code": "SUBJECT_MISMATCH",
        }
    )
