"""Metrics + readiness against compose.

Operator path (no test backdoors):
  compose up → assert /v1/metrics + /v1/health ok → stop Redis → degraded (200)
  → start Redis → ok → stop Postgres → down (503) → restore stack.

Skips when the Docker daemon is unavailable (same contract as restart-durability).
Local / CI: ``pytest tests/test_compose_metrics_readiness.py -q``
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from pathlib import Path

import pytest

from sutra_orchestrator import PROTOCOL_VERSION

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE_FILE = REPO_ROOT / "infra" / "docker-compose.yml"
ORCHESTRATOR_URL = os.environ.get("SUTRA_ORCHESTRATOR_URL", "http://127.0.0.1:8000")

PG_CONTAINER = "sutra-pgvector"
REDIS_CONTAINER = "sutra-redis"
ORCH_CONTAINER = "sutra-orchestrator"


def _docker_daemon_up() -> bool:
    try:
        proc = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            timeout=15,
            check=False,
        )
        return proc.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False


def _compose(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    cmd = ["docker", "compose", "-f", str(COMPOSE_FILE), *args]
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=300,
        check=check,
        cwd=str(REPO_ROOT),
    )


def _docker(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args],
        capture_output=True,
        text=True,
        timeout=120,
        check=check,
    )


def _wait_health(
    url: str,
    *,
    statuses: frozenset[str],
    http_codes: frozenset[int],
    timeout_s: float = 120.0,
) -> dict:
    """Poll /v1/health until overall status ∈ statuses and HTTP ∈ http_codes."""
    import httpx

    deadline = time.monotonic() + timeout_s
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with httpx.Client(base_url=url, timeout=5.0) as client:
                res = client.get("/v1/health")
                if res.status_code in http_codes:
                    body = res.json()
                    if body.get("status") in statuses:
                        body["_http_status"] = res.status_code
                        return body
        except Exception as err:  # noqa: BLE001 — poll until deadline
            last = err
        time.sleep(1.5)
    raise TimeoutError(
        f"health wait failed want_status={sorted(statuses)} "
        f"want_http={sorted(http_codes)} last={last}"
    )


def _ensure_stack() -> None:
    up = _compose(
        "up",
        "-d",
        "--build",
        "pgvector",
        "redis",
        "orchestrator",
        check=False,
    )
    if up.returncode != 0:
        pytest.skip(f"compose up failed: {up.stderr or up.stdout}")
    _wait_health(
        ORCHESTRATOR_URL,
        statuses=frozenset({"ok"}),
        http_codes=frozenset({200}),
        timeout_s=180.0,
    )


def _restore_stack() -> None:
    """Best-effort restore so later suites / the developer desk stay usable."""
    _docker("start", PG_CONTAINER, check=False)
    _docker("start", REDIS_CONTAINER, check=False)
    time.sleep(2)
    started = _compose("start", "orchestrator", check=False)
    if started.returncode != 0:
        _compose("up", "-d", "orchestrator", check=False)
    try:
        _wait_health(
            ORCHESTRATOR_URL,
            statuses=frozenset({"ok"}),
            http_codes=frozenset({200}),
            timeout_s=180.0,
        )
    except TimeoutError:
        # Leave a breadcrumb; do not fail the assertion suite during teardown.
        pass


@pytest.mark.compose
@pytest.mark.slow
@pytest.mark.skipif(not _docker_daemon_up(), reason="Docker daemon not running")
@pytest.mark.skipif(not COMPOSE_FILE.is_file(), reason="compose file missing")
def test_compose_metrics_and_readiness_degraded_vs_down() -> None:
    """Happy path + Redis stop (degraded) + Postgres stop (down)."""
    import httpx

    _ensure_stack()

    try:
        with httpx.Client(base_url=ORCHESTRATOR_URL, timeout=30.0) as client:
            # ── Happy: metrics Prometheus exposition (auth exempt) ─────────
            metrics = client.get("/v1/metrics")
            assert metrics.status_code == 200, metrics.text
            assert "text/plain" in metrics.headers.get("content-type", "")
            body = metrics.text
            assert "# TYPE sutra_http_request_duration_ms histogram" in body
            assert "# TYPE sutra_sync_outcome_total counter" in body
            assert "# TYPE sutra_turn_stage_duration_ms histogram" in body
            assert "subject_id" not in body
            assert "subjectId" not in body
            assert "utterance" not in body
            # High-load scrape stays read-only (no throw / hang).
            for _ in range(5):
                assert client.get("/v1/metrics").status_code == 200

            # ── Happy: readiness ok with all dependencies ──────────────────
            health = client.get("/v1/health")
            assert health.status_code == 200
            h = health.json()
            assert h["status"] == "ok"
            assert h["components"]["postgres"]["status"] == "ok"
            assert h["components"]["redis"]["status"] == "ok"
            assert h["components"]["orchestrator"]["status"] == "ok"
            assert h["master_state_backend"] == "postgres"
            blob = json.dumps(h)
            assert "postgresql://" not in blob
            assert "redis://" not in blob
            assert "password" not in blob.lower()

            # Drive a sync so metrics counters are non-empty (operator realism).
            subject = f"healmetr-{uuid.uuid4().hex[:10]}"
            # Zero-config compose uses permissive_dev — any credential works.
            headers = {"X-API-Key": "compose-operator-surface"}
            sync_payload = {
                "protocolVersion": PROTOCOL_VERSION,
                "deviceId": "edge-aaaa",
                "edgeState": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "subjectId": subject,
                    "deviceIds": ["edge-aaaa"],
                    "activeConceptId": "math.ratios",
                    "mode": "exploratory",
                    "mastery": {
                        "math.ratios": {
                            "conceptId": "math.ratios",
                            "alpha": {"edge-aaaa": 1.0},
                            "beta": {"edge-aaaa": 1.0},
                            "lastExercisedAt": "000001700000000:000000:edge-aaaa",
                        }
                    },
                    "frictionLog": [],
                    "profile": {
                        "ageBand": "child",
                        "track": "cbse",
                        "language": "en-IN",
                        "updatedAt": "000001700000000:000001:edge-aaaa",
                    },
                    "stateVector": {
                        "session": "000001700000000:000002:edge-aaaa"
                    },
                },
                "lastKnownCloudVector": {},
                "syncAttemptId": str(uuid.uuid4()),
            }
            sync = client.post("/v1/sync", json=sync_payload, headers=headers)
            assert sync.status_code == 200, sync.text
            after_sync = client.get("/v1/metrics").text
            assert 'sutra_sync_outcome_total{outcome="converged"}' in after_sync
            assert subject not in after_sync  # sovereignty: no subject labels

        # ── Edge: Redis stopped → degraded, never 503 ─────────────────────
        stop_r = _docker("stop", REDIS_CONTAINER, check=False)
        assert stop_r.returncode == 0, stop_r.stderr
        degraded = _wait_health(
            ORCHESTRATOR_URL,
            statuses=frozenset({"degraded"}),
            http_codes=frozenset({200}),
            timeout_s=60.0,
        )
        assert degraded["components"]["redis"]["status"] == "degraded"
        assert degraded["components"]["postgres"]["status"] == "ok"
        # Metrics remain scrapeable while Redis is down.
        with httpx.Client(base_url=ORCHESTRATOR_URL, timeout=15.0) as client:
            assert client.get("/v1/metrics").status_code == 200

        # Restore Redis before Postgres chaos.
        assert _docker("start", REDIS_CONTAINER, check=False).returncode == 0
        _wait_health(
            ORCHESTRATOR_URL,
            statuses=frozenset({"ok"}),
            http_codes=frozenset({200}),
            timeout_s=120.0,
        )

        # ── Edge: Postgres stopped → down / 503 (or process unreachable) ──
        stop_p = _docker("stop", PG_CONTAINER, check=False)
        assert stop_p.returncode == 0, stop_p.stderr
        deadline = time.monotonic() + 90.0
        saw_down = False
        last_detail = ""
        while time.monotonic() < deadline:
            try:
                with httpx.Client(base_url=ORCHESTRATOR_URL, timeout=8.0) as client:
                    res = client.get("/v1/health")
                    last_detail = f"http={res.status_code} body={res.text[:300]}"
                    if res.status_code == 503:
                        body = res.json()
                        assert body["status"] == "down"
                        assert body["components"]["postgres"]["status"] == "down"
                        assert "postgresql://" not in res.text
                        saw_down = True
                        break
            except Exception as err:  # noqa: BLE001
                # Orchestrator crash-loop while PG is down is also "not ready".
                last_detail = f"unreachable:{type(err).__name__}"
                saw_down = True
                break
            time.sleep(1.5)
        assert saw_down, f"expected postgres-down readiness; last={last_detail}"

    finally:
        _restore_stack()


@pytest.mark.compose
@pytest.mark.slow
@pytest.mark.skipif(not _docker_daemon_up(), reason="Docker daemon not running")
@pytest.mark.skipif(not COMPOSE_FILE.is_file(), reason="compose file missing")
def test_compose_redis_absent_semantics_documented_by_degraded_matrix() -> None:
    """Re-assert Redis-stop ⇒ degraded (HTTP 200) after a clean ensure."""
    _ensure_stack()
    try:
        assert _docker("stop", REDIS_CONTAINER, check=False).returncode == 0
        body = _wait_health(
            ORCHESTRATOR_URL,
            statuses=frozenset({"degraded"}),
            http_codes=frozenset({200}),
            timeout_s=60.0,
        )
        assert body["components"]["redis"]["status"] in {"degraded", "absent"}
        assert body["_http_status"] == 200
    finally:
        _restore_stack()
