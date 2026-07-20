"""SYNC-02 / SYNC-06 — HLC skew-clamp advisory regression
And advisory-surface conformance doc checks .

Loads the same fixture bytes as the TS suite under
``packages/sync-protocol/fixtures/advisories/skew-clamp.json``.
"""

from __future__ import annotations

import json
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from sutra_orchestrator.contract_models import CognitiveState
from sutra_orchestrator.crdt_merge import (
    MAX_CLOCK_SKEW_MS,
    IrreconcilableStateError,
    merge_states,
)

_SYNC_PROTOCOL = (Path(__file__).resolve().parents[1] / ".." / "sync-protocol").resolve()
FIXTURE = (_SYNC_PROTOCOL / "fixtures" / "advisories" / "skew-clamp.json").resolve()
ADVISORY_SURFACE_DOC = (_SYNC_PROTOCOL / "docs" / "advisory-surface.md").resolve()
SYNC_ADVISORY_SCHEMA = (_SYNC_PROTOCOL / "schemas" / "SyncAdvisory.json").resolve()


def emit_advisory_event(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps({"event": "crdt.advisory", **event}) + "\n")
    sys.stdout.flush()


@pytest.fixture(scope="module")
def fixture() -> dict[str, Any]:
    assert FIXTURE.is_file(), f"missing {FIXTURE}"
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _hlc(physical: str, logical: str, device_id: str) -> str:
    return f"{physical}:{logical}:{device_id}"


def build_remote(fx: dict[str, Any], case_key: str) -> CognitiveState:
    case = fx["cases"][case_key]
    raw = deepcopy(fx["remoteTemplate"])
    device_id = raw["deviceIds"][0]
    raw["profile"]["updatedAt"] = _hlc(
        case["physical"], case["logicalProfile"], device_id
    )
    raw["stateVector"] = {
        "session": _hlc(case["physical"], case["logicalSession"], device_id),
        "profile": _hlc(case["physical"], case["logicalProfile"], device_id),
        f"device:{device_id}": _hlc(
            case["physical"], case["logicalDevice"], device_id
        ),
    }
    return CognitiveState.model_validate(raw)


def test_named_constant_matches_shared_fixture(fixture: dict[str, Any]) -> None:
    assert fixture["MAX_CLOCK_SKEW_MS"] == MAX_CLOCK_SKEW_MS
    expected_horizon = f"{fixture['nowMs'] + fixture['MAX_CLOCK_SKEW_MS']:015d}"
    assert fixture["horizonPhysical"] == expected_horizon
    emit_advisory_event(
        {
            "outcome": "ok",
            "kind": "sharedConstant",
            "MAX_CLOCK_SKEW_MS": MAX_CLOCK_SKEW_MS,
            "subjectId": fixture["local"]["subjectId"],
        }
    )


def test_in_bound_no_clock_skew_advisory(fixture: dict[str, Any]) -> None:
    assert fixture["specId"] == "SYNC-02"
    local = CognitiveState.model_validate(fixture["local"])
    remote = build_remote(fixture, "inBound")

    merged, advisories = merge_states(local, remote, now_ms=fixture["nowMs"])

    assert not any(a.code == "CLOCK_SKEW_CLAMPED" for a in advisories)
    assert merged.subjectId == local.subjectId
    assert merged.profile.updatedAt == remote.profile.updatedAt
    emit_advisory_event(
        {
            "outcome": "ok",
            "kind": "inBound",
            "subjectId": merged.subjectId,
            "deviceId": remote.deviceIds[0],
        }
    )


def test_at_bound_no_clock_skew_advisory(fixture: dict[str, Any]) -> None:
    local = CognitiveState.model_validate(fixture["local"])
    remote = build_remote(fixture, "atBound")

    merged, advisories = merge_states(local, remote, now_ms=fixture["nowMs"])

    assert not any(a.code == "CLOCK_SKEW_CLAMPED" for a in advisories)
    assert merged.profile.updatedAt == remote.profile.updatedAt
    emit_advisory_event(
        {
            "outcome": "ok",
            "kind": "atBound",
            "subjectId": merged.subjectId,
            "deviceId": remote.deviceIds[0],
        }
    )


