"""AuthVerifier protocol + CallerContext."""

from __future__ import annotations

import logging

import pytest
from pydantic import ValidationError

from sutra_orchestrator.auth import (
    AuthDenial,
    AuthVerifier,
    CallerContext,
    ForbiddenError,
    RequestCredentials,
    UnauthenticatedError,
    auth_denial_to_http_detail,
    credentials_from_headers,
    map_auth_failure,
    require_subject_access,
    verify_or_deny,
)


class _StubVerifier:
    """Test-only verifier — mimics permissive-dev / keyed maps without shipping 002."""

    def __init__(
        self,
        *,
        contexts: dict[str, CallerContext] | None = None,
        raise_raw: BaseException | None = None,
    ) -> None:
        self._contexts = contexts or {}
        self._raise_raw = raise_raw

    async def verify(self, credentials: RequestCredentials) -> CallerContext:
        if self._raise_raw is not None:
            raise self._raise_raw
        token = None
        if credentials.api_key_header:
            token = credentials.api_key_header
        elif credentials.authorization_header:
            parts = credentials.authorization_header.split(" ", 1)
            token = parts[1] if len(parts) == 2 else credentials.authorization_header
        if token is None or token not in self._contexts:
            raise UnauthenticatedError(
                code="INVALID_CREDENTIALS",
                message="credentials rejected",
            )
        return self._contexts[token]


def _dev_operator(token: str = "dev-token") -> tuple[_StubVerifier, str]:
    """Happy-path stub: operator scope (same shape as forthcoming permissive-dev)."""
    ctx = CallerContext(principalId="dev-principal", subjectScope="*")
    return _StubVerifier(contexts={token: ctx}), token


@pytest.mark.asyncio
async def test_happy_path_dev_style_operator_scope(
    caplog: pytest.LogCaptureFixture,
) -> None:
    verifier, token = _dev_operator()
    assert isinstance(verifier, AuthVerifier)

    with caplog.at_level(logging.INFO, logger="sutra_orchestrator.auth"):
        ctx = await verify_or_deny(
            verifier,
            RequestCredentials(api_key_header=token),
        )

    assert ctx.principalId == "dev-principal"
    assert ctx.subjectScope == "*"
    assert ctx.allows_subject("any-subject")
    require_subject_access(ctx, "anika-k")

    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "auth_verify" in joined
    assert "outcome=ok" in joined
    assert token not in joined
    assert "frictionLog" not in joined
    assert "utterance" not in joined


@pytest.mark.asyncio
async def test_edge_missing_credentials_is_401() -> None:
    verifier, _token = _dev_operator()
    with pytest.raises(UnauthenticatedError) as err:
        await verify_or_deny(verifier, RequestCredentials())
    assert err.value.status_code == 401
    assert err.value.code == "MISSING_CREDENTIALS"
    detail = auth_denial_to_http_detail(err.value)
    assert detail["code"] == "MISSING_CREDENTIALS"


@pytest.mark.asyncio
async def test_edge_garbage_credentials_is_401_not_403() -> None:
    verifier, _token = _dev_operator()
    with pytest.raises(UnauthenticatedError) as err:
        await verify_or_deny(
            verifier,
            RequestCredentials(api_key_header="%%%garbage%%%"),
        )
    assert err.value.status_code == 401
    assert err.value.code == "INVALID_CREDENTIALS"
    assert not isinstance(err.value, ForbiddenError)


@pytest.mark.asyncio
async def test_edge_verifier_raw_exception_maps_to_401_never_500() -> None:
    verifier = _StubVerifier(raise_raw=RuntimeError("secret=super-secret-key"))
    with pytest.raises(UnauthenticatedError) as err:
        await verify_or_deny(
            verifier,
            RequestCredentials(api_key_header="anything"),
        )
    assert err.value.status_code == 401
    assert err.value.code == "VERIFIER_FAILURE"
    # Denial detail must not echo the raw exception / secret.
    assert "super-secret-key" not in err.value.message
    assert "super-secret-key" not in repr(err.value)


def test_edge_scope_mismatch_is_403(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caller = CallerContext(
        principalId="teacher-1",
        subjectScope=["anika-k", "ravi-m"],
    )
    with caplog.at_level(logging.WARNING, logger="sutra_orchestrator.auth"):
        with pytest.raises(ForbiddenError) as err:
            require_subject_access(caller, "other-student")
    assert err.value.status_code == 403
    assert err.value.code == "FORBIDDEN_SUBJECT_SCOPE"
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "outcome=forbidden" in joined
    assert "principal_id=teacher-1" in joined
    assert "subject_id=other-student" in joined


def test_edge_subject_isolation_list_does_not_cross() -> None:
    a = CallerContext(principalId="p-a", subjectScope=["subject-a"])
    b = CallerContext(principalId="p-b", subjectScope=["subject-b"])
    assert a.allows_subject("subject-a")
    assert not a.allows_subject("subject-b")
    assert b.allows_subject("subject-b")
    assert not b.allows_subject("subject-a")
    require_subject_access(a, "subject-a")
    with pytest.raises(ForbiddenError):
        require_subject_access(a, "subject-b")


def test_edge_credentials_repr_hides_secrets() -> None:
    creds = RequestCredentials(
        authorization_header="Bearer sk-live-should-not-leak",
        api_key_header="apk-should-not-leak",
    )
    text = repr(creds) + str(creds)
    assert "sk-live" not in text
    assert "apk-should" not in text
    assert "set" in text
    assert creds.has_any()


def test_edge_credentials_from_headers_case_insensitive() -> None:
    creds = credentials_from_headers(
        {"Authorization": "Bearer abc", "X-API-Key": "key-1"}
    )
    assert creds.authorization_header == "Bearer abc"
    assert creds.api_key_header == "key-1"
    assert credentials_from_headers({}).has_any() is False


def test_edge_caller_context_rejects_empty_principal() -> None:
    with pytest.raises(ValidationError):
        CallerContext(principalId="", subjectScope="*")


def test_edge_map_auth_failure_preserves_forbidden() -> None:
    forbidden = ForbiddenError()
    assert map_auth_failure(forbidden) is forbidden
    mapped = map_auth_failure(ValueError("boom"))
    assert isinstance(mapped, UnauthenticatedError)
    assert mapped.status_code == 401
    assert isinstance(mapped, AuthDenial)
