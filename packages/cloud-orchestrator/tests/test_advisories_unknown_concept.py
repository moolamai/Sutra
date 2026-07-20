"""SYNC-06 advisory regression — UNKNOWN_CONCEPT_QUARANTINED .

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
    / "unknown-concept-quarantined.json"
).resolve()


def emit_advisory_event(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps({"event": "crdt.advisory", **event}) + "\n")
    sys.stdout.flush()


@pytest.fixture(scope="module")
def fixture() -> dict[str, Any]:
    assert FIXTURE.is_file(), f"missing {FIXTURE}"
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_happy_path_unknown_concepts_emit_quarantine_advisory(
    fixture: dict[str, Any],
) -> None:
    assert fixture["specId"] == "SYNC-06"
    local = CognitiveState.model_validate(fixture["local"])
    remote = CognitiveState.model_validate(fixture["remote"])
    known = set(fixture["knownConceptIds"])

    merged, advisories = merge_states(local, remote, known_concept_ids=known)

    hits = [a for a in advisories if a.code == fixture["expectAdvisoryCode"]]
    assert len(hits) == 1
    for cid in fixture["expectQuarantinedIds"]:
        assert cid in hits[0].detail
    assert sorted(merged.mastery.keys()) == sorted(fixture["expectMasteryKeysPreserved"])
    assert merged.mastery["rogue.unknown.concept"].alpha["edge-bbbb"] == 1.0
    assert merged.subjectId == fixture["local"]["subjectId"]

    emit_advisory_event(
        {
            "outcome": "ok",
            "code": fixture["expectAdvisoryCode"],
            "subjectId": merged.subjectId,
            "deviceId": fixture["remote"]["deviceIds"][0],
            "quarantined": fixture["expectQuarantinedIds"],
        }
    )


def test_edge_without_known_concepts_no_quarantine_advisory(
    fixture: dict[str, Any],
) -> None:
    local = CognitiveState.model_validate(fixture["local"])
    remote = CognitiveState.model_validate(fixture["remote"])
    merged, advisories = merge_states(local, remote)
    assert not any(a.code == "UNKNOWN_CONCEPT_QUARANTINED" for a in advisories)
    assert "rogue.unknown.concept" in merged.mastery
    emit_advisory_event(
        {
            "outcome": "ok",
            "kind": "edge.compat-no-graph",
            "subjectId": fixture["local"]["subjectId"],
        }
    )


def test_edge_all_mastery_keys_known_zero_quarantine(
    fixture: dict[str, Any],
) -> None:
    local = CognitiveState.model_validate(fixture["local"])
    remote = CognitiveState.model_validate(fixture["remote"])
    known = set(fixture["knownConceptIds"]) | set(fixture["expectQuarantinedIds"])
    _, advisories = merge_states(local, remote, known_concept_ids=known)
    assert not any(a.code == "UNKNOWN_CONCEPT_QUARANTINED" for a in advisories)
    emit_advisory_event(
        {
            "outcome": "ok",
            "kind": "edge.all-known",
            "subjectId": fixture["local"]["subjectId"],
        }
    )


def test_sovereignty_subject_mismatch_still_refuses(
    fixture: dict[str, Any],
) -> None:
    local = CognitiveState.model_validate(fixture["local"])
    foreign = CognitiveState.model_validate(
        {**fixture["remote"], "subjectId": "other-subject"}
    )
    with pytest.raises(IrreconcilableStateError):
        merge_states(
            local,
            foreign,
            known_concept_ids=set(fixture["knownConceptIds"]),
        )
    emit_advisory_event(
        {
            "outcome": "ok",
            "kind": "subjectIsolation",
            "code": "SUBJECT_MISMATCH",
        }
    )