def test_beyond_bound_clamped_advisory_payload(fixture: dict[str, Any]) -> None:
    case = fixture["cases"]["beyondBound"]
    local = CognitiveState.model_validate(fixture["local"])
    remote = build_remote(fixture, "beyondBound")
    original_profile = remote.profile.updatedAt

    merged, advisories = merge_states(local, remote, now_ms=fixture["nowMs"])

    hits = [a for a in advisories if a.code == "CLOCK_SKEW_CLAMPED"]
    assert len(hits) == 1
    for pair in case["expectOriginalToClamped"]:
        assert pair in hits[0].detail
    assert original_profile in hits[0].detail
    assert case["expectMergedProfileUpdatedAt"] in hits[0].detail
    assert merged.profile.updatedAt == case["expectMergedProfileUpdatedAt"]
    assert merged.stateVector["session"] == case["expectMergedSession"]

    emit_advisory_event(
        {
            "outcome": "ok",
            "code": "CLOCK_SKEW_CLAMPED",
            "subjectId": merged.subjectId,
            "deviceId": remote.deviceIds[0],
            "originalProfile": original_profile,
            "clampedProfile": case["expectMergedProfileUpdatedAt"],
        }
    )


def test_edge_replay_beyond_bound_idempotent(fixture: dict[str, Any]) -> None:
    local = CognitiveState.model_validate(fixture["local"])
    remote = build_remote(fixture, "beyondBound")

    first, first_adv = merge_states(local, remote, now_ms=fixture["nowMs"])
    second, second_adv = merge_states(first, remote, now_ms=fixture["nowMs"])

    assert second.model_dump(mode="json") == first.model_dump(mode="json")
    assert sum(1 for a in second_adv if a.code == "CLOCK_SKEW_CLAMPED") == 1
    assert sum(1 for a in first_adv if a.code == "CLOCK_SKEW_CLAMPED") == 1
    emit_advisory_event(
        {
            "outcome": "ok",
            "kind": "edge.replay-idempotent",
            "subjectId": fixture["local"]["subjectId"],
            "deviceId": remote.deviceIds[0],
        }
    )


def test_sovereignty_subject_mismatch_still_refuses(fixture: dict[str, Any]) -> None:
    local = CognitiveState.model_validate(fixture["local"])
    remote = build_remote(fixture, "beyondBound")
    foreign = remote.model_copy(update={"subjectId": "other-subject"})
    with pytest.raises(IrreconcilableStateError):
        merge_states(local, foreign, now_ms=fixture["nowMs"])
    emit_advisory_event(
        {
            "outcome": "ok",
            "kind": "subjectIsolation",
            "code": "SUBJECT_MISMATCH",
        }
    )


def test_conformance_doc_lists_every_sync_advisory_code() -> None:
    assert ADVISORY_SURFACE_DOC.is_file(), f"missing {ADVISORY_SURFACE_DOC}"
    doc = ADVISORY_SURFACE_DOC.read_text(encoding="utf-8")
    schema = json.loads(SYNC_ADVISORY_SCHEMA.read_text(encoding="utf-8"))
    codes = schema["properties"]["code"]["enum"]
    assert len(codes) == 5
    for code in codes:
        assert f"`{code}`" in doc
    assert "MAX_CLOCK_SKEW_MS" in doc
    assert "skew-clamp.json" in doc
    assert "original→clamped" in doc
    emit_advisory_event(
        {"outcome": "ok", "kind": "conformanceDoc.catalogue", "codes": codes}
    )


def test_conformance_doc_subject_mismatch_is_abort_not_advisory() -> None:
    doc = ADVISORY_SURFACE_DOC.read_text(encoding="utf-8")
    assert "SUBJECT_MISMATCH" in doc
    assert "Not advisories" in doc
    assert "subject isolation" in doc.lower()
    emit_advisory_event(
        {
            "outcome": "ok",
            "kind": "conformanceDoc.subjectIsolation",
            "code": "SUBJECT_MISMATCH",
        }
    )


def test_conformance_doc_replay_and_observability() -> None:
    doc = ADVISORY_SURFACE_DOC.read_text(encoding="utf-8")
    assert "Idempotent replay" in doc
    assert "crdt.advisory" in doc
    assert "subjectId" in doc
    emit_advisory_event({"outcome": "ok", "kind": "conformanceDoc.edgeContracts"})
