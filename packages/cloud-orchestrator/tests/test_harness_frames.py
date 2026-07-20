"""Pydantic HarnessFrame mirror — shared fixture parity with Zod harness_frames.ts."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from pydantic import ValidationError

from sutra_orchestrator.contract_models import (
    HARNESS_FRAME_TYPES,
    HarnessFrame,
    ToolStatusFrame,
    assert_monotonic_sequence,
    parse_harness_frame,
)

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "sync-protocol"
    / "fixtures"
    / "wire-parity"
    / "harness-frames.json"
)


@pytest.fixture(scope="module")
def golden() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_shared_fixture_parses_every_frame_variant(golden: dict) -> None:
    frames = [HarnessFrame.model_validate(raw).root for raw in golden["frames"]]
    assert len(frames) == len(HARNESS_FRAME_TYPES)
    assert {f.type for f in frames} == set(HARNESS_FRAME_TYPES)
    for frame in frames:
        assert frame.subjectId == "anika-k"
        dumped = HarnessFrame(frame).model_dump(mode="json")
        assert dumped["type"] == frame.type
        assert "leakedLearnerName" not in dumped


def test_round_trip_dump_matches_fixture_field_set(golden: dict) -> None:
    """Byte-identical field semantics: dump restores the same keys Zod accepts."""
    for raw in golden["frames"]:
        parsed = HarnessFrame.model_validate(raw)
        dumped = parsed.model_dump(mode="json", exclude_none=True)
        # Every fixture key must survive; no extras introduced.
        for key, value in raw.items():
            assert dumped[key] == value
        assert set(dumped.keys()) == set(raw.keys())


def test_rejects_unknown_type_and_negative_sequence(golden: dict) -> None:
    thought = dict(golden["frames"][1])
    thought["type"] = "NOT_A_FRAME"
    with pytest.raises(ValidationError) as err:
        HarnessFrame.model_validate(thought)
    assert "type" in str(err.value)

    thought = dict(golden["frames"][1])
    thought["sequenceIndex"] = -1
    with pytest.raises(ValidationError) as err:
        HarnessFrame.model_validate(thought)
    assert "sequenceIndex" in str(err.value)


def test_unknown_keys_forbidden_at_wire_boundary(golden: dict) -> None:
    payload = dict(golden["frames"][1])
    payload["leakedLearnerName"] = "should-not-survive"
    with pytest.raises(ValidationError) as err:
        HarnessFrame.model_validate(payload)
    assert "leakedLearnerName" in str(err.value) or "extra" in str(err.value).lower()


def test_optional_vs_nullable_tool_status_detail(golden: dict) -> None:
    """None vs missing: omit OK; explicit null rejected (Zod optional not nullable)."""
    base = dict(golden["frames"][3])  # TOOL_STATUS without detail
    assert "detail" not in base
    omit = ToolStatusFrame.model_validate(base)
    assert omit.detail is None

    with_detail = dict(base)
    with_detail["detail"] = "running sandbox"
    assert ToolStatusFrame.model_validate(with_detail).detail == "running sandbox"

    as_null = dict(base)
    as_null["detail"] = None
    with pytest.raises(ValidationError) as err:
        ToolStatusFrame.model_validate(as_null)
    assert "detail" in str(err.value).lower() or "nullable" in str(err.value).lower()


def test_subject_isolation_empty_subject_id_rejected(golden: dict) -> None:
    payload = dict(golden["frames"][0])
    payload["subjectId"] = ""
    with pytest.raises(ValidationError) as err:
        HarnessFrame.model_validate(payload)
    assert "subjectId" in str(err.value)


def test_sequence_gaps_detected_never_silent(golden: dict) -> None:
    frames = [HarnessFrame.model_validate(raw).root for raw in golden["frames"][:3]]
    assert assert_monotonic_sequence(frames)["ok"] is True

    gapped = list(frames)
    # Bump last sequence out of order.
    broken = gapped[-1].model_copy(update={"sequenceIndex": 99})
    gapped[-1] = broken
    gap = assert_monotonic_sequence(gapped)
    assert gap["ok"] is False
    assert gap["code"] == "SEQUENCE_GAP"
    assert gap["expected"] == 2
    assert gap["actual"] == 99
    assert gap["subjectId"] == "anika-k"


def test_observability_parse_outcome_never_includes_delta_text(golden: dict) -> None:
    thought = golden["frames"][1]
    accepted = parse_harness_frame(thought, device_id="edge-aaaa")
    assert accepted["outcome"] == "accepted"
    assert accepted["subjectId"] == "anika-k"
    assert accepted["deviceId"] == "edge-aaaa"
    assert accepted["type"] == "THOUGHT_DELTA"
    meta = {
        "outcome": accepted["outcome"],
        "subjectId": accepted["subjectId"],
        "deviceId": accepted["deviceId"],
        "type": accepted["type"],
        "sequenceIndex": accepted["sequenceIndex"],
    }
    assert "consider ratio" not in json.dumps(meta)

    rejected = parse_harness_frame(
        {**thought, "leaked": True},
        device_id="edge-aaaa",
    )
    assert rejected["outcome"] == "rejected"
    assert rejected["failureClass"] == "unrecognized_keys"
    assert rejected["subjectId"] == "anika-k"
    assert "consider ratio" not in json.dumps(rejected)

    bad_subject = parse_harness_frame({**thought, "subjectId": ""})
    assert bad_subject["outcome"] == "rejected"
    assert bad_subject["failureClass"] == "missing_subject"


def test_scalability_large_bounded_delta_parses_within_budget(golden: dict) -> None:
    payload = dict(golden["frames"][2])
    payload["delta"] = "x" * (64 * 1024)
    started = time.perf_counter()
    parsed = HarnessFrame.model_validate(payload)
    elapsed_ms = (time.perf_counter() - started) * 1000
    assert len(parsed.root.delta) == 64 * 1024
    assert elapsed_ms < 100, f"parse took {elapsed_ms}ms; budget is 100ms"


def test_harness_frame_in_schema_export_map() -> None:
    import sys

    scripts = Path(__file__).resolve().parents[1] / "scripts"
    if str(scripts) not in sys.path:
        sys.path.insert(0, str(scripts))
    from export_schemas import WIRE_SCHEMA_EXPORT_MAP

    assert "HarnessFrame" in WIRE_SCHEMA_EXPORT_MAP
    assert WIRE_SCHEMA_EXPORT_MAP["HarnessFrame"] is HarnessFrame
