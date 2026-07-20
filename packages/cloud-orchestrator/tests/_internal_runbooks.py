"""Skip helpers when internal operator runbooks are absent from the checkout."""

from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
RUNBOOKS_DIR = REPO_ROOT / "docs" / "operations" / "runbooks"
BRING_UP_RUNBOOK = RUNBOOKS_DIR / "local-dev-compose-bring-up.md"

internal_runbooks_present = BRING_UP_RUNBOOK.is_file()

skip_without_internal_runbooks = pytest.mark.skipif(
    not internal_runbooks_present,
    reason="internal runbooks not present in public checkout",
)
