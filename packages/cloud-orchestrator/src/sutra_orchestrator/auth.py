"""Pluggable AuthVerifier seam (Track A P2 — API AuthN/AuthZ).

Sovereignty: Sutra does not ship an IdP. Deployments inject an
:class:`AuthVerifier` at app construction. Handlers receive only a
:class:`CallerContext` — never raw credentials.

Contract: protocol + models + typed denials.
Reference (not product) verifiers: :class:`StaticApiKeyVerifier`,
:class:`PermissiveDevVerifier`. FastAPI boundary wiring is BOUNMIDD-*.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Annotated, Literal, Mapping, Protocol, runtime_checkable

from fastapi import HTTPException, Request
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
)

logger = logging.getLogger(__name__)

# Bound subject lists / key tables so scope tables cannot grow without limit (NFR).
_MAX_SUBJECT_SCOPE_ENTRIES = 1024
_MAX_OPERATION_SCOPE_ENTRIES = 32
_MAX_API_KEY_ENTRIES = 256

OPERATOR_SUBJECT_SCOPE: Literal["*"] = "*"
ALL_OPERATION_SCOPES: Literal["*"] = "*"
SYNC_OPERATION_SCOPE = "sync"
AGGREGATION_INGEST_OPERATION_SCOPE = "aggregation:ingest"

# Env keys for reference config — read only when a factory is explicitly called.
ENV_API_KEYS_JSON = "SUTRA_API_KEYS_JSON"
ENV_AUTH_VERIFIER = "SUTRA_AUTH_VERIFIER"

NonEmptyStr = Annotated[str, StringConstraints(min_length=1)]


# ── Credentials (verifier-only; never thread into handlers) ─────────────────


@dataclass(frozen=True)
class RequestCredentials:
    """Credential bag extracted at the boundary for :class:`AuthVerifier` only.

    ``__repr__`` / ``__str__`` intentionally omit token material so logs and
    stack traces cannot leak secrets.
    """

    authorization_header: str | None = None
    api_key_header: str | None = None

    def has_any(self) -> bool:
        return bool(self.authorization_header) or bool(self.api_key_header)

    def __repr__(self) -> str:
        return (
            "RequestCredentials("
            f"authorization={'set' if self.authorization_header else 'missing'},"
            f"api_key={'set' if self.api_key_header else 'missing'})"
        )

    def __str__(self) -> str:
        return repr(self)


def credentials_from_headers(headers: Mapping[str, str]) -> RequestCredentials:
    """Build :class:`RequestCredentials` from a case-insensitive header map.

    Recognizes ``Authorization`` and ``X-API-Key`` only — unknown headers are
    ignored (not forwarded into the credential bag).
    """
    lowered = {str(k).lower(): v for k, v in headers.items()}
    auth = lowered.get("authorization")
    api_key = lowered.get("x-api-key")
    return RequestCredentials(
        authorization_header=auth.strip() if isinstance(auth, str) and auth.strip() else None,
        api_key_header=api_key.strip() if isinstance(api_key, str) and api_key.strip() else None,
    )


# ── Caller context (the only identity surface handlers may see) ─────────────


class CallerContext(BaseModel):
    """Authenticated caller: principal id + subject and operation scopes.

    ``subjectScope: "*"`` is operator scope (all subjects). A list is an
    explicit allow-set — empty list means deny-all for subject-addressed
    routes (still authenticated).

    ``operationScopes`` is additive and default-deny. Existing routes that
    have not declared an operation permission continue to use subject scope;
    aggregation ingest explicitly requires ``aggregation:ingest``. ``"*"``
    is reserved for the local permissive-dev operator.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    principalId: NonEmptyStr
    subjectScope: Literal["*"] | list[NonEmptyStr]
    operationScopes: Literal["*"] | list[NonEmptyStr] = Field(
        default_factory=list
    )

    @field_validator("subjectScope")
    @classmethod
    def _bound_subject_list(
        cls, value: Literal["*"] | list[str]
    ) -> Literal["*"] | list[str]:
        if value == OPERATOR_SUBJECT_SCOPE:
            return value
        if len(value) > _MAX_SUBJECT_SCOPE_ENTRIES:
            raise ValueError(
                f"subjectScope list exceeds {_MAX_SUBJECT_SCOPE_ENTRIES} entries"
            )
        # Stable unique order for equality / logging (no content beyond ids).
        seen: set[str] = set()
        ordered: list[str] = []
        for sid in value:
            if sid not in seen:
                seen.add(sid)
                ordered.append(sid)
        return ordered

    def allows_subject(self, subject_id: str) -> bool:
        """Return True when ``subject_id`` is inside this caller's scope."""
        if not subject_id:
            return False
        if self.subjectScope == OPERATOR_SUBJECT_SCOPE:
            return True
        return subject_id in self.subjectScope

    @field_validator("operationScopes")
    @classmethod
    def _bound_operation_list(
        cls, value: Literal["*"] | list[str]
    ) -> Literal["*"] | list[str]:
        if value == ALL_OPERATION_SCOPES:
            return value
        if len(value) > _MAX_OPERATION_SCOPE_ENTRIES:
            raise ValueError(
                "operationScopes list exceeds "
                f"{_MAX_OPERATION_SCOPE_ENTRIES} entries"
            )
        return list(dict.fromkeys(value))

    def allows_operation(self, operation_scope: str) -> bool:
        if not operation_scope:
            return False
        if self.operationScopes == ALL_OPERATION_SCOPES:
            return True
        return operation_scope in self.operationScopes

    def scope_kind(self) -> str:
        if self.subjectScope == OPERATOR_SUBJECT_SCOPE:
            return "operator"
        return "subject_list"

    def operation_scope_kind(self) -> str:
        if self.operationScopes == ALL_OPERATION_SCOPES:
            return "all_operations"
        return "operation_list"


