"""Field-parity audit: Pydantic contract_models vs Zod contract.ts.

Shared golden fixture: packages/sync-protocol/fixtures/wire-parity/golden-envelopes.json
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from sutra_orchestrator.contract_models import (
    AgentTurnRequest,
    AgentTurnResponse,
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SyncAuditItem,
    SyncAuditPage,
    SyncRequest,
    SyncResponse,
)

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "sync-protocol"
    / "fixtures"
    / "wire-parity"
    / "golden-envelopes.json"
)


def _hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


@pytest.fixture(scope="module")
def golden() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_golden_fixture_parses_every_wire_envelope(golden: dict) -> None:
    state = CognitiveState.model_validate(golden["cognitiveState"])
    friction = FrictionSample.model_validate(golden["friction"])

    sync_req = SyncRequest.model_validate(
        {**golden["syncRequest"], "edgeState": golden["cognitiveState"]}
    )
    sync_res = SyncResponse.model_validate(
        {**golden["syncResponse"], "mergedState": golden["cognitiveState"]}
    )
    turn_req = AgentTurnRequest.model_validate(
        {**golden["agentTurnRequest"], "friction": golden["friction"]}
    )
    turn_res = AgentTurnResponse.model_validate(golden["agentTurnResponse"])

    assert state.subjectId == "anika-k"
    assert friction.capturedAt.startswith("000000001000000")
    assert sync_req.syncAttemptId == "550e8400-e29b-41d4-a716-446655440000"
    assert sync_res.advisories[0].code == "CLOCK_SKEW_CLAMPED"
    assert turn_req.subjectId == state.subjectId
    assert turn_res.masteryEstimate == 0.42

    audit_item = SyncAuditItem.model_validate(golden["syncAuditItem"])
    audit_page = SyncAuditPage.model_validate(golden["syncAuditPage"])
    assert audit_item.subjectId == state.subjectId
    assert audit_page.subjectId == state.subjectId
    assert audit_page.items[0].syncAttemptId == audit_item.syncAttemptId
    assert audit_page.nextCursor is None
    # stateVector* remain HLC pattern strings (not ISO date-time).
    session = audit_item.stateVectorAfter["session"]
    assert isinstance(session, str)
    assert "T" not in session

    # Round-trip dump stays JSON-serializable and keeps HLC as plain strings.
    dumped = sync_req.model_dump(mode="json")
    assert isinstance(dumped["edgeState"]["stateVector"]["session"], str)
    assert "T" not in dumped["edgeState"]["stateVector"]["session"]  # not date-time


def test_sync_attempt_id_requires_uuid_not_min_length_8() -> None:
    """Parity fix #1 — former min_length=8 accepted non-UUIDs Zod rejects."""
    state = CognitiveState.model_validate(
        json.loads(FIXTURE.read_text(encoding="utf-8"))["cognitiveState"]
    )
    with pytest.raises(ValidationError) as err:
        SyncRequest(
            protocolVersion="1.0.0",
            deviceId="edge-aaaa",
            edgeState=state,
            lastKnownCloudVector={},
            syncAttemptId="short-id",  # length >= 8 historically, not a UUID
        )
    assert "syncAttemptId" in str(err.value)


def test_hlc_fields_reject_datetime_shaped_strings() -> None:
    """Parity edge — HLC stays a pattern string, never format:date-time."""
    with pytest.raises(ValidationError) as err:
        FrictionSample(
            conceptId="math.ratios",
            hesitationMs=1,
            inputVelocity=1.0,
            revisionCount=0,
            assistanceRequested=False,
            outcome="correct",
            capturedAt="2024-01-01T00:00:00Z",
        )
    assert "pattern" in str(err.value).lower() or "string_pattern_mismatch" in str(err.value)


def test_active_concept_null_ok_empty_string_rejected(golden: dict) -> None:
    """None vs missing: null is valid; empty string is not (Zod .min(1).nullable())."""
    payload = dict(golden["cognitiveState"])
    payload["activeConceptId"] = None
    assert CognitiveState.model_validate(payload).activeConceptId is None

    payload["activeConceptId"] = ""
    with pytest.raises(ValidationError):
        CognitiveState.model_validate(payload)

    del payload["activeConceptId"]
    with pytest.raises(ValidationError):
        # Required field — missing key must fail (not optional).
        CognitiveState.model_validate(payload)


def test_mastery_shard_values_must_be_nonnegative(golden: dict) -> None:
    """Parity fix — alpha/beta shards mirror Zod nonnegative()."""
    with pytest.raises(ValidationError):
        ConceptMastery(
            conceptId="math.ratios",
            alpha={"edge-aaaa": -1.0},
            beta={"edge-aaaa": 1.0},
            lastExercisedAt=_hlc(1_000_000, 0, "edge-aaaa"),
        )


def test_subject_isolation_empty_subject_id_rejected(golden: dict) -> None:
    payload = dict(golden["agentTurnRequest"])
    payload["friction"] = golden["friction"]
    payload["subjectId"] = ""
    with pytest.raises(ValidationError) as err:
        AgentTurnRequest.model_validate(payload)
    assert "subjectId" in str(err.value)


def test_state_vector_values_must_be_hlc(golden: dict) -> None:
    payload = dict(golden["cognitiveState"])
    payload["stateVector"] = {"session": "not-an-hlc"}
    with pytest.raises(ValidationError):
        CognitiveState.model_validate(payload)


def test_protocol_version_is_required(golden: dict) -> None:
    """Parity fix — no silent default filler for missing protocolVersion."""
    payload = dict(golden["cognitiveState"])
    del payload["protocolVersion"]
    with pytest.raises(ValidationError):
        CognitiveState.model_validate(payload)
