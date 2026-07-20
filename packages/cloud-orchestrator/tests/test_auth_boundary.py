"""Default-deny auth dependency over /v1/*."""

from __future__ import annotations

import importlib
import json
import logging

import pytest
from fastapi.testclient import TestClient

from sutra_orchestrator.auth import PermissiveDevVerifier, StaticApiKeyVerifier

AUTH_HEADER = {"X-API-Key": "test-dev-key"}


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.delenv("SUTRA_API_KEYS_JSON", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "permissive_dev")
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    with TestClient(main_mod.app) as c:
        yield c


@pytest.fixture()
def api_key_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    keys = {
        "scoped-key": {
            "principalId": "teacher-1",
            "subjectScope": ["anika-k"],
        }
    }
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    monkeypatch.setenv("SUTRA_AUTH_VERIFIER", "api_key")
    monkeypatch.setenv("SUTRA_API_KEYS_JSON", json.dumps(keys))
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    with TestClient(main_mod.app) as c:
        assert isinstance(c.app.state.auth_verifier, StaticApiKeyVerifier)
        yield c


def test_happy_path_health_exempt_without_credentials(client: TestClient) -> None:
    res = client.get("/v1/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "degraded"
    assert body["components"]["redis"]["status"] == "absent"
    assert body.get("auth_backend") == "permissive_dev"
    assert isinstance(client.app.state.auth_verifier, PermissiveDevVerifier)


def test_happy_path_protected_route_with_dev_verifier(client: TestClient) -> None:
    # Unknown subject → 404 after auth (proves Depends ran and caller injected).
    res = client.get("/v1/subjects/missing-subj/state", headers=AUTH_HEADER)
    assert res.status_code == 404


def test_edge_protected_route_missing_credentials_401(client: TestClient) -> None:
    res = client.get("/v1/subjects/anika-k/state")
    assert res.status_code == 401
    detail = res.json()["detail"]
    assert detail["code"] == "MISSING_CREDENTIALS"


def test_edge_garbage_api_key_401(api_key_client: TestClient) -> None:
    res = api_key_client.get(
        "/v1/subjects/anika-k/state",
        headers={"X-API-Key": "%%%garbage%%%"},
    )
    assert res.status_code == 401
    assert res.json()["detail"]["code"] == "INVALID_CREDENTIALS"


def test_edge_scope_mismatch_403_on_subject_path(
    api_key_client: TestClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger="sutra_orchestrator.auth"):
        res = api_key_client.get(
            "/v1/subjects/other-student/state",
            headers={"X-API-Key": "scoped-key"},
        )
    assert res.status_code == 403
    assert res.json()["detail"]["code"] == "FORBIDDEN_SUBJECT_SCOPE"
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "auth_scope_audit" in joined
    assert "outcome=forbidden" in joined
    assert "frictionLog" not in joined


def test_edge_scoped_key_allows_in_scope_subject(api_key_client: TestClient) -> None:
    res = api_key_client.get(
        "/v1/subjects/anika-k/state",
        headers={"X-API-Key": "scoped-key"},
    )
    # Authenticated + in-scope; subject simply unknown → 404.
    assert res.status_code == 404


def test_edge_sync_audit_requires_auth(client: TestClient) -> None:
    assert client.get("/v1/subjects/x/sync-audit").status_code == 401
    res = client.get("/v1/subjects/x/sync-audit", headers=AUTH_HEADER)
    assert res.status_code == 200
    assert res.json()["items"] == []
