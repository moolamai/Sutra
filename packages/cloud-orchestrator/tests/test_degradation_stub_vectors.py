"""Stubbed-down degradation vectors — JSON parity with TS catalog validator."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

import pytest
from pydantic import BaseModel, ConfigDict, Field, ValidationError

FIXTURE_DIR = (
    Path(__file__).resolve().parents[2]
    / "sync-protocol"
    / "fixtures"
    / "degradation-registry"
)
MANIFEST = json.loads((FIXTURE_DIR / "manifest.json").read_text(encoding="utf-8"))
CATALOG = json.loads(
    (FIXTURE_DIR / MANIFEST["stubVectorsFile"]).read_text(encoding="utf-8")
)
REGISTRY = json.loads(
    (FIXTURE_DIR / MANIFEST["registryFile"]).read_text(encoding="utf-8")
)
SCHEMA_PATH = (
    Path(__file__).resolve().parents[2]
    / "sync-protocol"
    / "schemas"
    / "DegradationStubVectorCatalog.json"
)


class ForcedFailure(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: str
    dependency: str
    detail: str | None = None


class StubVector(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    subjectId: str = Field(min_length=1)
    deviceId: str | None = None
    surface: str
    operation: str
    forcedFailure: ForcedFailure
    expectedMode: str
    expectedSignalCode: str
    expectedReadPolicy: str
    expectedWritePolicy: str
    allowsSilentWriteRetry: Literal[False]
    allowsFabrication: Literal[False]
    requiresRollback: bool | None = None
    idempotencyKey: str = Field(min_length=1)


class StubVectorCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: str
    description: str
    vectors: list[StubVector]
    violations: list[dict] | None = None


def test_happy_path_catalog_validates_and_schema_committed() -> None:
    assert SCHEMA_PATH.is_file()
    parsed = StubVectorCatalog.model_validate(CATALOG)
    assert len(parsed.vectors) >= 6
    assert len({v.id for v in parsed.vectors}) == len(parsed.vectors)


def test_happy_path_vectors_match_default_registry_bindings() -> None:
    bindings = {
        (b["surface"], b["operation"]): b["mode"] for b in REGISTRY["bindings"]
    }
    for vector in CATALOG["vectors"]:
        key = (vector["surface"], vector["operation"])
        assert key in bindings
        assert bindings[key] == vector["expectedMode"]
        mode_spec = REGISTRY["modes"][vector["expectedMode"]]
        assert mode_spec["signalCode"] == vector["expectedSignalCode"]
        assert vector["allowsSilentWriteRetry"] is False
        assert vector["allowsFabrication"] is False


def test_edge_violations_rejected() -> None:
    for violation in CATALOG["violations"]:
        kind = violation["kind"]
        if kind == "missing_subject":
            with pytest.raises(ValidationError):
                StubVector.model_validate(violation["vector"])
        elif kind == "schema_violation":
            with pytest.raises(ValidationError):
                StubVector.model_validate(violation["raw"])
        elif kind == "fabrication_forbidden":
            assert violation["payload"].get("fabricated") is True
        else:
            pytest.fail(f"unknown violation kind {kind}")


def test_subject_isolation_and_idempotency_keys() -> None:
    keys = [v["idempotencyKey"] for v in CATALOG["vectors"]]
    assert len(keys) == len(set(keys))
    for vector in CATALOG["vectors"]:
        assert vector["subjectId"]
        assert vector["idempotencyKey"].startswith(f"{vector['subjectId']}:")
        serialized = json.dumps(vector)
        assert "utterance" not in serialized
        assert "prompt" not in serialized
