#!/usr/bin/env python3
"""Deterministic JSON Schema exporter for wire-boundary Pydantic models.

Mirrors ``packages/sync-protocol/scripts/export-schemas.mjs`` normalization:

- canonical deep key sorting
- ``$ref`` / ``$defs`` name normalization (content digests)
- unify ``definitions`` → ``$defs`` (Pydantic vs legacy exporters)
- strip ``format: date-time`` so HLC fields stay plain strings
- ``title`` + ``x-protocol-version`` metadata on every document

Usage (from ``packages/cloud-orchestrator``)::

    pnpm schemas:export
    # or:  PYTHONPATH=src python scripts/export_schemas.py

Override output with ``SCHEMA_OUT_DIR``. Two consecutive runs are byte-identical.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping

# Allow running without an editable install.
_PACKAGE_ROOT = Path(__file__).resolve().parent.parent
_SRC = _PACKAGE_ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from pydantic import BaseModel  # noqa: E402

from sutra_orchestrator import PROTOCOL_VERSION  # noqa: E402
from sutra_orchestrator.contract_models import (  # noqa: E402
    AgentTurnRequest,
    AgentTurnResponse,
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    HarnessFrame,
    SyncAdvisory,
    SyncAuditItem,
    SyncAuditPage,
    SyncRequest,
    SyncResponse,
    MeterEvent,
    ToolCallEnvelope,
    ToolEnvelopeError,
)

DEFAULT_OUT_DIR = _PACKAGE_ROOT / "schemas"
JSON_SCHEMA_DRAFT_07 = "http://json-schema.org/draft-07/schema#"

# Wire envelope type name → Pydantic model (same file names as the Zod export).
# SyncAudit* are P1 operator-read envelopes ; not yet in the
# Zod twin / schema-drift WIRE_TYPES list — tracked when the TS mirror lands.
WIRE_SCHEMA_EXPORT_MAP: dict[str, type[BaseModel]] = {
    "FrictionSample": FrictionSample,
    "ConceptMastery": ConceptMastery,
    "CognitiveState": CognitiveState,
    "SyncRequest": SyncRequest,
    "SyncResponse": SyncResponse,
    "SyncAdvisory": SyncAdvisory,
    "AgentTurnRequest": AgentTurnRequest,
    "AgentTurnResponse": AgentTurnResponse,
    "SyncAuditItem": SyncAuditItem,
    "SyncAuditPage": SyncAuditPage,
    "HarnessFrame": HarnessFrame,
    "ToolCallEnvelope": ToolCallEnvelope,
    "ToolEnvelopeError": ToolEnvelopeError,
    "MeterEvent": MeterEvent,
}


class SchemaExportError(Exception):
    """Typed exporter failure — never a silent catch-and-continue."""

    def __init__(self, code: str, message: str, *, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.__cause__ = cause


def sort_keys_deep(value: Any) -> Any:
    """Deep-sort object keys and stabilize unordered JSON Schema collections."""
    if isinstance(value, list):
        mapped = [sort_keys_deep(item) for item in value]
        if len(mapped) > 1 and all(isinstance(item, str) for item in mapped):
            return sorted(mapped)
        if len(mapped) > 1 and all(isinstance(item, dict) for item in mapped):
            return sorted(mapped, key=lambda item: json.dumps(item, sort_keys=True))
        return mapped
    if isinstance(value, dict):
        return {key: sort_keys_deep(value[key]) for key in sorted(value.keys())}
    return value


def unify_definitions_to_defs(schema: dict[str, Any]) -> dict[str, Any]:
    """Pydantic emits ``$defs``; legacy exporters emit ``definitions`` — unify."""

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(item) for item in node]
        if not isinstance(node, dict):
            return node
        out: dict[str, Any] = {}
        for key, child in node.items():
            if key == "definitions":
                # Fold into $defs (merge if both somehow present).
                existing = out.get("$defs", {})
                folded = walk(child)
                if not isinstance(folded, dict):
                    raise SchemaExportError(
                        "SCHEMA_NORMALIZE_FAILED",
                        "definitions must be an object",
                    )
                merged = {**existing, **folded}
                out["$defs"] = merged
                continue
            if key == "$ref" and isinstance(child, str):
                out[key] = child.replace("#/definitions/", "#/$defs/")
                continue
            out[key] = walk(child)
        return out

    result = walk(schema)
    if not isinstance(result, dict):
        raise SchemaExportError("SCHEMA_NORMALIZE_FAILED", "schema root must be an object")
    return result


def normalize_refs(schema: Any) -> Any:
    """Rewrite ``$defs`` / ``definitions`` names to content-addressed digests."""
    if not isinstance(schema, dict):
        return schema

    schema = unify_definitions_to_defs(schema)
    rename: dict[str, str] = {}
    defs = schema.get("$defs")
    if isinstance(defs, dict):
        entries: list[tuple[str, Any]] = []
        for name, definition in defs.items():
            canonical = sort_keys_deep(definition)
            digest = hashlib.sha256(
                json.dumps(canonical, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            ).hexdigest()[:12]
            stable = f"def_{digest}"
            rename[name] = stable
            entries.append((stable, canonical))
        entries.sort(key=lambda pair: pair[0])
        schema["$defs"] = {name: body for name, body in entries}

    def rewrite_ref(ref: str) -> str:
        def repl(match: re.Match[str]) -> str:
            name = match.group(1)
            mapped = rename.get(name)
            if mapped is None:
                return match.group(0)
            return f"#/$defs/{mapped}"

        return re.sub(r"#/(?:\$defs|definitions)/([^/#]+)", repl, ref)

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        ref = node.get("$ref")
        if isinstance(ref, str):
            node["$ref"] = rewrite_ref(ref)
        for child in node.values():
            walk(child)

    walk(schema)
    return schema


def strip_datetime_formats(schema: Any) -> Any:
    """Ensure HLC / timestamp fields are never advertised as ``format: date-time``."""
    if isinstance(schema, list):
        return [strip_datetime_formats(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    out: dict[str, Any] = {}
    for key, child in schema.items():
        if key == "format" and child == "date-time":
            continue
        out[key] = strip_datetime_formats(child)
    return out


def strip_exporter_cosmetics(schema: Any, *, is_root: bool = True) -> Any:
    """Drop Pydantic property titles / docstrings that flap vs Zod exports."""
    if isinstance(schema, list):
        return [strip_exporter_cosmetics(item, is_root=False) for item in schema]
    if not isinstance(schema, dict):
        return schema
    out: dict[str, Any] = {}
    for key, child in schema.items():
        if key == "description":
            continue
        if key == "title" and not is_root:
            continue
        out[key] = strip_exporter_cosmetics(child, is_root=False)
    return out


def schema_to_canonical_document(
    model: type[BaseModel],
    type_name: str,
    protocol_version: str,
) -> dict[str, Any]:
    """Convert one Pydantic model into a canonical JSON Schema document."""
    try:
        raw = model.model_json_schema(mode="validation")
    except Exception as cause:  # noqa: BLE001 — surface as typed exporter error
        raise SchemaExportError(
            "SCHEMA_CONVERT_FAILED",
            f"failed to convert {type_name} to JSON Schema",
            cause=cause,
        ) from cause

    if not isinstance(raw, dict):
        raise SchemaExportError(
            "SCHEMA_CONVERT_FAILED",
            f"{type_name} model_json_schema returned non-object",
        )

    with_meta: dict[str, Any] = {
        **raw,
        "$schema": JSON_SCHEMA_DRAFT_07,
        "title": type_name,
        "x-protocol-version": protocol_version,
    }
    normalized = strip_exporter_cosmetics(
        strip_datetime_formats(normalize_refs(with_meta)),
        is_root=True,
    )
    # Re-assert root identity after cosmetic strip.
    if isinstance(normalized, dict):
        normalized["title"] = type_name
        normalized["x-protocol-version"] = protocol_version
        normalized["$schema"] = JSON_SCHEMA_DRAFT_07
    return sort_keys_deep(normalized)  # type: ignore[return-value]


def _emit(event: Mapping[str, Any]) -> None:
    """Structured, content-free progress events (never subject utterances)."""
    sys.stdout.write(json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _write_atomic(out_dir: Path, file_name: str, body: str) -> None:
    target = out_dir / file_name
    staging = out_dir / f".{file_name}.{os.getpid()}.tmp"
    try:
        staging.write_text(body, encoding="utf-8")
        staging.replace(target)
    except OSError as cause:
        staging.unlink(missing_ok=True)
        raise SchemaExportError(
            "SCHEMA_WRITE_FAILED",
            f"failed to write {file_name}",
            cause=cause,
        ) from cause


def export_wire_schemas(
    *,
    out_dir: Path | None = None,
    models: Mapping[str, type[BaseModel]] | None = None,
    protocol_version: str | None = None,
) -> dict[str, Any]:
    """Emit one canonical JSON Schema file per wire envelope type."""
    resolved_out = (out_dir or DEFAULT_OUT_DIR).resolve()
    export_map = dict(models or WIRE_SCHEMA_EXPORT_MAP)
    version = protocol_version or PROTOCOL_VERSION
    if not version:
        raise SchemaExportError(
            "SCHEMA_PROTOCOL_VERSION_MISSING",
            "PROTOCOL_VERSION missing",
        )

    staged: list[tuple[str, str, str]] = []
    staging_root: Path | None = None

    try:
        resolved_out.mkdir(parents=True, exist_ok=True)
        staging_root = Path(tempfile.mkdtemp(prefix="sutra-py-schema-export-"))

        for type_name, model in export_map.items():
            if not issubclass(model, BaseModel):
                raise SchemaExportError(
                    "SCHEMA_NOT_EXPORTED",
                    f"wire model {type_name} is not a Pydantic BaseModel",
                )
            document = schema_to_canonical_document(model, type_name, version)
            body = json.dumps(document, indent=2, ensure_ascii=False) + "\n"
            file_name = f"{type_name}.json"
            (staging_root / file_name).write_text(body, encoding="utf-8")
            staged.append((file_name, body, type_name))
            _emit(
                {
                    "event": "schema.export",
                    "schema": type_name,
                    "outcome": "staged",
                    "protocolVersion": version,
                    "bytes": len(body.encode("utf-8")),
                }
            )

        # All-or-nothing promote — no partial durable sets on failure mid-loop.
        for file_name, body, type_name in staged:
            _write_atomic(resolved_out, file_name, body)
            _emit(
                {
                    "event": "schema.export",
                    "schema": type_name,
                    "outcome": "ok",
                    "protocolVersion": version,
                    "bytes": len(body.encode("utf-8")),
                    "path": str(resolved_out / file_name),
                }
            )

        _emit(
            {
                "event": "schema.export.complete",
                "outcome": "ok",
                "protocolVersion": version,
                "count": len(staged),
                "outDir": str(resolved_out),
            }
        )
        return {
            "outDir": str(resolved_out),
            "protocolVersion": version,
            "files": [name for name, _, _ in staged],
        }
    except SchemaExportError as err:
        _emit(
            {
                "event": "schema.export.complete",
                "outcome": "error",
                "code": err.code,
                "message": str(err),
            }
        )
        raise
    except Exception as err:  # noqa: BLE001
        failure = SchemaExportError("SCHEMA_EXPORT_FAILED", "schema export failed", cause=err)
        _emit(
            {
                "event": "schema.export.complete",
                "outcome": "error",
                "code": failure.code,
                "message": str(failure),
            }
        )
        raise failure from err
    finally:
        if staging_root is not None:
            for path in staging_root.glob("*"):
                path.unlink(missing_ok=True)
            try:
                staging_root.rmdir()
            except OSError:
                pass


def read_exported_schema_bodies(out_dir: Path) -> dict[str, str]:
    bodies: dict[str, str] = {}
    for type_name in WIRE_SCHEMA_EXPORT_MAP:
        file_name = f"{type_name}.json"
        bodies[file_name] = (out_dir / file_name).read_text(encoding="utf-8")
    return bodies


def main(argv: list[str] | None = None) -> int:
    del argv  # reserved for future flags
    out = Path(os.environ["SCHEMA_OUT_DIR"]).resolve() if os.environ.get("SCHEMA_OUT_DIR") else None
    try:
        export_wire_schemas(out_dir=out)
        return 0
    except SchemaExportError as err:
        print(f"[{err.code}] {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