# ── Typed denials (401 vs 403 — never conflated, never 500) ─────────────────


class AuthDenial(Exception):
    """Base typed auth denial — subclasses set exact HTTP status codes."""

    status_code: int = 401
    code: str = "AUTH_DENIED"

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code!r}, status_code={self.status_code})"


class UnauthenticatedError(AuthDenial):
    """Missing or invalid credentials → HTTP 401."""

    status_code = 401

    def __init__(
        self,
        code: str = "UNAUTHENTICATED",
        message: str = "authentication required",
    ) -> None:
        super().__init__(code, message)


class ForbiddenError(AuthDenial):
    """Authenticated but outside subject scope → HTTP 403."""

    status_code = 403

    def __init__(
        self,
        code: str = "FORBIDDEN_SUBJECT_SCOPE",
        message: str = "caller is out of subject scope",
    ) -> None:
        super().__init__(code, message)


def auth_denial_to_http_detail(err: AuthDenial) -> dict[str, str]:
    """Stable JSON detail body for FastAPI ``HTTPException``."""
    return {"code": err.code, "message": err.message}


def map_auth_failure(exc: BaseException) -> AuthDenial:
    """Coerce verifier failures into typed denials — never leak as 500.

    Unknown exceptions become :class:`UnauthenticatedError` (401). Scope
    denials must raise :class:`ForbiddenError` explicitly — they are not
    remapped from bare ``Exception``.
    """
    if isinstance(exc, AuthDenial):
        return exc
    logger.warning(
        "auth_verify outcome=unauthenticated reason=verifier_exception "
        "err_type=%s",
        type(exc).__name__,
    )
    return UnauthenticatedError(
        code="VERIFIER_FAILURE",
        message="authentication failed",
    )


# ── AuthVerifier protocol (injected at app construction — no singleton) ─────


@runtime_checkable
class AuthVerifier(Protocol):
    """Pluggable credential verifier.

    Implementations MUST raise :class:`UnauthenticatedError` (401) for missing
    or invalid credentials and :class:`ForbiddenError` (403) only when the
    principal is known but the operation is out of scope. Never raise raw
    exceptions that would surface as 500.
    """

    async def verify(self, credentials: RequestCredentials) -> CallerContext:
        """Validate credentials → :class:`CallerContext` or typed denial."""
        ...


def require_subject_access(
    caller: CallerContext,
    subject_id: str,
    *,
    route: str | None = None,
    source: Literal["path", "body"] = "path",
    device_id: str | None = None,
) -> None:
    """Enforce subject isolation — raise :class:`ForbiddenError` on mismatch.

    Logs structured outcome metadata only (never utterances / friction).
    Denials emit an ``auth_scope_audit`` stream event for operator evidence.
    """
    if not subject_id:
        _emit_scope_audit(
            caller,
            subject_id="-",
            outcome="forbidden",
            reason="empty_subject",
            route=route,
            source=source,
            device_id=device_id,
        )
        raise ForbiddenError(
            code="FORBIDDEN_SUBJECT_SCOPE",
            message="subject_id must be non-empty",
        )
    if caller.allows_subject(subject_id):
        logger.info(
            "auth_scope principal_id=%s subject_id=%s outcome=ok scope_kind=%s "
            "source=%s route=%s",
            caller.principalId,
            subject_id,
            caller.scope_kind(),
            source,
            route or "-",
        )
        return
    _emit_scope_audit(
        caller,
        subject_id=subject_id,
        outcome="forbidden",
        reason="out_of_scope",
        route=route,
        source=source,
        device_id=device_id,
    )
    raise ForbiddenError(
        code="FORBIDDEN_SUBJECT_SCOPE",
        message="caller is out of subject scope",
    )


