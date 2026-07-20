# Pluggable Auth Deployment Guide

**Audience:** self-hosters and integrators wiring identity into the Sutra cloud engine  
**Code:** `packages/cloud-orchestrator/src/sutra_orchestrator/auth.py`  
**Status:** reference patterns — not an IdP product

Sovereignty means schools, hospitals, and solo developers bring their own identity layer. Sutra does **not** mandate OAuth/OIDC. The cloud host exposes an injectable `AuthVerifier` seam: verify credentials → `CallerContext` (principal + subject scope), or raise a typed denial (**401** unauthenticated / **403** out of scope).

This guide covers:

1. Verifier protocol walkthrough
2. API-key setup (reference verifier)
3. Custom verifier sketch (JWT)
4. mTLS-at-proxy pattern
5. Semantics operators must preserve

---

## 1. Verifier protocol walkthrough

### What handlers see

Handlers receive only a `CallerContext`. Raw tokens never reach sync / agent-turn / state code.

```python
from sutra_orchestrator.auth import CallerContext

# Operator scope — all subjects
CallerContext(principalId="ops-1", subjectScope="*")

# Explicit allow-list — one school class
CallerContext(principalId="teacher-1", subjectScope=["anika-k", "ravi-m"])
```

### What the boundary does

| Step | Module | Behavior |
|------|--------|----------|
| Extract | `credentials_from_headers` | Reads `Authorization` / `X-API-Key` only |
| Verify | `AuthVerifier.verify` | Returns `CallerContext` or raises denial |
| Map | `get_caller_context` | Denials → HTTP **401** / **403** (never **500** with a stack) |
| Scope | `enforce_subject_scope` | Path or body `subjectId` outside scope → **403** + `auth_scope_audit` |

Protected routes live on a default-deny FastAPI router. **`GET /v1/health` is the only opt-out.**

### Injection rule (invariant)

The verifier is selected **at app construction** (lifespan), not at import time, and not as a process-global singleton. The reference host does:

```python
# main.py lifespan (simplified)
from sutra_orchestrator.auth import select_reference_verifier

app.state.auth_verifier = select_reference_verifier()
```

To ship your own IdP bridge, replace that one assignment with your `AuthVerifier` implementation.

---

## 2. API-key setup (reference verifier)

### Environment

| Variable | Purpose |
|----------|---------|
| `SUTRA_AUTH_VERIFIER` | `api_key` or `permissive_dev` |
| `SUTRA_API_KEYS_JSON` | JSON object: apiKey → `{ principalId, subjectScope }` |

Keys are stored as SHA-256 digests in memory. Present them as `X-API-Key: <secret>` or `Authorization: Bearer <secret>`.

### Worked example

<!-- AUTH_GUIDE_API_KEYS_JSON -->
```json
{
  "sk_teacher_demo": {
    "principalId": "teacher-1",
    "subjectScope": ["anika-k", "ravi-m"]
  },
  "sk_ops_demo": {
    "principalId": "ops-1",
    "subjectScope": "*"
  }
}
```
<!-- /AUTH_GUIDE_API_KEYS_JSON -->

```bash
export SUTRA_AUTH_VERIFIER=api_key
export SUTRA_API_KEYS_JSON='{"sk_teacher_demo":{"principalId":"teacher-1","subjectScope":["anika-k","ravi-m"]},"sk_ops_demo":{"principalId":"ops-1","subjectScope":"*"}}'

uvicorn sutra_orchestrator.main:app --app-dir src
```

```bash
# In-scope state read → 200 or 404 (unknown subject), never 403
curl -s -H "X-API-Key: sk_teacher_demo" \
  http://127.0.0.1:8000/v1/subjects/anika-k/state

# Out-of-scope → 403 FORBIDDEN_SUBJECT_SCOPE
curl -s -H "X-API-Key: sk_teacher_demo" \
  http://127.0.0.1:8000/v1/subjects/other-student/state

# Missing credential on protected route → 401 MISSING_CREDENTIALS
curl -s http://127.0.0.1:8000/v1/subjects/anika-k/state

# Health stays open
curl -s http://127.0.0.1:8000/v1/health
```

### Programmatic construction

```python
from sutra_orchestrator.auth import CallerContext, StaticApiKeyVerifier

verifier = StaticApiKeyVerifier({
    "sk_teacher_demo": CallerContext(
        principalId="teacher-1",
        subjectScope=["anika-k", "ravi-m"],
    ),
})
# Assign in lifespan: app.state.auth_verifier = verifier
```

### `permissive_dev` (local only)

```bash
export SUTRA_AUTH_VERIFIER=permissive_dev
```

