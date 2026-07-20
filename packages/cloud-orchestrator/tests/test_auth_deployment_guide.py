"""Pluggable auth deployment guide consistency."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from sutra_orchestrator.auth import (
    ENV_API_KEYS_JSON,
    ENV_AUTH_VERIFIER,
    CallerContext,
    StaticApiKeyVerifier,
    extract_presented_secret,
    select_reference_verifier,
)

GUIDE = (
    Path(__file__).resolve().parents[1] / "docs" / "pluggable-auth-deployment.md"
)
README = Path(__file__).resolve().parents[1] / "README.md"
PUBLIC_RUNTIME = (
    Path(__file__).resolve().parents[3] / "docs" / "runtime" / "README.md"
)


def test_happy_path_guide_exists_and_linked() -> None:
    assert GUIDE.is_file(), "missing docs/pluggable-auth-deployment.md"
    readme = README.read_text(encoding="utf-8")
    assert "docs/pluggable-auth-deployment.md" in readme
    public = PUBLIC_RUNTIME.read_text(encoding="utf-8")
    assert "pluggable-auth-deployment.md" in public


def test_happy_path_guide_api_keys_json_parses_with_real_verifier() -> None:
    """Embedded JSON example must load via StaticApiKeyVerifier.from_keys_json."""
    text = GUIDE.read_text(encoding="utf-8")
    match = re.search(
        r"<!-- AUTH_GUIDE_API_KEYS_JSON -->\s*```json\s*(.*?)\s*```\s*<!-- /AUTH_GUIDE_API_KEYS_JSON -->",
        text,
        flags=re.DOTALL,
    )
    assert match, "guide must embed AUTH_GUIDE_API_KEYS_JSON block"
    raw = match.group(1).strip()
    verifier = StaticApiKeyVerifier.from_keys_json(raw)
    assert isinstance(verifier, StaticApiKeyVerifier)


@pytest.mark.asyncio
async def test_edge_guide_env_names_match_auth_module() -> None:
    text = GUIDE.read_text(encoding="utf-8")
    assert ENV_AUTH_VERIFIER in text
    assert ENV_API_KEYS_JSON in text
    assert "select_reference_verifier" in text
    assert "StaticApiKeyVerifier" in text
    assert "CallerContext" in text
    assert "auth_scope_audit" in text
    assert "/v1/health" in text

    # Worked teacher key from the guide resolves to the documented scope.
    guide_json = re.search(
        r"<!-- AUTH_GUIDE_API_KEYS_JSON -->\s*```json\s*(.*?)\s*```",
        text,
        flags=re.DOTALL,
    )
    assert guide_json
    verifier = StaticApiKeyVerifier.from_keys_json(guide_json.group(1).strip())
    from sutra_orchestrator.auth import RequestCredentials

    ctx = await verifier.verify(
        RequestCredentials(api_key_header="sk_teacher_demo")
    )
    assert ctx.principalId == "teacher-1"
    assert ctx.subjectScope == ["anika-k", "ravi-m"]
    assert ctx.allows_subject("anika-k")
    assert not ctx.allows_subject("other-student")


def test_edge_guide_rejects_production_claims_for_permissive_dev() -> None:
    """Guide must warn that permissive_dev is not for production."""
    text = GUIDE.read_text(encoding="utf-8").lower()
    assert "permissive_dev" in text
    assert "not for production" in text
    # Zero-config factory still exists for local/dev — documented path.
    assert isinstance(
        select_reference_verifier({"SUTRA_AUTH_VERIFIER": "permissive_dev"}),
        object,
    )


def test_edge_programmatic_example_matches_caller_context_shape() -> None:
    from sutra_orchestrator.auth import RequestCredentials

    ctx = CallerContext(
        principalId="teacher-1",
        subjectScope=["anika-k", "ravi-m"],
    )
    verifier = StaticApiKeyVerifier({"sk_teacher_demo": ctx})
    assert (
        extract_presented_secret(
            RequestCredentials(authorization_header="Bearer sk_teacher_demo")
        )
        == "sk_teacher_demo"
    )
    assert verifier.backend_name == "static_api_key"