def require_operation_access(
    caller: CallerContext,
    operation_scope: str,
    *,
    route: str,
    subject_id: str,
    device_id: str | None = None,
) -> None:
    """Require one explicit operation permission; default deny on absence."""
    if caller.allows_operation(operation_scope):
        logger.info(
            "auth_operation_scope principal_id=%s subject_id=%s device_id=%s "
            "operation_scope=%s outcome=ok scope_kind=%s route=%s",
            caller.principalId,
            subject_id,
            device_id or "-",
            operation_scope,
            caller.operation_scope_kind(),
            route,
        )
        return
    logger.warning(
        "auth_scope_audit principal_id=%s subject_id=%s device_id=%s "
        "operation_scope=%s outcome=forbidden reason=out_of_operation_scope "
        "route=%s scope_kind=%s",
        caller.principalId,
        subject_id,
        device_id or "-",
        operation_scope,
        route,
        caller.operation_scope_kind(),
    )
    raise ForbiddenError(
        code="FORBIDDEN_OPERATION_SCOPE",
        message=f"caller lacks required operation scope: {operation_scope}",
    )


def _emit_scope_audit(
    caller: CallerContext,
    *,
    subject_id: str,
    outcome: str,
    reason: str,
    route: str | None,
    source: str,
    device_id: str | None,
) -> None:
    """Append one structured denial to the auth audit stream (no raw content)."""
    logger.warning(
        "auth_scope_audit principal_id=%s subject_id=%s device_id=%s "
        "outcome=%s reason=%s source=%s route=%s scope_kind=%s",
        caller.principalId,
        subject_id,
        device_id or "-",
        outcome,
        reason,
        source,
        route or "-",
        caller.scope_kind(),
    )


async def verify_or_deny(
    verifier: AuthVerifier,
    credentials: RequestCredentials,
) -> CallerContext:
    """Invoke ``verifier.verify`` and normalize failures to typed denials."""
    if not credentials.has_any():
        logger.warning("auth_verify outcome=unauthenticated reason=missing_credentials")
        raise UnauthenticatedError(
            code="MISSING_CREDENTIALS",
            message="authentication required",
        )
    try:
        ctx = await verifier.verify(credentials)
    except AuthDenial:
        raise
    except Exception as err:  # noqa: BLE001 — coerce to 401, never 500
        raise map_auth_failure(err) from err

    if not isinstance(ctx, CallerContext):
        logger.warning(
            "auth_verify outcome=unauthenticated reason=invalid_context_type"
        )
        raise UnauthenticatedError(
            code="VERIFIER_FAILURE",
            message="authentication failed",
        )
    logger.info(
        "auth_verify principal_id=%s outcome=ok scope_kind=%s",
        ctx.principalId,
        ctx.scope_kind(),
    )
    return ctx


# ── Reference verifiers — ship as references, not products ───


def _digest_api_key(secret: str) -> bytes:
    return hashlib.sha256(secret.encode("utf-8")).digest()


def extract_presented_secret(credentials: RequestCredentials) -> str | None:
    """Pull the presented secret from API-Key or Authorization headers.

    Prefers ``X-API-Key``. For ``Authorization``, accepts ``Bearer <token>``,
    ``ApiKey <token>``, or a bare token. Never logs the returned value.
    """
    if credentials.api_key_header:
        return credentials.api_key_header
    header = credentials.authorization_header
    if not header:
        return None
    parts = header.split(None, 1)
    if len(parts) == 2 and parts[0].lower() in {"bearer", "apikey", "api-key"}:
        token = parts[1].strip()
        return token or None
    return header.strip() or None


