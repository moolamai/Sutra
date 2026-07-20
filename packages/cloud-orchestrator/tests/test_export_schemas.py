"""Deterministic Pydantic JSON Schema exporter tests."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from export_schemas import (  # noqa: E402
    WIRE_SCHEMA_EXPORT_MAP,
    SchemaExportError,
    export_wire_schemas,
    normalize_refs,
    read_exported_schema_bodies,
    schema_to_canonical_document,
    sort_keys_deep,
    strip_datetime_formats,
    unify_definitions_to_defs,
)
from pydantic import ValidationError  # noqa: E402

from sutra_orchestrator import PROTOCOL_VERSION  # noqa: E402
from sutra_orchestrator.contract_models import (  # noqa: E402
    AgentTurnRequest,
    CognitiveState,
    SyncAuditItem,
    SyncAuditPage,
)


def test_sort_keys_deep_is_stable() -> None:
    unsorted = {
        "z": 1,
        "a": {"d": 2, "b": 3},
        "m": [{"y": 1, "x": 2}, {"a": 0}],
        "required": ["z", "a"],
    }
    once = json.dumps(sort_keys_deep(unsorted))
    twice = json.dumps(sort_keys_deep(unsorted))
    assert once == twice
    assert once == json.dumps(
        {
            "a": {"b": 3, "d": 2},
            "m": [{"a": 0}, {"x": 2, "y": 1}],
            "required": ["a", "z"],
            "z": 1,
        }
    )


def test_unify_definitions_to_defs_and_normalize_refs() -> None:
    """Edge: Pydantic `$defs` vs legacy `definitions` must unify before digests."""
    legacy = {
        "type": "object",
        "properties": {"a": {"$ref": "#/definitions/Foo"}},
        "definitions": {"Foo": {"type": "string", "minLength": 1}},
    }
    unified = unify_definitions_to_defs(legacy)
    assert "definitions" not in unified
    assert "$defs" in unified
    assert unified["properties"]["a"]["$ref"] == "#/$defs/Foo"

    normalized = normalize_refs(dict(unified))
    defs = normalized["$defs"]
    assert len(defs) == 1
    name = next(iter(defs))
    assert name.startswith("def_")
    assert normalized["properties"]["a"]["$ref"] == f"#/$defs/{name}"

    again = normalize_refs(
        {
            "type": "object",
            "properties": {"a": {"$ref": "#/definitions/Foo"}},
            "definitions": {"Foo": {"type": "string", "minLength": 1}},
        }
    )
    assert list(again["$defs"].keys()) == [name]


def test_strip_datetime_format_keeps_hlc_as_plain_string() -> None:
    noisy = {
        "type": "string",
        "format": "date-time",
        "title": "CapturedAt",
    }
    cleaned = strip_datetime_formats(noisy)
    assert "format" not in cleaned
    assert cleaned["type"] == "string"


def test_two_consecutive_exports_are_byte_identical(tmp_path: Path) -> None:
    dir_a = tmp_path / "a"
    dir_b = tmp_path / "b"
    export_wire_schemas(out_dir=dir_a)
    export_wire_schemas(out_dir=dir_b)
    bodies_a = read_exported_schema_bodies(dir_a)
    bodies_b = read_exported_schema_bodies(dir_b)
    assert set(bodies_a) == {f"{n}.json" for n in WIRE_SCHEMA_EXPORT_MAP}
    for name, body in bodies_a.items():
        assert bodies_b[name] == body
        doc = json.loads(body)
        assert doc["x-protocol-version"] == PROTOCOL_VERSION
        assert doc["title"] == name.removesuffix(".json")
        assert doc["$schema"].endswith("draft-07/schema#")


def test_reexport_same_directory_is_idempotent(tmp_path: Path) -> None:
    out = tmp_path / "schemas"
    export_wire_schemas(out_dir=out)
    first = read_exported_schema_bodies(out)
    export_wire_schemas(out_dir=out)
    second = read_exported_schema_bodies(out)
    assert first == second


def test_happy_path_exports_all_wire_types(tmp_path: Path) -> None:
    result = export_wire_schemas(out_dir=tmp_path / "out")
    assert result["protocolVersion"] == PROTOCOL_VERSION
    assert sorted(result["files"]) == sorted(f"{n}.json" for n in WIRE_SCHEMA_EXPORT_MAP)


def test_subject_isolation_requires_subject_id_in_exported_schemas() -> None:
    cognitive = schema_to_canonical_document(CognitiveState, "CognitiveState", PROTOCOL_VERSION)
    turn = schema_to_canonical_document(AgentTurnRequest, "AgentTurnRequest", PROTOCOL_VERSION)
    assert "subjectId" in cognitive.get("required", [])
    assert "subjectId" in turn.get("required", [])


def test_happy_path_sync_audit_models_in_export_map(tmp_path: Path) -> None:
    """Audit response models ride the P1 schema pipeline."""
    assert "SyncAuditItem" in WIRE_SCHEMA_EXPORT_MAP
    assert "SyncAuditPage" in WIRE_SCHEMA_EXPORT_MAP
    assert WIRE_SCHEMA_EXPORT_MAP["SyncAuditItem"] is SyncAuditItem
    assert WIRE_SCHEMA_EXPORT_MAP["SyncAuditPage"] is SyncAuditPage

    result = export_wire_schemas(out_dir=tmp_path / "audit-out")
    assert "SyncAuditItem.json" in result["files"]
    assert "SyncAuditPage.json" in result["files"]
    bodies = read_exported_schema_bodies(tmp_path / "audit-out")
    item_doc = json.loads(bodies["SyncAuditItem.json"])
    page_doc = json.loads(bodies["SyncAuditPage.json"])
    assert item_doc["title"] == "SyncAuditItem"
    assert page_doc["title"] == "SyncAuditPage"
    assert item_doc["x-protocol-version"] == PROTOCOL_VERSION
    assert "subjectId" in item_doc.get("required", [])
    assert "subjectId" in page_doc.get("required", [])
    # createdAt is ISO wall time on the wire — never advertised as date-time
    # (same strip as HLC fields so consumers treat timestamps as plain strings).
    assert "date-time" not in json.dumps(item_doc)


def test_happy_path_harness_frame_in_export_map(tmp_path: Path) -> None:
    """Harness stream union rides the schema export pipeline."""
    from sutra_orchestrator.contract_models import HarnessFrame

    assert "HarnessFrame" in WIRE_SCHEMA_EXPORT_MAP
    assert WIRE_SCHEMA_EXPORT_MAP["HarnessFrame"] is HarnessFrame

    result = export_wire_schemas(out_dir=tmp_path / "harness-out")
    assert "HarnessFrame.json" in result["files"]
    bodies = read_exported_schema_bodies(tmp_path / "harness-out")
    doc = json.loads(bodies["HarnessFrame.json"])
    assert doc["title"] == "HarnessFrame"
    assert doc["x-protocol-version"] == PROTOCOL_VERSION
    variants = doc.get("oneOf") or doc.get("anyOf") or []
    defs = doc.get("$defs") or {}
    assert len(variants) >= 8

    def resolve(node: dict) -> dict:
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            return defs[ref.rsplit("/", 1)[-1]]
        return node

    for variant in variants:
        body = resolve(variant)
        assert "subjectId" in body.get("required", [])


def test_happy_path_meter_event_in_export_map(tmp_path: Path) -> None:
    """MeterEvent rides the schema export pipeline as a first-class wire type."""
    from sutra_orchestrator.contract_models import MeterEvent

    assert "MeterEvent" in WIRE_SCHEMA_EXPORT_MAP
    assert WIRE_SCHEMA_EXPORT_MAP["MeterEvent"] is MeterEvent

    result = export_wire_schemas(out_dir=tmp_path / "meter-out")
    assert "MeterEvent.json" in result["files"]
    bodies = read_exported_schema_bodies(tmp_path / "meter-out")
    doc = json.loads(bodies["MeterEvent.json"])
    assert doc["title"] == "MeterEvent"
    assert doc["x-protocol-version"] == PROTOCOL_VERSION
    required = doc.get("required") or []
    assert "inputTokens" in required
    assert "cachedInputTokens" in required
    assert "aborted" in required


def test_happy_path_tool_envelope_in_export_map(tmp_path: Path) -> None:
    """Tool-call envelope + repair-loop error ride the schema export pipeline."""
    from sutra_orchestrator.contract_models import ToolCallEnvelope, ToolEnvelopeError

    assert "ToolCallEnvelope" in WIRE_SCHEMA_EXPORT_MAP
    assert "ToolEnvelopeError" in WIRE_SCHEMA_EXPORT_MAP
    assert WIRE_SCHEMA_EXPORT_MAP["ToolCallEnvelope"] is ToolCallEnvelope
    assert WIRE_SCHEMA_EXPORT_MAP["ToolEnvelopeError"] is ToolEnvelopeError

    result = export_wire_schemas(out_dir=tmp_path / "tool-env-out")
    assert "ToolCallEnvelope.json" in result["files"]
    assert "ToolEnvelopeError.json" in result["files"]
    bodies = read_exported_schema_bodies(tmp_path / "tool-env-out")
    env_doc = json.loads(bodies["ToolCallEnvelope.json"])
    err_doc = json.loads(bodies["ToolEnvelopeError.json"])
    assert env_doc["title"] == "ToolCallEnvelope"
    assert err_doc["title"] == "ToolEnvelopeError"
    assert env_doc["x-protocol-version"] == PROTOCOL_VERSION
    assert "code" in (err_doc.get("properties") or {})


def test_edge_sync_audit_page_next_cursor_null_vs_missing() -> None:
    """None vs missing: null and omitted nextCursor both validate; empty string does not."""
    item = {
        "subjectId": "anika-k",
        "deviceId": "edge-aaaa",
        "syncAttemptId": "550e8400-e29b-41d4-a716-446655440000",
        "protocolVersion": "1.0.0",
        "advisories": [],
        "stateVectorBefore": {"session": "000000001000000:000003:edge-aaaa"},
        "stateVectorAfter": {"session": "000000001000000:000004:edge-aaaa"},
        "createdAt": "2026-07-15T12:00:00+00:00",
    }
    with_null = SyncAuditPage.model_validate(
        {"subjectId": "anika-k", "items": [item], "nextCursor": None}
    )
    assert with_null.nextCursor is None
    omitted = SyncAuditPage.model_validate({"subjectId": "anika-k", "items": [item]})
    assert omitted.nextCursor is None
    with pytest.raises(ValidationError):
        SyncAuditPage.model_validate(
            {"subjectId": "anika-k", "items": [item], "nextCursor": ""}
        )


def test_edge_sync_audit_empty_subject_id_rejected() -> None:
    with pytest.raises(ValidationError):
        SyncAuditItem.model_validate(
            {
                "subjectId": "",
                "deviceId": "edge-aaaa",
                "syncAttemptId": "550e8400-e29b-41d4-a716-446655440000",
                "protocolVersion": "1.0.0",
                "advisories": [],
                "stateVectorBefore": {},
                "stateVectorAfter": {},
                "createdAt": "2026-07-15T12:00:00+00:00",
            }
        )


def test_missing_model_fails_with_typed_error(tmp_path: Path) -> None:
    class NotAModel:  # noqa: D101
        pass

    with pytest.raises(SchemaExportError) as err:
        export_wire_schemas(
            out_dir=tmp_path / "bad",
            models={"Bogus": NotAModel},  # type: ignore[dict-item]
        )
    assert err.value.code == "SCHEMA_NOT_EXPORTED"


def test_write_into_file_path_fails_typed(tmp_path: Path) -> None:
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("nope", encoding="utf-8")
    with pytest.raises(SchemaExportError) as err:
        export_wire_schemas(out_dir=blocker)
    assert err.value.code.startswith("SCHEMA_")
