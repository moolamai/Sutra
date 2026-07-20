"""MeterEvent Pydantic mirror + wire fixture parity with TS."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sutra_orchestrator.contract_models import MeterEvent, parse_meter_event

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "sync-protocol"
    / "fixtures"
    / "wire-parity"
    / "meter-events.json"
)
SCHEMA_DIR = Path(__file__).resolve().parents[1] / "schemas"
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def test_happy_path_committed_meter_schema_and_golden_parse() -> None:
    assert (SCHEMA_DIR / "MeterEvent.json").is_file()
    doc = json.loads((SCHEMA_DIR / "MeterEvent.json").read_text(encoding="utf-8"))
    assert doc["title"] == "MeterEvent"

    for entry in FIXTURE["meters"]:
        parsed = MeterEvent.model_validate(entry["meter"])
        assert parsed.modelId == entry["meter"]["modelId"]
        assert parsed.aborted is entry["meter"]["aborted"]
        # Cached and fresh stay distinct fields on the model.
        dumped = parsed.model_dump(mode="json")
        assert "cachedInputTokens" in dumped
        assert "inputTokens" in dumped
        assert dumped["inputTokens"] == entry["meter"]["inputTokens"]
        assert dumped["cachedInputTokens"] == entry["meter"]["cachedInputTokens"]


def test_edge_aborted_partial_and_idempotent_replay() -> None:
    aborted = next(e for e in FIXTURE["meters"] if e["id"] == "aborted-partial")
    a = MeterEvent.model_validate(aborted["meter"])
    b = MeterEvent.model_validate(aborted["meter"])
    assert a.aborted is True
    assert a.model_dump() == b.model_dump()


def test_edge_none_vs_missing_not_applicable_all_fields_required() -> None:
    """MeterEvent has no optional nullables — omitting a field is a violation."""
    incomplete = dict(FIXTURE["meters"][0]["meter"])
    del incomplete["latencyMs"]
    with pytest.raises(Exception):
        MeterEvent.model_validate(incomplete)
    with pytest.raises(Exception):
        MeterEvent.model_validate({**FIXTURE["meters"][0]["meter"], "latencyMs": None})


def test_subject_isolation_and_observability() -> None:
    meter = FIXTURE["meters"][0]["meter"]
    ok = parse_meter_event(meter, subject_id="anika-k", device_id="edge-aaaa")
    assert ok["outcome"] == "accepted"
    assert ok["subjectId"] == "anika-k"
    assert ok["deviceId"] == "edge-aaaa"

    unscoped = parse_meter_event(meter, subject_id="")
    assert unscoped["outcome"] == "rejected"
    assert unscoped["failureClass"] == "missing_subject"

    leak = parse_meter_event(
        {**meter, "prompt": "secret utterance"},
        subject_id="anika-k",
        device_id="edge-aaaa",
    )
    assert leak["outcome"] == "rejected"
    assert leak["failureClass"] == "content_leak"
    serialized = json.dumps(
        {
            "outcome": leak["outcome"],
            "subjectId": leak["subjectId"],
            "failureClass": leak["failureClass"],
        }
    )
    assert "secret" not in serialized