class StaticApiKeyVerifier:
    """Reference static API-key → CallerContext table.

    Construct with an in-memory map or :meth:`from_env` /
    :meth:`from_keys_json`. Keys are stored only as SHA-256 digests.
    This is a **reference** for self-hosters — not a production IdP.
    """

    backend_name = "static_api_key"

    def __init__(self, key_table: Mapping[str, CallerContext]) -> None:
        if not key_table:
            raise ValueError("StaticApiKeyVerifier requires a non-empty key_table")
        if len(key_table) > _MAX_API_KEY_ENTRIES:
            raise ValueError(
                f"key_table exceeds {_MAX_API_KEY_ENTRIES} entries"
            )
        by_digest: dict[bytes, CallerContext] = {}
        for secret, ctx in key_table.items():
            if not secret or not isinstance(secret, str):
                raise ValueError("API key secrets must be non-empty strings")
            if not isinstance(ctx, CallerContext):
                raise TypeError("key_table values must be CallerContext")
            digest = _digest_api_key(secret)
            if digest in by_digest:
                raise ValueError("duplicate API key digest in key_table")
            by_digest[digest] = ctx
        self._by_digest = by_digest
        logger.info(
            "auth_verifier backend=%s outcome=ready key_count=%d",
            self.backend_name,
            len(self._by_digest),
        )

    @classmethod
    def from_keys_json(cls, raw_json: str) -> StaticApiKeyVerifier:
        """Parse ``{ "<apiKey>": { "principalId", "subjectScope" }, ... }``."""
        try:
            payload = json.loads(raw_json)
        except json.JSONDecodeError as err:
            raise ValueError("SUTRA_API_KEYS_JSON must be valid JSON") from err
        if not isinstance(payload, dict) or not payload:
            raise ValueError("SUTRA_API_KEYS_JSON must be a non-empty object")
        table: dict[str, CallerContext] = {}
        for secret, entry in payload.items():
            if not isinstance(secret, str) or not secret:
                raise ValueError("API key names must be non-empty strings")
            if not isinstance(entry, dict):
                raise ValueError("each API key entry must be an object")
            table[secret] = CallerContext.model_validate(entry)
        return cls(table)

    @classmethod
    def from_env(
        cls, environ: Mapping[str, str] | None = None
    ) -> StaticApiKeyVerifier:
        """Build from ``SUTRA_API_KEYS_JSON`` — call at app construction only."""
        import os

        env = environ if environ is not None else os.environ
        raw = env.get(ENV_API_KEYS_JSON)
        if not raw or not str(raw).strip():
            raise ValueError(f"{ENV_API_KEYS_JSON} is required for static_api_key")
        return cls.from_keys_json(str(raw))

    async def verify(self, credentials: RequestCredentials) -> CallerContext:
        secret = extract_presented_secret(credentials)
        if not secret:
            logger.warning(
                "auth_verify backend=%s outcome=unauthenticated reason=missing_secret",
                self.backend_name,
            )
            raise UnauthenticatedError(
                code="MISSING_CREDENTIALS",
                message="authentication required",
            )
        ctx = self._by_digest.get(_digest_api_key(secret))
        if ctx is None:
            logger.warning(
                "auth_verify backend=%s outcome=unauthenticated "
                "reason=invalid_credentials",
                self.backend_name,
            )
            raise UnauthenticatedError(
                code="INVALID_CREDENTIALS",
                message="credentials rejected",
            )
        logger.info(
            "auth_verify backend=%s principal_id=%s outcome=ok scope_kind=%s",
            self.backend_name,
            ctx.principalId,
            ctx.scope_kind(),
        )
        return ctx


class PermissiveDevVerifier:
    """Reference permissive verifier — any present credential → operator scope.

    Emits a loud WARNING at construction. **Not for production.** Use only
    for local demos; inject explicitly at app construction.
    """

    backend_name = "permissive_dev"

    def __init__(
        self,
        *,
        principal_id: str = "dev-operator",
        warn: bool = True,
    ) -> None:
        self._context = CallerContext(
            principalId=principal_id,
            subjectScope=OPERATOR_SUBJECT_SCOPE,
            operationScopes=ALL_OPERATION_SCOPES,
        )
        if warn:
            logger.warning(
                "auth_verifier backend=%s outcome=enabled "
                "WARNING=reference_only_not_for_production "
                "principal_id=%s scope_kind=operator",
                self.backend_name,
                self._context.principalId,
            )
        else:
            logger.info(
                "auth_verifier backend=%s outcome=ready principal_id=%s",
                self.backend_name,
                self._context.principalId,
            )

    async def verify(self, credentials: RequestCredentials) -> CallerContext:
        if not credentials.has_any():
            logger.warning(
                "auth_verify backend=%s outcome=unauthenticated "
                "reason=missing_credentials",
                self.backend_name,
            )
            raise UnauthenticatedError(
                code="MISSING_CREDENTIALS",
                message="authentication required",
            )
        # Permissive: any non-empty credential bag grants operator scope.
        logger.info(
            "auth_verify backend=%s principal_id=%s outcome=ok scope_kind=operator",
            self.backend_name,
            self._context.principalId,
        )
        return self._context


