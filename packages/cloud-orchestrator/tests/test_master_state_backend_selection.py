"""Backend selection from SUTRA_PG_DSN."""

from __future__ import annotations

import logging
import os
import uuid

import pytest
from fastapi.testclient import TestClient

from sutra_orchestrator.master_state_repository import (
    InMemoryMasterStateStore,
    MasterStateUnavailableError,
    PostgresMasterStateStore,
    select_master_state_backend,
)


def test_happy_path_unset_dsn_selects_memory() -> None:
    store = select_master_state_backend(None)
    assert isinstance(store, InMemoryMasterStateStore)
    assert store.backend_name == "memory"


def test_edge_bad_dsn_fail_fast() -> None:
    bad = "postgresql://sutra:wrong@127.0.0.1:1/sutra?connect_timeout=1"
    with pytest.raises(MasterStateUnavailableError):
        select_master_state_backend(bad)


def test_edge_lifespan_memory_when_dsn_unset(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv("SUTRA_PG_DSN", raising=False)
    # Fresh module state for globals updated by lifespan.
    import importlib

    import sutra_orchestrator.main as main_mod

    importlib.reload(main_mod)

    with caplog.at_level(logging.INFO, logger="sutra.orchestrator"):
        with TestClient(main_mod.app) as client:
            res = client.get("/v1/health")
            assert res.status_code == 200
            body = res.json()
            assert body["master_state_backend"] == "memory"
            assert body["status"] == "degraded"
            assert body["components"]["postgres"]["status"] == "absent"
            assert client.app.state.master_state_backend == "memory"
            assert isinstance(
                client.app.state.master_state_store, InMemoryMasterStateStore
            )

    selected = [
        r.getMessage()
        for r in caplog.records
        if "master_state_backend=" in r.getMessage() and "outcome=selected" in r.getMessage()
    ]
    assert len(selected) == 1
    assert "memory" in selected[0]
    # Sovereignty / observability: no raw cognitive payload in selection logs.
    assert "frictionLog" not in " ".join(r.getMessage() for r in caplog.records)
    assert "stateVector" not in " ".join(r.getMessage() for r in caplog.records)


@pytest.mark.skipif(not os.environ.get("SUTRA_PG_DSN"), reason="SUTRA_PG_DSN not set")
def test_happy_path_dsn_selects_postgres() -> None:
    store = select_master_state_backend(os.environ["SUTRA_PG_DSN"])
    try:
        assert isinstance(store, PostgresMasterStateStore)
        assert store.backend_name == "postgres"
        subject = f"sel-{uuid.uuid4().hex[:8]}"
        assert store.get_state(subject) is None  # not-found vs empty
    finally:
        store.close()
