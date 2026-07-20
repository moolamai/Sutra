"""Shared tool-envelope fixtures — parity with TS classify/parse helpers."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sutra_orchestrator.contract_models import (
    TOOL_ENVELOPE_ERROR_CODES,
    ToolCallEnvelope,
    ToolEnvelopeError,
    classify_tool_envelope_value,
    make_tool_envelope_error,
    parse_tool_call_envelope,
    parse_tool_call_envelope_json,
)

FIXTURE_DIR = (
    Path(__file__).resolve().parents[2]
    / "sync-protocol"
    / "fixtures"
    / "tool-envelope"
)
MANIFEST = json.loads((FIXTURE_DIR / "manifest.json").read_text(encoding="utf-8"))
SCHEMA_DIR = Path(__file__).resolve().parents[1] / "schemas"


def _load(rel: str) -> str:
    return (FIXTURE_DIR / rel).read_text(encoding="utf-8")


def test_happy_path_valid_fixtures_and_committed_schemas() -> None:
    assert (SCHEMA_DIR / "ToolCallEnvelope.json").is_file()
    assert (SCHEMA_DIR / "ToolEnvelopeError.json").is_file()
    doc = json.loads((SCHEMA_DIR / "ToolCallEnvelope.json").read_text(encoding="utf-8"))
    assert doc["title"] == "ToolCallEnvelope"

    for entry in MANIFEST["valid"]:
        value = json.loads(_load(entry["file"]))
        parsed = ToolCallEnvelope.model_validate(value)
        assert parsed.root is not None


def test_manifest_covers_every_error_code() -> None:
    codes = [v["code"] for v in MANIFEST["violations"]]
    assert len(codes) == len(set(codes))
    for code in TOOL_ENVELOPE_ERROR_CODES:
        assert code in codes


def test_each_violation_maps_to_documented_code() -> None:
    for violation in MANIFEST["violations"]:
        raw = _load(violation["file"])
        kind = violation["kind"]
        if kind == "json-text":
            result = parse_tool_call_envelope_json(raw)
            assert result["ok"] is False
            code = result["error"].code
        elif kind == "fence-text":
            assert "```tool_call" not in raw and "```json" not in raw.lower()
            code = make_tool_envelope_error("MISSING_FENCE").code
        elif kind == "subject-scope":
            value = json.loads(raw)
            result = parse_tool_call_envelope(
                value,
                subject_id=violation.get("subjectId") or "",
            )
            assert result["outcome"] == "rejected"
            code = result["errorCode"]
        else:
            value = json.loads(raw)
            err = classify_tool_envelope_value(value)
            assert err is not None, violation["code"]
            code = err.code
        assert code == violation["code"], violation["file"]


def test_tool_envelope_error_schema_forbids_secrets() -> None:
    ok = ToolEnvelopeError.model_validate(
        {
            "code": "INVALID_JSON",
            "message": "tool-call fence body is not valid JSON",
            "issuePath": "(root)",
        }
    )
    assert ok.code == "INVALID_JSON"
    with pytest.raises(Exception):
        ToolEnvelopeError.model_validate(
            {
                "code": "SCHEMA_VIOLATION",
                "message": "tool-call envelope failed schema validation",
                "issuePath": "(root)",
                "arguments": {"secret": "nope"},
            }
        )


def test_subject_isolation_and_observability() -> None:
    value = json.loads(_load("violations/invalid-arguments.json"))
    result = parse_tool_call_envelope(
        value,
        subject_id="anika-k",
        device_id="edge-aaaa",
    )
    assert result["outcome"] == "rejected"
    assert result["errorCode"] == "INVALID_ARGUMENTS"
    assert result["subjectId"] == "anika-k"
    assert result["deviceId"] == "edge-aaaa"
    serialized = json.dumps(
        {
            "outcome": result["outcome"],
            "subjectId": result["subjectId"],
            "errorCode": result["errorCode"],
            "error": result["error"].model_dump(mode="json"),
        }
    )
    assert "stack" not in serialized.lower()
    assert "SyntaxError" not in serialized
