"""Golden TurnTrajectoryV1 fixtures must parse in Python; keystrokes rejected.

Fixtures live in packages/telemetry/fixtures/trajectory/ (shared with TS).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from sutra_orchestrator.trajectory import TurnTrajectoryV1

FIXTURE_ROOT = (
    Path(__file__).resolve().parents[1]
    / ".."
    / "telemetry"
    / "fixtures"
    / "trajectory"
).resolve()

COMMITTED_SCHEMA = (
    Path(__file__).resolve().parents[1]
    / ".."
    / "sync-protocol"
    / "schemas"
    / "TurnTrajectoryV1.json"
).resolve()


@pytest.fixture(scope="module")
def manifest() -> dict:
    path = FIXTURE_ROOT / "manifest.json"
    assert path.is_file(), f"missing trajectory fixture manifest at {path}"
    return json.loads(path.read_text(encoding="utf-8"))


def test_committed_schema_documents_trajectory_v1() -> None:
    assert COMMITTED_SCHEMA.is_file(), f"missing {COMMITTED_SCHEMA}"
    doc = json.loads(COMMITTED_SCHEMA.read_text(encoding="utf-8"))
    assert doc["title"] == "TurnTrajectoryV1"
    assert doc["x-trajectory-format-version"] == "trajectory.v1"
    props = doc.get("properties") or {}
    assert "keystrokes" not in props
    assert "prompt" not in props
    assert "arguments" not in props


def test_golden_fixtures_parse_and_round_trip(manifest: dict) -> None:
    assert len(manifest["goldens"]) >= 2
    for entry in manifest["goldens"]:
        raw = json.loads((FIXTURE_ROOT / entry["file"]).read_text(encoding="utf-8"))
        assert "keystrokes" not in raw
        parsed = TurnTrajectoryV1.model_validate(raw)
        assert parsed.locality == entry["locality"]
        assert len(parsed.stages) == entry["expectStageCount"]
        assert len(parsed.toolCalls) == entry["expectToolCallCount"]
        assert parsed.subjectId == raw["subjectId"]
        again = TurnTrajectoryV1.model_validate(
            json.loads(parsed.model_dump_json(exclude_none=True))
        )
        assert again.model_dump(mode="json") == parsed.model_dump(mode="json")


def test_forbidden_keystrokes_fixture_rejected(manifest: dict) -> None:
    violation = next(v for v in manifest["violations"] if v["id"] == "forbidden-keystrokes")
    raw = json.loads((FIXTURE_ROOT / violation["file"]).read_text(encoding="utf-8"))
    assert violation["forbiddenKey"] in raw
    with pytest.raises(ValidationError) as exc_info:
        TurnTrajectoryV1.model_validate(raw)
    assert "keystrokes" in str(exc_info.value).lower() or "extra" in str(
        exc_info.value
    ).lower()


def test_replay_golden_is_idempotent(manifest: dict) -> None:
    entry = manifest["goldens"][0]
    raw = json.loads((FIXTURE_ROOT / entry["file"]).read_text(encoding="utf-8"))
    a = TurnTrajectoryV1.model_validate(raw)
    b = TurnTrajectoryV1.model_validate(json.loads(json.dumps(raw)))
    assert a.model_dump(mode="json") == b.model_dump(mode="json")