def select_reference_verifier(
    environ: Mapping[str, str] | None = None,
) -> AuthVerifier:
    """Factory for reference verifiers — call at app construction, never import-time.

    ``SUTRA_AUTH_VERIFIER``:
      - ``permissive_dev`` → :class:`PermissiveDevVerifier`
      - ``api_key`` / unset with ``SUTRA_API_KEYS_JSON`` → :class:`StaticApiKeyVerifier`
      - unset with no keys → :class:`PermissiveDevVerifier` (local zero-config; loud WARNING)
    """
    import os

    env = environ if environ is not None else os.environ
    mode = (env.get(ENV_AUTH_VERIFIER) or "").strip().lower()
    if mode in {"permissive_dev", "dev", "permissive"}:
        return PermissiveDevVerifier()
    if mode in {"api_key", "static_api_key", "apikey"}:
        return StaticApiKeyVerifier.from_env(env)
    if env.get(ENV_API_KEYS_JSON):
        return StaticApiKeyVerifier.from_env(env)
    if mode:
        raise ValueError(
            f"unknown {ENV_AUTH_VERIFIER}={mode!r}; "
            "expected 'api_key' or 'permissive_dev'"
        )
    # Zero-config local / test: permissive reference (never a silent open API —
    # credentials must still be presented).
    return PermissiveDevVerifier()


# ── FastAPI dependency — default-deny unless route opts out ──


async def get_caller_context(request: Request) -> CallerContext:
    """FastAPI dependency: verify credentials → :class:`CallerContext`.

    Reads ``request.app.state.auth_verifier`` (injected at lifespan). Maps
    :class:`AuthDenial` to ``HTTPException`` (401/403) — never a 500.
    """
    auth_verifier = getattr(request.app.state, "auth_verifier", None)
    if auth_verifier is None:
        logger.error("auth_boundary outcome=misconfigured reason=missing_verifier")
        raise HTTPException(
            status_code=500,
            detail={
                "code": "AUTH_MISCONFIGURED",
                "message": "auth verifier not configured",
            },
        )

    headers = {k: v for k, v in request.headers.items()}
    credentials = credentials_from_headers(headers)
    try:
        return await verify_or_deny(auth_verifier, credentials)
    except AuthDenial as err:
        logger.warning(
            "auth_boundary outcome=denied status=%s code=%s",
            err.status_code,
            err.code,
        )
        raise HTTPException(
            status_code=err.status_code,
            detail=auth_denial_to_http_detail(err),
        ) from err


def enforce_subject_scope(
    caller: CallerContext,
    subject_id: str,
    *,
    route: str,
    source: Literal["path", "body"] = "path",
    device_id: str | None = None,
) -> None:
    """403 when ``subject_id`` (path or body) is outside the caller's scope.

    Denial is written to the ``auth_scope_audit`` stream before the HTTP error.
    """
    try:
        require_subject_access(
            caller,
            subject_id,
            route=route,
            source=source,
            device_id=device_id,
        )
    except ForbiddenError as err:
        raise HTTPException(
            status_code=err.status_code,
            detail=auth_denial_to_http_detail(err),
        ) from err


def enforce_operation_scope(
    caller: CallerContext,
    operation_scope: str,
    *,
    route: str,
    subject_id: str,
    device_id: str | None = None,
) -> None:
    """FastAPI boundary wrapper for explicit operation-scope enforcement."""
    try:
        require_operation_access(
            caller,
            operation_scope,
            route=route,
            subject_id=subject_id,
            device_id=device_id,
        )
    except ForbiddenError as err:
        raise HTTPException(
            status_code=err.status_code,
            detail=auth_denial_to_http_detail(err),
        ) from err


def enforce_path_subject_scope(caller: CallerContext, subject_id: str) -> None:
    """Backward-compatible path-only wrapper — prefer :func:`enforce_subject_scope`."""
    enforce_subject_scope(
        caller,
        subject_id,
        route="path",
        source="path",
    )


__all__ = [
    "OPERATOR_SUBJECT_SCOPE",
    "ENV_API_KEYS_JSON",
    "ENV_AUTH_VERIFIER",
    "RequestCredentials",
    "credentials_from_headers",
    "CallerContext",
    "AuthDenial",
    "UnauthenticatedError",
    "ForbiddenError",
    "auth_denial_to_http_detail",
    "map_auth_failure",
    "AuthVerifier",
    "require_subject_access",
    "verify_or_deny",
    "extract_presented_secret",
    "StaticApiKeyVerifier",
    "PermissiveDevVerifier",
    "select_reference_verifier",
    "get_caller_context",
    "enforce_subject_scope",
    "enforce_path_subject_scope",
]
