"""API-key and permissive-dev reference verifiers."""

from __future__ import annotations

import json
import logging

import pytest

from sutra_orchestrator.auth import (
    AuthVerifier,
    CallerContext,
    ForbiddenError,
    PermissiveDevVerifier,
    RequestCredentials,
    StaticApiKeyVerifier,
    UnauthenticatedError,
    require_subject_access,
    select_reference_verifier,
    verify_or_deny,
)


def _keys_json() -> str:
    return json.dumps(
        {
            "key-teacher": {
                "principalId": "teacher-1",
                "subjectScope": ["anika-k", "ravi-m"],
            },
            "key-operator": {
                "principalId": "ops-1",
                "subjectScope": "*",
            },
        }
    )


@pytest.mark.asyncio
async def test_happy_path_permissive_dev_grants_operator_scope(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger="sutra_orchestrator.auth"):
        verifier = PermissiveDevVerifier()
    assert isinstance(verifier, AuthVerifier)
    assert any(
        "reference_only_not_for_production" in r.getMessage() for r in caplog.records
    )

    ctx = await verify_or_deny(
        verifier,
        RequestCredentials(api_key_header="anything-goes"),
    )
    assert ctx.principalId == "dev-operator"
    assert ctx.subjectScope == "*"
    require_subject_access(ctx, "any-subject-id")


@pytest.mark.asyncio
async def test_happy_path_static_api_key_maps_to_subject_scope() -> None:
    verifier = StaticApiKeyVerifier.from_keys_json(_keys_json())
    assert isinstance(verifier, AuthVerifier)

    ctx = await verify_or_deny(
        verifier,
        RequestCredentials(api_key_header="key-teacher"),
    )
    assert ctx.principalId == "teacher-1"
    assert ctx.subjectScope == ["anika-k", "ravi-m"]
    require_subject_access(ctx, "anika-k")


@pytest.mark.asyncio
async def test_edge_missing_credentials_401_both_backends() -> None:
    api = StaticApiKeyVerifier.from_keys_json(_keys_json())
    with pytest.raises(UnauthenticatedError) as err_api:
        await verify_or_deny(api, RequestCredentials())
    assert err_api.value.status_code == 401

    dev = PermissiveDevVerifier(warn=False)
    with pytest.raises(UnauthenticatedError) as err_dev:
        await verify_or_deny(dev, RequestCredentials())
    assert err_dev.value.status_code == 401
    assert err_dev.value.code == "MISSING_CREDENTIALS"


@pytest.mark.asyncio
async def test_edge_garbage_api_key_is_401_not_403() -> None:
    verifier = StaticApiKeyVerifier.from_keys_json(_keys_json())
    with pytest.raises(UnauthenticatedError) as err:
        await verify_or_deny(
            verifier,
            RequestCredentials(api_key_header="%%%not-a-real-key%%%"),
        )
    assert err.value.status_code == 401
    assert err.value.code == "INVALID_CREDENTIALS"
    assert err.value.code != "FORBIDDEN_SUBJECT_SCOPE"


@pytest.mark.asyncio
async def test_edge_bearer_header_accepted_by_api_key_verifier() -> None:
    verifier = StaticApiKeyVerifier.from_keys_json(_keys_json())
    ctx = await verifier.verify(
        RequestCredentials(authorization_header="Bearer key-operator")
    )
    assert ctx.principalId == "ops-1"
    assert ctx.subjectScope == "*"


@pytest.mark.asyncio
async def test_edge_valid_key_but_forbidden_subject_is_403() -> None:
    verifier = StaticApiKeyVerifier.from_keys_json(_keys_json())
    # Authenticate first (AuthN), then scope check (AuthZ) — 403 not 401.
    ctx = await verifier.verify(RequestCredentials(api_key_header="key-teacher"))
    with pytest.raises(ForbiddenError) as err:
        require_subject_access(ctx, "other-student")
    assert err.value.status_code == 403


def test_edge_api_key_table_never_logs_secrets(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.INFO, logger="sutra_orchestrator.auth"):
        StaticApiKeyVerifier.from_keys_json(_keys_json())
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "key-teacher" not in joined
    assert "key-operator" not in joined
    assert "backend=static_api_key" in joined
    assert "frictionLog" not in joined


def test_edge_select_reference_verifier_from_env() -> None:
    api = select_reference_verifier(
        {
            "SUTRA_AUTH_VERIFIER": "api_key",
            "SUTRA_API_KEYS_JSON": _keys_json(),
        }
    )
    assert isinstance(api, StaticApiKeyVerifier)

    with pytest.raises(ValueError, match="SUTRA_API_KEYS_JSON"):
        select_reference_verifier({"SUTRA_AUTH_VERIFIER": "api_key"})

    dev = select_reference_verifier({"SUTRA_AUTH_VERIFIER": "permissive_dev"})
    assert isinstance(dev, PermissiveDevVerifier)

    # Zero-config (no verifier env, no keys) → permissive_dev reference.
    zero = select_reference_verifier({})
    assert isinstance(zero, PermissiveDevVerifier)

    with pytest.raises(ValueError, match="unknown"):
        select_reference_verifier({"SUTRA_AUTH_VERIFIER": "oauth-oidc"})


@pytest.mark.asyncio
async def test_edge_subject_isolation_across_api_keys() -> None:
    a = CallerContext(principalId="p-a", subjectScope=["subject-a"])
    b = CallerContext(principalId="p-b", subjectScope=["subject-b"])
    verifier = StaticApiKeyVerifier({"key-a": a, "key-b": b})
    ctx_a = await verifier.verify(RequestCredentials(api_key_header="key-a"))
    assert ctx_a.allows_subject("subject-a")
    assert not ctx_a.allows_subject("subject-b")
