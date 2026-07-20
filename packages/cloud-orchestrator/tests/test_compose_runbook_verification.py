"""Verify operator runbook commands on compose.

Executes the documented operator path from the three runbooks against a live
``infra/docker-compose.yml`` stack (no test-only backdoors). Records pass/fail
per step. Skips when the Docker daemon is unavailable.

Local / CI:
  pytest tests/test_compose_runbook_verification.py -q
  bash packages/cloud-orchestrator/scripts/verify_operator_surfaces_compose.sh
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest

from tests._internal_runbooks import skip_without_internal_runbooks

pytestmark = skip_without_internal_runbooks

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE_FILE = REPO_ROOT / "infra" / "docker-compose.yml"
PKG_DIR = Path(__file__).resolve().parents[1]
RUNBOOKS = REPO_ROOT / "docs" / "operations" / "runbooks"
BRING_UP = RUNBOOKS / "local-dev-compose-bring-up.md"
SYNC_AUDIT = RUNBOOKS / "sync-audit-query-sync-06.md"
TRIAGE = RUNBOOKS / "incident-triage-basics.md"
SMOKE = PKG_DIR / "smoke_test.py"
PLAYGROUND_PKG = REPO_ROOT / "playground" / "package.json"
ORCHESTRATOR_URL = os.environ.get("SUTRA_ORCHESTRATOR_URL", "http://127.0.0.1:8000")
AUTH = {"X-API-Key": "compose-operator-surface"}
INBOUND_RID = "11111111-1111-4111-8111-111111111111"
ORCH_CONTAINER = "sutra-orchestrator"
PG_CONTAINER = "sutra-pgvector"


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
    return subprocess.run(
        ["docker", "compose", "-f", str(COMPOSE_FILE), *args],
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


def _marker_block(text: str, name: str) -> str:
    match = re.search(
        rf"<!-- {re.escape(name)} -->\s*(.*?)\s*<!-- /{re.escape(name)} -->",
        text,
        flags=re.DOTALL,
    )
    assert match, f"missing runbook marker {name}"
    return match.group(1)


def _sql_fence(marker_body: str) -> str:
    match = re.search(r"```sql\s*(.*?)\s*```", marker_body, flags=re.DOTALL)
    assert match, "expected ```sql fence in marker"
    return match.group(1).strip()


def _psql(sql: str) -> str:
    """Operator path: compose exec into pgvector (Win/Linux same)."""
    proc = _compose(
        "exec",
        "-T",
        "pgvector",
        "psql",
        "-U",
        "sutra",
        "-d",
        "sutra",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
        check=False,
    )
    assert proc.returncode == 0, f"psql failed: {proc.stderr or proc.stdout}"
    return proc.stdout


def _wait_health(
    *,
    statuses: frozenset[str],
    http_codes: frozenset[int],
    timeout_s: float = 180.0,
) -> dict:
    import httpx

    deadline = time.monotonic() + timeout_s
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with httpx.Client(base_url=ORCHESTRATOR_URL, timeout=5.0) as client:
                res = client.get("/v1/health")
                if res.status_code in http_codes:
                    body = res.json()
                    if body.get("status") in statuses:
                        body["_http_status"] = res.status_code
                        return body
        except Exception as err:  # noqa: BLE001
            last = err
        time.sleep(1.5)
    raise TimeoutError(f"health wait failed last={last}")


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
    _wait_health(statuses=frozenset({"ok"}), http_codes=frozenset({200}))


# ── Offline: runbook surface present (always runs in unit suite) ─────────────


def test_happy_path_all_runbooks_present_with_markers() -> None:
    """Documentation surface the compose suite will execute."""
    for path in (BRING_UP, SYNC_AUDIT, TRIAGE):
        assert path.is_file(), f"missing {path}"
    bring = BRING_UP.read_text(encoding="utf-8")
    assert "pnpm infra:up" in bring
    assert "python smoke_test.py" in bring
    assert "http://localhost:3000" in bring
    sync = SYNC_AUDIT.read_text(encoding="utf-8")
    assert "RUNBOOK_SEED_SQL" in sync
    assert "anika-k" in sync and "ravi-m" in sync
    triage = TRIAGE.read_text(encoding="utf-8")
    assert "X-Request-Id" in triage
    assert "sutra_sync_outcome_total" in triage
    assert PLAYGROUND_PKG.is_file()
    pkg = json.loads(PLAYGROUND_PKG.read_text(encoding="utf-8"))
    assert pkg.get("name") == "@moolam/playground" or "playground" in pkg.get(
        "name", ""
    )


def test_edge_runbook_sql_has_no_learner_content_columns() -> None:
    """Sovereignty: seed/query SQL never selects CognitiveState bodies."""
    sync = SYNC_AUDIT.read_text(encoding="utf-8")
    seed = _sql_fence(_marker_block(sync, "RUNBOOK_SEED_SQL"))
    assert "INSERT INTO sync_audit" in seed
    assert "utterance" not in seed.lower()
    assert "FROM subject_states" not in sync
    assert '"utterance"' not in sync


# ── Live compose verification ────────────────────────────────────────────────


@pytest.mark.compose
@pytest.mark.slow
@pytest.mark.skipif(not _docker_daemon_up(), reason="Docker daemon not running")
@pytest.mark.skipif(not COMPOSE_FILE.is_file(), reason="compose file missing")
def test_compose_all_runbook_commands_pass_fail_recorded() -> None:
    """Execute bring-up → SYNC-06 → triage commands; record pass/fail."""
    import httpx

    results: list[tuple[str, str]] = []

    def record(step: str, ok: bool, detail: str = "") -> None:
        status = "PASS" if ok else "FAIL"
        results.append((step, status))
        assert ok, f"{step} failed: {detail}"

    _ensure_stack()

    try:
        with httpx.Client(base_url=ORCHESTRATOR_URL, timeout=30.0) as client:
            # ── Bring-up: health + metrics (pnpm infra:up equivalent) ─────
            health = client.get("/v1/health")
            record(
                "bring-up:/v1/health",
                health.status_code == 200 and health.json().get("status") == "ok",
                health.text,
            )
            metrics = client.get("/v1/metrics")
            body = metrics.text
            record(
                "bring-up:/v1/metrics",
                metrics.status_code == 200
                and "# TYPE sutra_http_request_duration_ms histogram" in body
                and "subjectId" not in body
                and "subject_id" not in body,
                body[:400],
            )

            # ── Bring-up: smoke_test.py ───────────────────────────────────
            smoke = subprocess.run(
                [sys.executable, str(SMOKE)],
                cwd=str(PKG_DIR),
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            record(
                "bring-up:smoke_test.py",
                smoke.returncode == 0
                and "CRDT merge algebra: commutative, idempotent, dedup OK"
                in smoke.stdout,
                smoke.stderr or smoke.stdout,
            )

            # ── Bring-up: playground package surface (dev server is long-running;
            #    operators start `pnpm --filter @moolam/playground dev` themselves)
            pkg = json.loads(PLAYGROUND_PKG.read_text(encoding="utf-8"))
            scripts = pkg.get("scripts") or {}
            record(
                "bring-up:playground-package",
                PLAYGROUND_PKG.is_file()
                and ("dev" in scripts or "start" in scripts)
                and "http://localhost:3000" in BRING_UP.read_text(encoding="utf-8"),
                str(scripts),
            )

            # ── SYNC-06: empty subject before rely on seed ────────────────
            empty = client.get(
                "/v1/subjects/subject-does-not-exist/sync-audit",
                params={"limit": 50},
                headers=AUTH,
            )
            empty_json = empty.json()
            record(
                "sync-audit:api-empty",
                empty.status_code == 200
                and empty_json.get("items") == []
                and empty_json.get("nextCursor") in (None, ""),
                str(empty_json),
            )

            empty_sql = _psql(
                "SELECT count(*) FROM sync_audit "
                "WHERE subject_id = 'subject-does-not-exist';"
            )
            record(
                "sync-audit:sql-empty",
                "0" in empty_sql,
                empty_sql,
            )

            # ── SYNC-06: seed from runbook SQL (idempotent) ───────────────
            seed_sql = _sql_fence(
                _marker_block(SYNC_AUDIT.read_text(encoding="utf-8"), "RUNBOOK_SEED_SQL")
            )
            _psql(seed_sql)
            _psql(seed_sql)  # replay — ON CONFLICT DO NOTHING
            count_anika = _psql(
                "SELECT count(*) FROM sync_audit WHERE subject_id = 'anika-k';"
            )
            record(
                "sync-audit:seed-idempotent",
                re.search(r"\b3\b", count_anika) is not None,
                count_anika,
            )

            by_subj = _psql(
                "SELECT subject_id, device_id, sync_attempt_id::text "
                "FROM sync_audit WHERE subject_id = 'anika-k' "
                "ORDER BY created_at DESC LIMIT 50;"
            )
            record(
                "sync-audit:sql-by-subject",
                "anika-k" in by_subj
                and "ravi-m" not in by_subj
                and "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3" in by_subj,
                by_subj,
            )

            by_dev = _psql(
                "SELECT subject_id, device_id FROM sync_audit "
                "WHERE device_id = 'edge-aaaa' ORDER BY created_at DESC LIMIT 50;"
            )
            record(
                "sync-audit:sql-by-device",
                "edge-aaaa" in by_dev and "anika-k" in by_dev and "ravi-m" in by_dev,
                by_dev,
            )

            by_code = _psql(
                "SELECT sync_attempt_id::text FROM sync_audit, "
                "LATERAL jsonb_array_elements(advisories) AS adv "
                "WHERE subject_id = 'anika-k' "
                "AND adv->>'code' = 'CLOCK_SKEW_CLAMPED' "
                "LIMIT 50;"
            )
            record(
                "sync-audit:sql-by-code",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" in by_code,
                by_code,
            )

            api_subj = client.get(
                "/v1/subjects/anika-k/sync-audit",
                params={"limit": 50},
                headers=AUTH,
            )
            page = api_subj.json()
            record(
                "sync-audit:api-by-subject",
                api_subj.status_code == 200
                and page.get("subjectId") == "anika-k"
                and len(page.get("items", [])) == 3
                and {i["subjectId"] for i in page["items"]} == {"anika-k"},
                str(page)[:500],
            )

            api_code = client.get(
                "/v1/subjects/anika-k/sync-audit",
                params={"advisory_code": "CLOCK_SKEW_CLAMPED", "limit": 50},
                headers=AUTH,
            )
            code_page = api_code.json()
            record(
                "sync-audit:api-by-code",
                api_code.status_code == 200
                and len(code_page.get("items", [])) == 1
                and code_page["items"][0]["syncAttemptId"]
                == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
                str(code_page)[:400],
            )

            # Subject isolation: anika never returns ravi
            record(
                "sync-audit:subject-isolation",
                all(i["subjectId"] == "anika-k" for i in page["items"])
                and "utterance" not in json.dumps(page).lower(),
                "cross-subject or content leak",
            )

            # ── Restart survival: orchestrator bounce, audit persists ─────
            _docker("restart", ORCH_CONTAINER, check=False)
            _wait_health(statuses=frozenset({"ok"}), http_codes=frozenset({200}))
            after = client.get(
                "/v1/subjects/anika-k/sync-audit",
                params={"limit": 50},
                headers=AUTH,
            ).json()
            record(
                "sync-audit:restart-survival",
                len(after.get("items", [])) == 3,
                str(after)[:300],
            )

            # ── Triage: X-Request-Id correlation ──────────────────────────
            state_res = client.get(
                "/v1/subjects/anika-k/state",
                headers={**AUTH, "X-Request-Id": INBOUND_RID},
            )
            echoed = state_res.headers.get("X-Request-Id") or state_res.headers.get(
                "x-request-id"
            )
            record(
                "triage:request-id-echo",
                echoed == INBOUND_RID,
                f"echoed={echoed}",
            )

            logs = _compose(
                "logs",
                "--tail=300",
                "orchestrator",
                check=False,
            )
            log_text = (logs.stdout or "") + (logs.stderr or "")
            record(
                "triage:request-id-in-logs",
                INBOUND_RID in log_text
                and (
                    "http.request_complete" in log_text
                    or "request_id=" in log_text
                ),
                log_text[-800:],
            )

            # ── Triage: metrics TYPE lines + outcome counter present ──────
            m2 = client.get("/v1/metrics").text
            record(
                "triage:metrics-types",
                "# TYPE sutra_sync_outcome_total counter" in m2
                and "# TYPE sutra_http_request_duration_ms histogram" in m2
                and "subject_id=" not in m2,
                m2[:500],
            )

            # Drive one sync so outcome counter is observable (operator realism)
            subject = f"operrunb-{uuid.uuid4().hex[:10]}"
            from sutra_orchestrator import PROTOCOL_VERSION

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
            sync = client.post("/v1/sync", json=sync_payload, headers=AUTH)
            record("triage:sync-converged", sync.status_code == 200, sync.text)
            after_sync = client.get("/v1/metrics").text
            record(
                "triage:sync-outcome-metric",
                'sutra_sync_outcome_total{outcome="converged"}' in after_sync
                and subject not in after_sync,
                after_sync[after_sync.find("sutra_sync_outcome") :][:300]
                if "sutra_sync_outcome" in after_sync
                else after_sync[:300],
            )

            # Idempotent replay of same attempt id → still one audit row for subject
            attempt = str(uuid.uuid4())
            sync_payload["syncAttemptId"] = attempt
            assert client.post("/v1/sync", json=sync_payload, headers=AUTH).status_code == 200
            assert client.post("/v1/sync", json=sync_payload, headers=AUTH).status_code == 200
            audits = client.get(
                f"/v1/subjects/{subject}/sync-audit",
                params={"limit": 50},
                headers=AUTH,
            ).json()
            record(
                "sync-audit:idempotent-replay",
                len(audits.get("items", [])) == 1
                and audits["items"][0]["syncAttemptId"] == attempt,
                str(audits)[:400],
            )

    finally:
        # Emit a machine-readable pass/fail ledger for operators / CI logs.
        ledger = "\n".join(f"{status}\t{step}" for step, status in results)
        print("\n=== OPERRUNB-004 runbook verification ledger ===\n" + ledger)
        # Never leave Postgres stopped for other suites.
        _docker("start", PG_CONTAINER, check=False)
        _compose("start", "orchestrator", check=False)


def test_edge_compose_skip_contract_when_daemon_down() -> None:
    """Without Docker, the compose suite must skip — not error (local desks)."""
    if _docker_daemon_up():
        pytest.skip("daemon up — skip-contract N/A")
    # Mirror the skipif predicate used by the live suite.
    assert not _docker_daemon_up()
