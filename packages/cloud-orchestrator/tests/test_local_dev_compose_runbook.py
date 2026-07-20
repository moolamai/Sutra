"""Local dev / compose bring-up runbook.

Governance-doc consistency: markers, recorded smoke output, cross-links,
Windows+Unix activate snippets, and sovereignty (no DSN/password leakage).
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

from tests._internal_runbooks import skip_without_internal_runbooks

pytestmark = skip_without_internal_runbooks

REPO_ROOT = Path(__file__).resolve().parents[3]
RUNBOOK = (
    REPO_ROOT / "docs" / "operations" / "runbooks" / "local-dev-compose-bring-up.md"
)
README = Path(__file__).resolve().parents[1] / "README.md"
COMPOSE = REPO_ROOT / "infra" / "docker-compose.yml"
SMOKE = Path(__file__).resolve().parents[1] / "smoke_test.py"


def _marker_block(text: str, name: str) -> str:
    pattern = (
        rf"<!-- {re.escape(name)} -->\s*(.*?)\s*<!-- /{re.escape(name)} -->"
    )
    match = re.search(pattern, text, flags=re.DOTALL)
    assert match, f"runbook must embed {name} block"
    return match.group(1)


def test_happy_path_runbook_exists_and_linked_from_readme() -> None:
    assert RUNBOOK.is_file(), "missing docs/operations/runbooks/local-dev-compose-bring-up.md"
    assert COMPOSE.is_file(), "runbook documents missing infra/docker-compose.yml"
    readme = README.read_text(encoding="utf-8")
    assert "docs/operations/runbooks/local-dev-compose-bring-up.md" in readme
    text = RUNBOOK.read_text(encoding="utf-8")
    assert "pnpm install" in text
    assert "pnpm infra:up" in text
    assert "python smoke_test.py" in text
    assert "http://localhost:3000" in text
    assert "/v1/metrics" in text
    assert "/v1/health" in text
    assert "event-catalog.md" in text


def test_happy_path_smoke_expected_matches_live_smoke_test() -> None:
    """Recorded smoke snippet must match a real smoke_test.py run."""
    text = RUNBOOK.read_text(encoding="utf-8")
    block = _marker_block(text, "RUNBOOK_STEP_SMOKE_TEST")
    for line in (
        "CRDT merge algebra: commutative, idempotent, dedup OK",
        "posterior mean after merge: 0.750",
        "Graph planner: topological order, loop-back revision OK",
    ):
        assert line in block

    proc = subprocess.run(
        [sys.executable, str(SMOKE)],
        cwd=str(SMOKE.parent),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr or proc.stdout
    out = proc.stdout
    assert "CRDT merge algebra: commutative, idempotent, dedup OK" in out
    assert "posterior mean after merge: 0.750" in out
    assert "Graph planner: topological order, loop-back revision OK" in out
    assert "Cloud turn: fake provider model text + plan-grounded digests OK" in out


def test_edge_windows_and_unix_activate_paths_documented() -> None:
    """§5 Windows vs Linux — both activate forms; compose via pnpm wrapper."""
    text = RUNBOOK.read_text(encoding="utf-8")
    assert "source .venv/bin/activate" in text
    assert ".venv\\Scripts\\Activate.ps1" in text or r".\.venv\Scripts\Activate.ps1" in text
    assert "pnpm infra:up" in text
    assert "docker compose -f infra/docker-compose.yml" in text
    assert "Invoke-RestMethod" in text
    assert "curl -s http://127.0.0.1:8000/v1/health" in text


def test_edge_sovereignty_no_secret_or_content_leak_in_examples() -> None:
    """Health/metrics examples must not embed DSN passwords or utterance bodies."""
    text = RUNBOOK.read_text(encoding="utf-8").lower()
    # Documented password name for compose is ok only as env var narrative,
    # never as an inlined connection string.
    assert "postgresql://sutra:" not in text
    assert "redis://:" not in text
    assert "utterance" not in text
    # Synthetic ids called out — fixtures only.
    assert "anika-k" in text
    assert "synthetic" in text
    assert "sutra_dev_only" in text  # named as dev-only placeholder, not a secret blob


def test_edge_empty_stack_health_shape_still_documented() -> None:
    """Empty / cold advisory world: health JSON still returns rows (status field)."""
    text = RUNBOOK.read_text(encoding="utf-8")
    block = _marker_block(text, "RUNBOOK_STEP_COMPOSE_UP")
    assert '"status": "ok"' in block
    assert "sutra_http_request_duration_ms" in block
    assert "degraded" in text
    assert "503" in text