Any **present** credential becomes operator scope (`subjectScope: "*"`). Emits a loud WARNING at startup. **Not for production.** Missing credentials are still **401** — the API is never silently open.

---

## 3. Custom verifier example (JWT sketch)

Implement the same async surface as the reference verifiers. This sketch shows shape only — bring your own JWKS / library; Sutra does not vendor an IdP SDK.

```python
"""Sketch — not imported by the reference host."""

from __future__ import annotations

# operator chooses: PyJWT, authlib, etc.
# import jwt

from sutra_orchestrator.auth import (
    CallerContext,
    RequestCredentials,
    UnauthenticatedError,
    extract_presented_secret,
)


class JwtSubjectVerifier:
    """Map a Bearer JWT → CallerContext.

    Claim conventions (example for self-hosters):
      - ``sub`` → principalId
      - ``sutra_subjects`` → list[str] | \"*\"  (subjectScope)
    """

    backend_name = "jwt_sketch"

    def __init__(self, *, jwks_url: str, audience: str) -> None:
        self._jwks_url = jwks_url
        self._audience = audience

    async def verify(self, credentials: RequestCredentials) -> CallerContext:
        token = extract_presented_secret(credentials)
        if not token:
            raise UnauthenticatedError(
                code="MISSING_CREDENTIALS",
                message="authentication required",
            )
        try:
            # claims = jwt.decode(token, key=..., audience=self._audience, ...)
            raise UnauthenticatedError(
                code="INVALID_CREDENTIALS",
                message="wire your JWKS decode here",
            )
        except UnauthenticatedError:
            raise
        except Exception as err:
            # Never leak token material or stack traces to clients.
            raise UnauthenticatedError(
                code="INVALID_CREDENTIALS",
                message="credentials rejected",
            ) from err

        # return CallerContext(
        #     principalId=str(claims["sub"]),
        #     subjectScope=claims.get("sutra_subjects", []),
        # )
```

Inject at construction:

```python
# In your packaging lifespan (replace select_reference_verifier()):
app.state.auth_verifier = JwtSubjectVerifier(
    jwks_url="https://idp.example/.well-known/jwks.json",
    audience="sutra-cloud",
)
app.state.auth_backend = "jwt_sketch"
```

**Do not** raise bare exceptions from `verify` — use `UnauthenticatedError` / `ForbiddenError` so the boundary maps to **401** / **403**.

---

## 4. mTLS-at-proxy pattern

Many regulated deployments terminate mutual TLS at a reverse proxy and never put private keys in the orchestrator process.

```
Client ──mTLS──► Proxy (nginx / Envoy / Caddy)
                    │ verifies client cert
                    │ injects identity headers
                    ▼
              Cloud orchestrator (AuthVerifier)
```

### Sketch

1. Proxy requires client certificates; maps cert CN / SAN → internal principal.
2. Proxy forwards to the orchestrator over a private network.
3. Proxy injects a **trusted** credential: mint a short-lived API key (recommended) or a JWT whose `subjectScope` matches policy.
4. Orchestrator uses `StaticApiKeyVerifier` / JWT verifier as usual — it never sees client private keys.

**Recommended path for mTLS sites:** proxy authenticates the client cert, then attaches `X-API-Key` whose scope table you load via `SUTRA_API_KEYS_JSON` (or a JWT). The orchestrator stays IdP-agnostic.

Do **not** accept raw identity headers from the public internet. Only trust proxy-injected credentials when the hop is network-ACL’d or TLS-terminated to the proxy alone.

---

## 5. Semantics checklist

| Case | Status | Code |
|------|--------|------|
| No credential on protected route | **401** | `MISSING_CREDENTIALS` |
| Garbage credential | **401** | `INVALID_CREDENTIALS` |
| Valid principal, subject out of scope | **403** | `FORBIDDEN_SUBJECT_SCOPE` |
| Valid + in-scope | **200** (or resource 404) | — |
| `/v1/health` without credentials | **200** | — |

Observability: look for `auth_verify`, `auth_boundary`, and `auth_scope_audit` log lines carrying `principal_id` / `subject_id` / `outcome` — **never** utterances, friction logs, or raw tokens (`RequestCredentials` redacts secrets in `repr`).

Subject isolation: every sync body `edgeState.subjectId`, agent-turn `subjectId`, and path `/v1/subjects/{id}/…` is checked against `CallerContext.subjectScope`.

---

## Related

- Implementation: [`auth.py`](../src/sutra_orchestrator/auth.py), [`main.py`](../src/sutra_orchestrator/main.py)
- Semantics matrix: `tests/test_auth_semantics_matrix.py`
- Track A P2: API security and governance (pluggable AuthVerifier; no IdP product)
