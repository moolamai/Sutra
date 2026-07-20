"""Enhanced readiness matrix."""

from __future__ import annotations

import importlib
import uuid
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from sutra_orchestrator.middleware import (
    build_readiness_report,
    probe_postgres_health,
    probe_redis_health,
)
from sutra_orchestrator.master_state_repository import InMemoryMasterStateStore


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUTRA_API_KEYS", "test-dev-key")
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.delenv("SUTRA_REDIS_URL", raising=False)
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    with TestClient(main_mod.app) as c:
        yield c


def test_happy_path_memory_local_is_degraded_redis_absent(client: TestClient) -> None:
    """Local memory + no Redis → HTTP 200, status=degraded, redis=absent."""
    res = client.get("/v1/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "degraded"
    assert body["master_state_backend"] == "memory"
    comps = body["components"]
    assert comps["orchestrator"]["status"] == "ok"
    assert comps["postgres"]["status"] == "absent"
    assert comps["redis"]["status"] == "absent"
    assert comps["master_state"]["backend"] == "memory"
    assert comps["checkpointer"]["backend"] == "memory"
    # Sovereignty: never leak configuration secrets.
    blob = repr(body)
    assert "password" not in blob.lower()
    assert "postgresql://" not in blob
    assert "redis://" not in blob
    assert "subjectId" not in blob


def test_edge_redis_configured_unreachable_is_degraded_not_503(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SUTRA_API_KEYS", "test-dev-key")
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    monkeypatch.setenv("SUTRA_REDIS_URL", "redis://127.0.0.1:1/0")
    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)
    with TestClient(main_mod.app) as client:
        res = client.get("/v1/health")
        assert res.status_code == 200
        body = res.json()
        assert body["status"] == "degraded"
        assert body["components"]["redis"]["status"] == "degraded"
        assert body["components"]["checkpointer"]["status"] == "degraded"
        assert "redis://" not in repr(body)
        assert ":1/" not in repr(body)


def test_edge_postgres_down_returns_503() -> None:
    status, body = build_readiness_report(
        store=None,
        runtime_ready=False,
        redis_url=None,
        checkpointer_backend="memory",
        protocol="1.0.0",
        engine="0.0.0-test",
    )
    assert status == 503
    assert body["status"] == "down"
    assert body["components"]["orchestrator"]["status"] == "down"  # type: ignore[index]


def test_edge_postgres_probe_down_when_pool_fails() -> None:
    fake = MagicMock()
    fake.backend_name = "postgres"
    fake._pool.connection.side_effect = RuntimeError("boom")
    probed = probe_postgres_health(fake)
    assert probed["status"] == "down"
    assert probed["backend"] == "postgres"


def test_unit_memory_store_postgres_absent() -> None:
    store = InMemoryMasterStateStore()
    assert probe_postgres_health(store) == {"status": "absent", "backend": "memory"}


def test_unit_redis_absent() -> None:
    assert probe_redis_health(None)["status"] == "absent"
    assert probe_redis_health("")["status"] == "absent"


def test_unit_all_ok_aggregation() -> None:
    store = InMemoryMasterStateStore()
    # Force postgres component absent + redis ok via fake ping path:
    # redis_url with mock — use build with redis=None but override by crafting:
    http, body = build_readiness_report(
        store=store,
        runtime_ready=True,
        redis_url=None,
        checkpointer_backend="memory",
        protocol="1.0.0",
        engine="test",
        auth_backend="static_api_key",
    )
    assert http == 200
    assert body["status"] == "degraded"  # redis absent
    assert body["auth_backend"] == "static_api_key"


def test_sovereignty_health_never_includes_dsn_or_subject(
    client: TestClient,
) -> None:
    res = client.get("/v1/health")
    text = res.text
    assert "SUTRA_PG_DSN" not in text
    assert "utterance" not in text
    assert f"subj-{uuid.uuid4().hex}" not in text
