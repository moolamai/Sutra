"""Golden join corpus consumer .

Loads the same bytes as ``packages/sync-protocol/tests/golden_joins.test.mjs``
from ``packages/sync-protocol/fixtures/golden-joins/`` and asserts the Python
``merge_states`` join is byte-identical under canonical serialization.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

from merge_canon import (
    apply_compaction_handshake,
    canonicalize_state,
    merge_pair,
    sort_keys_deep,
)
from sutra_orchestrator.contract_models import CognitiveState
from sutra_orchestrator.crdt_merge import IrreconcilableStateError, merge_states

FIXTURE_DIR = (
    Path(__file__).resolve().parents[1]
    / ".."
    / "sync-protocol"
    / "fixtures"
    / "golden-joins"
).resolve()


def emit_golden_event(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps({"event": "crdt.golden", **event}) + "\n")
    sys.stdout.flush()


def _normalize_numbers(value: Any) -> Any:
    """Align Python float dumps with JSON number encoding used by TS."""
    if isinstance(value, float) and value.is_integer() and abs(value) < 2**53:
        return int(value)
    if isinstance(value, list):
        return [_normalize_numbers(v) for v in value]
    if isinstance(value, dict):
        return {k: _normalize_numbers(value[k]) for k in value}
    return value


def golden_canonicalize(state: CognitiveState | dict[str, Any]) -> str:
    parsed = json.loads(canonicalize_state(state))
    return json.dumps(
        sort_keys_deep(_normalize_numbers(parsed)),
        separators=(",", ":"),
        ensure_ascii=True,
    )


def assert_canonical_join(case_id: str, got: str, expected: str) -> None:
    """Loud mismatch for CI — case id + bounded got/expected (never silent)."""
    if got == expected:
        return
    emit_golden_event(
        {
            "outcome": "error",
            "code": "GOLDEN_JOIN_MISMATCH",
            "id": case_id,
            "gotLen": len(got),
            "expectedLen": len(expected),
        }
    )

    def excerpt(s: str) -> str:
        return s if len(s) <= 500 else f"{s[:500]}…"

    raise AssertionError(
        "\n".join(
            [
                f"GOLDEN_JOIN_MISMATCH:{case_id}",
                "--- expected",
                excerpt(expected),
                "+++ got",
                excerpt(got),
            ]
        )
    )


@pytest.fixture(scope="module")
def manifest() -> dict[str, Any]:
    path = FIXTURE_DIR / "manifest.json"
    assert path.is_file(), f"missing golden corpus at {path}"
    return json.loads(path.read_text(encoding="utf-8"))


def _load_case(file_name: str) -> dict[str, Any]:
    return json.loads((FIXTURE_DIR / file_name).read_text(encoding="utf-8"))


def test_happy_path_corpus_sized_and_manifested(manifest: dict[str, Any]) -> None:
    assert len(manifest["cases"]) >= 20
    assert manifest["protocolVersion"] == "1.0.0"
    files = sorted(
        p.name for p in FIXTURE_DIR.glob("*.json") if p.name != "manifest.json"
    )
    assert len(files) == len(manifest["cases"])
    emit_golden_event({"outcome": "ok", "kind": "corpus.size", "count": len(files)})


def test_happy_path_python_merge_matches_expected_join_bytes(
    manifest: dict[str, Any],
) -> None:
    joins = 0
    for entry in manifest["cases"]:
        case = _load_case(entry["file"])
        assert case["stateA"]["protocolVersion"] == "1.0.0"
        assert case["stateB"]["protocolVersion"] == "1.0.0"

        if case.get("expectError"):
            with pytest.raises(IrreconcilableStateError):
                merge_states(
                    CognitiveState.model_validate(case["stateA"]),
                    CognitiveState.model_validate(case["stateB"]),
                )
            emit_golden_event(
                {
                    "outcome": "ok",
                    "kind": "subjectIsolation",
                    "id": case["id"],
                    "code": case["expectError"],
                    "subjectId": case["stateA"]["subjectId"],
                    "deviceId": (case["stateA"]["deviceIds"] or [None])[0],
                }
            )
            continue

        assert case["stateA"]["subjectId"] == case["stateB"]["subjectId"]
        merged = merge_pair(case["stateA"], case["stateB"])
        got = golden_canonicalize(merged)
        expected = golden_canonicalize(case["expectedJoin"])
        assert_canonical_join(case["id"], got, expected)
        joins += 1

        if case["kind"] == "compaction":
            stamps = case["compactedSampleTimestamps"]
            assert isinstance(stamps, list) and len(stamps) > 0
            pruned = apply_compaction_handshake(case["stateA"], stamps)
            for sample in pruned["frictionLog"]:
                assert sample["capturedAt"] not in stamps
            again = merge_pair(merged, pruned)
            assert_canonical_join(
                f"{case['id']}/compaction-remerge",
                golden_canonicalize(again),
                golden_canonicalize(case["expectedAfterPruneRemerge"]),
            )

        emit_golden_event(
            {
                "outcome": "ok",
                "kind": case["kind"],
                "id": case["id"],
                "subjectId": case["subjectId"],
                "deviceId": (case["stateA"]["deviceIds"] or [None])[0],
            }
        )

    assert joins >= 19
    emit_golden_event({"outcome": "ok", "kind": "py.joins", "count": joins})


def test_edge_golden_json_language_neutral(manifest: dict[str, Any]) -> None:
    for entry in manifest["cases"]:
        raw = (FIXTURE_DIR / entry["file"]).read_text(encoding="utf-8")
        assert "NaN" not in raw
        assert "Infinity" not in raw
        assert "undefined" not in raw
    emit_golden_event({"outcome": "ok", "kind": "edge.languageNeutral"})


def test_edge_readme_requires_human_review() -> None:
    readme = (FIXTURE_DIR / "README.md").read_text(encoding="utf-8")
    assert "human review" in readme.lower()
    assert "never auto-commit" in readme.lower()
    assert "generate-golden-joins" in readme
    emit_golden_event({"outcome": "ok", "kind": "edge.regenPolicy"})


def test_scalability_corpus_is_bounded(manifest: dict[str, Any]) -> None:
    """Corpus stays small — golden review budget, not unbounded fuzz dump."""
    assert len(manifest["cases"]) <= 64
    for entry in manifest["cases"]:
        case = _load_case(entry["file"])
        if case.get("expectedJoin") is None:
            continue
        log = case["expectedJoin"].get("frictionLog") or []
        assert len(log) <= 32
        assert len(case["expectedJoin"].get("mastery") or {}) <= 32
    emit_golden_event(
        {
            "outcome": "ok",
            "kind": "scalability.bounds",
            "count": len(manifest["cases"]),
        }
    )
