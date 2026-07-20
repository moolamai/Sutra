"""Router checkpoint serialization schema."""

from __future__ import annotations

import logging
import uuid

import pytest
from pydantic import ValidationError

from sutra_orchestrator.checkpointer import (
    ADVISORY_CORRUPT_RESET,
    ADVISORY_SUBJECT_MISMATCH,
    ADVISORY_VERSION_UNSUPPORTED,
    HysteresisContext,
    RouterCheckpointPayload,
    checkpoint_redis_key,
    checkpoint_thread_id,
    dumps_router_checkpoint,
    loads_router_checkpoint,
    parse_checkpoint_key_subject,
    payload_from_router_state,
)
from sutra_orchestrator.contract_models import ConceptMastery, FrictionSample
from sutra_orchestrator.task_router import ADVANCE_THRESHOLD, REMEDIATE_THRESHOLD


def _sample_payload(subject_id: str, *, depth: int = 1) -> RouterCheckpointPayload:
    thread = checkpoint_thread_id(subject_id)
    return RouterCheckpointPayload(
        subject_id=subject_id,
        thread_id=thread,
        active_concept_id="math.fractions",
        next_concept_id="math.fractions",
        mode="prerequisite-remediation",
        remediation_depth=depth,
        guidance_directive="GUIDE concept='Fractions' mode=prerequisite-remediation remediation_depth=1",
        routing_rationale="friction(...) → SPIKE | looped back",
        hysteresis=HysteresisContext(
            advance_threshold=ADVANCE_THRESHOLD,
            remediate_threshold=REMEDIATE_THRESHOLD,
            last_friction_spiked=True,
            hold_position=False,
        ),
        effects_committed=("remediate_prereq",),
        last_completed_node="remediate_prereq",
    )


def test_happy_path_round_trip_preserves_depth_and_hysteresis() -> None:
    subject = f"ckpt-{uuid.uuid4().hex[:8]}"
    payload = _sample_payload(subject, depth=2)
    raw = dumps_router_checkpoint(payload)
    result = loads_router_checkpoint(
        raw, expected_subject_id=subject, expected_thread_id=payload.thread_id
    )
    assert result.outcome == "hit"
    assert result.advisory is None
    assert result.payload is not None
    assert result.payload.remediation_depth == 2
    assert result.payload.hysteresis.advance_threshold == ADVANCE_THRESHOLD
    assert result.payload.hysteresis.remediate_threshold == REMEDIATE_THRESHOLD
    assert result.payload.hysteresis.last_friction_spiked is True
    assert result.payload.effects_committed == ("remediate_prereq",)


def test_edge_corrupt_blob_starts_clean_with_advisory(
    caplog: pytest.LogCaptureFixture,
) -> None:
    subject = f"ckpt-{uuid.uuid4().hex[:8]}"
    with caplog.at_level(logging.WARNING, logger="sutra_orchestrator.checkpointer"):
        bad = loads_router_checkpoint(b"{not-json", expected_subject_id=subject)
        trunc = loads_router_checkpoint(
            b'{"schema_version":1,"subject_id":"', expected_subject_id=subject
        )
    assert bad.start_clean and bad.outcome == "corrupt_reset"
    assert bad.advisory == ADVISORY_CORRUPT_RESET
    assert trunc.start_clean and trunc.advisory == ADVISORY_CORRUPT_RESET
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "outcome=corrupt_reset" in joined
    assert "utterance" not in joined


def test_edge_subject_mismatch_and_key_namespace() -> None:
    a = f"subj-a-{uuid.uuid4().hex[:6]}"
    b = f"subj-b-{uuid.uuid4().hex[:6]}"
    payload = _sample_payload(a)
    raw = dumps_router_checkpoint(payload)

    mismatch = loads_router_checkpoint(raw, expected_subject_id=b)
    assert mismatch.start_clean
    assert mismatch.outcome == "subject_mismatch"
    assert mismatch.advisory == ADVISORY_SUBJECT_MISMATCH

    key_a = checkpoint_redis_key(a, payload.thread_id)
    key_b = checkpoint_redis_key(b, payload.thread_id)
    assert key_a != key_b
    assert parse_checkpoint_key_subject(key_a) == a
    assert parse_checkpoint_key_subject(key_b) == b
    with pytest.raises(ValueError):
        checkpoint_redis_key("bad:subject", "thread")


def test_edge_unsupported_version_starts_clean() -> None:
    subject = f"ckpt-{uuid.uuid4().hex[:8]}"
    blob = (
        b'{"schema_version":99,"subject_id":"%s","thread_id":"t",'
        b'"active_concept_id":"x","next_concept_id":"x","mode":"guided",'
        b'"remediation_depth":0}' % subject.encode()
    )
    result = loads_router_checkpoint(blob, expected_subject_id=subject)
    assert result.start_clean
    assert result.outcome == "version_unsupported"
    assert result.advisory == ADVISORY_VERSION_UNSUPPORTED


def test_hysteresis_rejects_inverted_thresholds() -> None:
    with pytest.raises(ValidationError):
        HysteresisContext(advance_threshold=0.3, remediate_threshold=0.9)


def test_payload_from_router_state_maps_depth_and_spike() -> None:
    subject = f"ckpt-{uuid.uuid4().hex[:8]}"
    friction = FrictionSample(
        conceptId="math.ratios",
        hesitationMs=20_000,
        inputVelocity=1.0,
        revisionCount=1,
        assistanceRequested=True,
        outcome="incorrect",
        capturedAt="000000001000000:000000:edge-aaaa",
    )
    mastery = {
        "math.ratios": ConceptMastery(
            conceptId="math.ratios",
            alpha={"edge-aaaa": 1.0},
            beta={"edge-aaaa": 1.0},
            lastExercisedAt="000000001000000:000000:edge-aaaa",
        )
    }
    state = {
        "subject_id": subject,
        "active_concept_id": "math.ratios",
        "mode": "guided",
        "friction": friction,
        "mastery": mastery,
        "next_concept_id": "math.fractions",
        "routing_rationale": "friction(...) → SPIKE",
        "guidance_directive": "GUIDE concept='Ratios' mode=guided remediation_depth=0",
        "remediation_depth": 0,
    }
    thread = checkpoint_thread_id(subject, session_id="sess-1")
    payload = payload_from_router_state(state, thread_id=thread)
    assert payload.thread_id.startswith("session:")
    assert payload.hysteresis.last_friction_spiked is True
    assert "utterance" not in payload.model_dump_json()
