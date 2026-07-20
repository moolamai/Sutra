"""Wire-shape fixtures must be rejected/accepted by Python SyncRequest models.

Same generated bundle as TS Ajv: packages/contract-conformance/fixtures/wire/bundle.json
(derived from Track A frozen schemas — never hand-written shapes).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from sutra_orchestrator.contract_models import SyncRequest

BUNDLE = (
    Path(__file__).resolve().parents[1]
    / ".."
    / "contract-conformance"
    / "fixtures"
    / "wire"
    / "bundle.json"
).resolve()


@pytest.fixture(scope="module")
def bundle() -> dict:
    assert BUNDLE.is_file(), f"missing generated wire bundle at {BUNDLE}"
    return json.loads(BUNDLE.read_text(encoding="utf-8"))


def test_valid_fixture_parses_as_sync_request(bundle: dict) -> None:
    assert bundle["schemaTitle"] == "SyncRequest"
    req = SyncRequest.model_validate(bundle["valid"])
    assert req.protocolVersion == "1.0.0"
    assert req.edgeState.subjectId == bundle["valid"]["edgeState"]["subjectId"]


def test_one_violation_per_top_level_field_rejected(bundle: dict) -> None:
    fields = sorted(bundle["topLevelRequired"])
    assert sorted(v["field"] for v in bundle["violations"]) == fields
    for violation in bundle["violations"]:
        with pytest.raises(ValidationError):
            SyncRequest.model_validate(violation["payload"])


def test_edge_subject_isolation_field_present_on_valid(bundle: dict) -> None:
    """Sovereignty: valid SyncRequest always carries edgeState.subjectId."""
    edge = bundle["valid"]["edgeState"]
    assert isinstance(edge["subjectId"], str) and edge["subjectId"]


def test_edge_replay_valid_payload_idempotent(bundle: dict) -> None:
    a = SyncRequest.model_validate(bundle["valid"])
    b = SyncRequest.model_validate(json.loads(json.dumps(bundle["valid"])))
    assert a.model_dump(mode="json") == b.model_dump(mode="json")
