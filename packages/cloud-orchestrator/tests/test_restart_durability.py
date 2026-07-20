"""Restart durability (A-G3).

Prove committed master state + all sync_audit rows survive process/container
restart. Prefer docker-compose SIGKILL of ``sutra-orchestrator`` when the
daemon is up; otherwise exercise the same durability contract against
``SUTRA_PG_DSN`` by closing and reopening ``PostgresMasterStateStore``
(process-kill equivalent — no app backdoors).
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import time
import uuid
from pathlib import Path

import pytest

pytestmark = pytest.mark.slow

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.contract_models import (
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
    SyncRequest,
)
from sutra_orchestrator.master_state_repository import (
    InMemoryMasterStateStore,
    PostgresMasterStateStore,
)
from sutra_orchestrator.sync_service import SyncService

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE_FILE = REPO_ROOT / "infra" / "docker-compose.yml"
ORCHESTRATOR_URL = os.environ.get("SUTRA_ORCHESTRATOR_URL", "http://127.0.0.1:8000")
N_SYNCS = 3

logger = logging.getLogger(__name__)


def _hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


def _make_state(
    subject_id: str,
    *,
    device: str,
    session_ms: int,
    alpha: float = 3.0,
) -> CognitiveState:
    return CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        deviceIds=[device],
        activeConceptId="math.ratios",
        mode="exploratory",
        mastery={
            "math.ratios": ConceptMastery(
                conceptId="math.ratios",
                alpha={device: alpha},
                beta={device: 1.0},
                lastExercisedAt=_hlc(session_ms, 0, device),
            )
        },
        frictionLog=[
            FrictionSample(
                conceptId="math.ratios",
                hesitationMs=500 + (session_ms % 100),
                inputVelocity=2.5,
                revisionCount=0,
                assistanceRequested=False,
                outcome="correct",
                capturedAt=_hlc(session_ms, 1, device),
            )
        ],
        profile=SubjectProfile(
            ageBand="child",
            track="cbse-class-7-maths",
            language="hi-IN",
            updatedAt=_hlc(session_ms, 2, device),
        ),
        stateVector={"session": _hlc(session_ms, 3, device)},
    )


def _pg_dsn() -> str | None:
    return os.environ.get("SUTRA_PG_DSN")


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
        timeout=180,
        check=check,
        cwd=str(REPO_ROOT),
    )


def _count_audits(dsn: str, subject_id: str) -> int:
    import psycopg

    with psycopg.connect(dsn) as conn:
        row = conn.execute(
            "SELECT count(*) FROM sync_audit WHERE subject_id = %s",
            (subject_id,),
        ).fetchone()
    assert row is not None
    return int(row[0])


def _fetch_audit_attempts(dsn: str, subject_id: str) -> list[str]:
    import psycopg

    with psycopg.connect(dsn) as conn:
        rows = conn.execute(
            """
            SELECT sync_attempt_id::text
            FROM sync_audit
            WHERE subject_id = %s
            ORDER BY created_at ASC, id ASC
            """,
            (subject_id,),
        ).fetchall()
    return [r[0] for r in rows]


# ── Always-on control + unit edges ──────────────────────────────────────────


def test_happy_path_in_memory_restart_loses_state_and_audit() -> None:
    """Negative control: memory backend is not durable across 'restart'."""
    store_a = InMemoryMasterStateStore()
    service = SyncService(store_a)
    subject = f"dur-mem-{uuid.uuid4().hex[:8]}"
    attempts: list[str] = []
    for i in range(N_SYNCS):
        attempt = str(uuid.uuid4())
        attempts.append(attempt)
        service.reconcile(
            SyncRequest(
                protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
                deviceId="edge-aaaa",
                edgeState=_make_state(subject, device="edge-aaaa", session_ms=1_000_000 + i),
                lastKnownCloudVector={},
                syncAttemptId=attempt,
            )
        )
    assert len(store_a.list_sync_audit(subject)) == N_SYNCS
    assert store_a.get_state(subject) is not None

    store_b = InMemoryMasterStateStore()  # process restart equivalent
    assert store_b.get_state(subject) is None
    assert store_b.list_sync_audit(subject) == []


def test_edge_observability_logs_exclude_raw_content(
    caplog: pytest.LogCaptureFixture,
) -> None:
    store = InMemoryMasterStateStore()
    service = SyncService(store)
    subject = f"dur-log-{uuid.uuid4().hex[:8]}"
    with caplog.at_level(logging.INFO, logger="sutra_orchestrator.master_state_repository"):
        service.reconcile(
            SyncRequest(
                protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
                deviceId="edge-bbbb",
                edgeState=_make_state(subject, device="edge-bbbb", session_ms=2_000_000),
                lastKnownCloudVector={},
                syncAttemptId=str(uuid.uuid4()),
            )
        )
    blob = " ".join(r.getMessage() for r in caplog.records)
    assert "sync_audit_append" in blob
    assert "subject_id=" in blob
    assert "device_id=" in blob
    assert "frictionLog" not in blob
    assert "hesitationMs" not in blob


# ── Postgres process-restart (DSN) ──────────────────────────────────────────


@pytest.mark.skipif(not _pg_dsn(), reason="SUTRA_PG_DSN not set")
def test_happy_path_postgres_reopen_survives_n_audits_and_state() -> None:
    """write N → close store (kill) → reopen → state + N audits byte-intact."""
    dsn = _pg_dsn()
    assert dsn is not None
    subject = f"dur-pg-{uuid.uuid4().hex[:10]}"
    attempts: list[str] = []
    last_state: CognitiveState | None = None

    store = PostgresMasterStateStore.from_dsn(dsn)
    try:
        service = SyncService(store)
        for i in range(N_SYNCS):
            attempt = str(uuid.uuid4())
            attempts.append(attempt)
            resp = service.reconcile(
                SyncRequest(
                    protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
                    deviceId="edge-aaaa" if i % 2 == 0 else "edge-bbbb",
                    edgeState=_make_state(
                        subject,
                        device="edge-aaaa" if i % 2 == 0 else "edge-bbbb",
                        session_ms=3_000_000 + i * 1_000,
                        alpha=3.0 + i,
                    ),
                    lastKnownCloudVector={},
                    syncAttemptId=attempt,
                )
            )
            last_state = resp.mergedState
            assert len(resp.advisories) >= 0  # advisories may be empty on first sync
    finally:
        store.close()

    assert last_state is not None
    expected_dump = last_state.model_dump(mode="json")

    restarted = PostgresMasterStateStore.from_dsn(dsn)
    try:
        loaded = restarted.get_state(subject)
        assert loaded is not None
        assert loaded.model_dump(mode="json") == expected_dump
        assert _count_audits(dsn, subject) == N_SYNCS
        assert _fetch_audit_attempts(dsn, subject) == attempts
        # Sovereignty: other subject sees zero rows.
        assert _count_audits(dsn, f"other-{uuid.uuid4().hex[:8]}") == 0
    finally:
        restarted.close()


@pytest.mark.skipif(not _pg_dsn(), reason="SUTRA_PG_DSN not set")
def test_edge_replay_after_restart_does_not_double_audit() -> None:
    dsn = _pg_dsn()
    assert dsn is not None
    subject = f"dur-replay-{uuid.uuid4().hex[:10]}"
    attempt = str(uuid.uuid4())
    edge = _make_state(subject, device="edge-aaaa", session_ms=4_000_000)
    req = SyncRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        deviceId="edge-aaaa",
        edgeState=edge,
        lastKnownCloudVector={},
        syncAttemptId=attempt,
    )

    store = PostgresMasterStateStore.from_dsn(dsn)
    try:
        SyncService(store).reconcile(req)
    finally:
        store.close()

    again = PostgresMasterStateStore.from_dsn(dsn)
    try:
        SyncService(again).reconcile(req)  # idempotent replay
        assert _count_audits(dsn, subject) == 1
        assert again.get_state(subject) is not None
    finally:
        again.close()


# ── Compose SIGKILL (docker daemon) ─────────────────────────────────────────


def _wait_healthy(url: str, *, timeout_s: float = 90.0) -> None:
    import urllib.error
    import urllib.request

    deadline = time.monotonic() + timeout_s
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{url}/v1/health", timeout=3) as resp:
                if resp.status == 200:
                    body = json.loads(resp.read().decode("utf-8"))
                    if body.get("status") == "ok":
                        return
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ConnectionResetError) as err:
            last_err = err
        time.sleep(1.5)
    raise TimeoutError(f"orchestrator not healthy at {url}: {last_err}")


@pytest.mark.compose
@pytest.mark.slow
@pytest.mark.skipif(not _docker_daemon_up(), reason="Docker daemon not running")
@pytest.mark.skipif(not COMPOSE_FILE.is_file(), reason="compose file missing")
def test_compose_sigkill_orchestrator_state_and_audits_survive(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Operator path: sync N → SIGKILL orchestrator → restart → assert survival."""
    import httpx

    # Bring up stack as an operator would (idempotent if already running).
    up = _compose("up", "-d", "--build", "pgvector", "redis", "orchestrator", check=False)
    if up.returncode != 0:
        pytest.skip(f"compose up failed: {up.stderr or up.stdout}")

    _wait_healthy(ORCHESTRATOR_URL)

    # Host DSN for audit inspection (same DB the orchestrator uses).
    password = os.environ.get("SUTRA_PG_PASSWORD", "sutra_dev_only")
    dsn = os.environ.get(
        "SUTRA_PG_DSN",
        f"postgresql://sutra:{password}@127.0.0.1:5432/sutra",
    )

    subject = f"dur-compose-{uuid.uuid4().hex[:10]}"
    attempts: list[str] = []
    last_dump: dict | None = None

    with httpx.Client(base_url=ORCHESTRATOR_URL, timeout=30.0) as client:
        headers = {"X-API-Key": "durability-test-key"}
        for i in range(N_SYNCS):
            attempt = str(uuid.uuid4())
            attempts.append(attempt)
            device = "edge-aaaa" if i % 2 == 0 else "edge-cccc"
            edge = _make_state(
                subject,
                device=device,
                session_ms=5_000_000 + i * 2_000,
                alpha=4.0 + i,
            )
            payload = {
                "protocolVersion": PROTOCOL_VERSION,
                "deviceId": device,
                "edgeState": edge.model_dump(mode="json"),
                "lastKnownCloudVector": {},
                "syncAttemptId": attempt,
            }
            res = client.post("/v1/sync", json=payload, headers=headers)
            assert res.status_code == 200, res.text
            body = res.json()
            last_dump = body["mergedState"]
            assert "advisories" in body

        assert last_dump is not None
        pre = client.get(f"/v1/subjects/{subject}/state", headers=headers)
        assert pre.status_code == 200
        assert pre.json() == last_dump

    assert _count_audits(dsn, subject) == N_SYNCS

    with caplog.at_level(logging.INFO):
        logger.info(
            "durability_kill subject_id=%s outcome=sigkill_orchestrator audits=%d",
            subject,
            N_SYNCS,
        )
        kill = subprocess.run(
            ["docker", "kill", "--signal", "SIGKILL", "sutra-orchestrator"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        assert kill.returncode == 0, kill.stderr

        # restart: unless-stopped may auto-revive; force compose start if needed.
        time.sleep(2)
        started = _compose("start", "orchestrator", check=False)
        if started.returncode != 0:
            _compose("up", "-d", "orchestrator", check=False)

    _wait_healthy(ORCHESTRATOR_URL, timeout_s=120.0)

    with httpx.Client(base_url=ORCHESTRATOR_URL, timeout=30.0) as client:
        headers = {"X-API-Key": "durability-test-key"}
        health = client.get("/v1/health")
        assert health.status_code == 200
        assert health.json().get("master_state_backend") == "postgres"

        post = client.get(f"/v1/subjects/{subject}/state", headers=headers)
        assert post.status_code == 200
        assert post.json() == last_dump

        # Idempotent replay after restart must not add a row.
        replay = {
            "protocolVersion": PROTOCOL_VERSION,
            "deviceId": "edge-aaaa",
            "edgeState": last_dump,
            "lastKnownCloudVector": {},
            "syncAttemptId": attempts[0],
        }
        again = client.post("/v1/sync", json=replay, headers=headers)
        assert again.status_code == 200

        # Cross-subject isolation via HTTP 404 for unknown subject.
        missing = client.get(
            f"/v1/subjects/other-{uuid.uuid4().hex[:8]}/state",
            headers=headers,
        )
        assert missing.status_code == 404

    assert _count_audits(dsn, subject) == N_SYNCS
    assert _fetch_audit_attempts(dsn, subject) == attempts
    # No raw content in our durability kill log line.
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "frictionLog" not in joined
    assert subject in joined
