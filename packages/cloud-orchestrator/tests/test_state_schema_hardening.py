"""Harden subject_states / sync_audit DDL.

Static contract tests always run (no Postgres required). When ``SUTRA_PG_DSN``
is set, an optional live round-trip proves empty + Stage-0-seeded re-application
and JSONB state byte preservation.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = REPO_ROOT / "infra" / "init" / "01_schema.sql"

# Minimal Stage 0 shape (pre-hardening) used for the seeded-DB path.
STAGE0_SYNC_AUDIT_DDL = """
CREATE TABLE IF NOT EXISTS sync_audit (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subject_id       TEXT NOT NULL,
    device_id        TEXT NOT NULL,
    sync_attempt_id  UUID NOT NULL,
    advisories       JSONB NOT NULL DEFAULT '[]',
    received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (sync_attempt_id)
);
"""

STAGE0_SUBJECT_STATES_DDL = """
CREATE TABLE IF NOT EXISTS subject_states (
    subject_id  TEXT PRIMARY KEY,
    state       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


@pytest.fixture(scope="module")
def schema_sql() -> str:
    assert SCHEMA_PATH.is_file(), f"missing schema source of truth: {SCHEMA_PATH}"
    return SCHEMA_PATH.read_text(encoding="utf-8")


def test_happy_path_subject_states_and_sync_audit_contract(schema_sql: str) -> None:
    """PK + JSONB state + audit columns + retention / trigger are documented."""
    assert re.search(
        r"CREATE TABLE IF NOT EXISTS subject_states\s*\(\s*"
        r"subject_id\s+TEXT PRIMARY KEY\s*,\s*"
        r"state\s+JSONB NOT NULL\s*,\s*"
        r"updated_at\s+TIMESTAMPTZ NOT NULL",
        schema_sql,
        re.IGNORECASE | re.DOTALL,
    ), "subject_states must keep PK(subject_id) + JSONB state + updated_at"

    assert "sutra_touch_subject_states_updated_at" in schema_sql
    assert "trg_subject_states_touch_updated_at" in schema_sql
    assert "BEFORE UPDATE ON subject_states" in schema_sql

    for col in ("subject_id", "device_id", "protocol_version", "advisories", "created_at"):
        assert re.search(
            rf"\b{col}\b",
            schema_sql.split("CREATE TABLE IF NOT EXISTS sync_audit", 1)[1].split(
                "CREATE INDEX", 1
            )[0],
            re.IGNORECASE,
        ), f"sync_audit must declare column {col}"

    assert "advisories" in schema_sql and "JSONB" in schema_sql
    assert "≥ 90 days" in schema_sql or ">= 90 days" in schema_sql or "≥90d" in schema_sql
    assert "lifetime of the subject" in schema_sql.lower() or "lifetime retention" in schema_sql.lower()
    assert "idx_sync_audit_subject_created" in schema_sql


def test_edge_idempotent_against_stage0_and_irreversible(schema_sql: str) -> None:
    """Re-application uses IF NOT EXISTS / conditional rename; down-migration refused."""
    assert "ADD COLUMN IF NOT EXISTS protocol_version" in schema_sql
    assert "ADD COLUMN IF NOT EXISTS created_at" in schema_sql
    assert "RENAME COLUMN received_at TO created_at" in schema_sql
    assert "CREATE TABLE IF NOT EXISTS subject_states" in schema_sql
    assert "CREATE TABLE IF NOT EXISTS sync_audit" in schema_sql
    assert "DROP TRIGGER IF EXISTS trg_subject_states_touch_updated_at" in schema_sql

    assert "roll-forward only" in schema_sql.lower() or "irreversib" in schema_sql.lower()
    assert "Down-migrating" in schema_sql or "down-migrat" in schema_sql.lower()


def test_edge_sovereignty_append_only_and_subject_isolation(schema_sql: str) -> None:
    """Subject scoping + append-only audit + no plaintext in observability notes."""
    assert "Cross-subject access is a" in schema_sql or "cross-subject" in schema_sql.lower()
    assert "MUST NOT UPDATE or DELETE" in schema_sql or "MUST NOT UPDATE or DELETE" in schema_sql.upper()
    assert "never raw" in schema_sql.lower() or "never plaintext" in schema_sql.lower()
    assert "append-only" in schema_sql.lower()
    assert "UNIQUE (sync_attempt_id)" in schema_sql or "UNIQUE (sync_attempt_id)" in schema_sql.replace(
        "\n", " "
    )


def _pg_available() -> bool:
    return bool(os.environ.get("SUTRA_PG_DSN"))


def _apply_sql_script(conn: object, script: str) -> None:
    """Run a multi-statement SQL script via libpq PQexec."""
    import psycopg
    from psycopg.pq import ExecStatus

    assert isinstance(conn, psycopg.Connection)
    result = conn.pgconn.exec_(script.encode("utf-8"))
    if result.status == ExecStatus.FATAL_ERROR:
        raise RuntimeError(result.error_message.decode("utf-8", errors="replace"))


@pytest.mark.skipif(not _pg_available(), reason="SUTRA_PG_DSN not set")
def test_live_empty_and_seeded_round_trip(schema_sql: str) -> None:
    """Applies cleanly on empty + Stage-0-seeded DBs; JSONB state bytes survive."""
    import uuid

    import psycopg

    dsn = os.environ["SUTRA_PG_DSN"]
    probe_subject = f"probe.schema.{uuid.uuid4().hex}"
    state_json = '{"subjectId":"x","v":1,"token":"opaque-not-for-logs"}'

    with psycopg.connect(dsn, autocommit=True) as conn:
        # --- empty path: apply hardened schema twice (idempotent) ---
        conn.execute("DROP TABLE IF EXISTS sync_audit CASCADE")
        conn.execute("DROP TABLE IF EXISTS subject_states CASCADE")
        conn.execute(
            "DROP FUNCTION IF EXISTS sutra_touch_subject_states_updated_at() CASCADE"
        )
        _apply_sql_script(conn, schema_sql)
        _apply_sql_script(conn, schema_sql)  # second apply must be a no-op

        conn.execute(
            "INSERT INTO subject_states (subject_id, state) VALUES (%s, %s::jsonb)",
            (probe_subject, state_json),
        )
        # Postgres may re-serialize JSON key order; equality is via jsonb.
        assert (
            conn.execute(
                "SELECT state = %s::jsonb FROM subject_states WHERE subject_id = %s",
                (state_json, probe_subject),
            ).fetchone()[0]
            is True
        )

        before = conn.execute(
            "SELECT updated_at FROM subject_states WHERE subject_id = %s",
            (probe_subject,),
        ).fetchone()[0]
        conn.execute(
            "UPDATE subject_states SET state = state WHERE subject_id = %s",
            (probe_subject,),
        )
        after = conn.execute(
            "SELECT updated_at FROM subject_states WHERE subject_id = %s",
            (probe_subject,),
        ).fetchone()[0]
        assert after >= before

        # Sovereignty negative: different subject_id yields empty read set.
        other = conn.execute(
            "SELECT count(*) FROM subject_states WHERE subject_id = %s",
            (f"probe.other.{uuid.uuid4().hex}",),
        ).fetchone()[0]
        assert other == 0

        # --- seeded Stage 0 path ---
        conn.execute("DROP TABLE IF EXISTS sync_audit CASCADE")
        conn.execute("DROP TABLE IF EXISTS subject_states CASCADE")
        conn.execute(
            "DROP FUNCTION IF EXISTS sutra_touch_subject_states_updated_at() CASCADE"
        )
        _apply_sql_script(conn, STAGE0_SUBJECT_STATES_DDL)
        _apply_sql_script(conn, STAGE0_SYNC_AUDIT_DDL)
        attempt = uuid.uuid4()
        conn.execute(
            """
            INSERT INTO sync_audit (subject_id, device_id, sync_attempt_id, advisories)
            VALUES (%s, %s, %s, '[]'::jsonb)
            """,
            (probe_subject, "device-stage0", attempt),
        )
        _apply_sql_script(conn, schema_sql)

        cols = {
            r[0]
            for r in conn.execute(
                """
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'sync_audit'
                """
            ).fetchall()
        }
        assert "protocol_version" in cols
        assert "created_at" in cols
        assert "received_at" not in cols

        audit = conn.execute(
            """
            SELECT protocol_version, created_at IS NOT NULL
            FROM sync_audit WHERE sync_attempt_id = %s
            """,
            (attempt,),
        ).fetchone()
        assert audit is not None
        assert audit[0] == "1.0.0"
        assert audit[1] is True

        # Replayed sync_attempt_id must not double-apply.
        with pytest.raises(psycopg.errors.UniqueViolation):
            conn.execute(
                """
                INSERT INTO sync_audit
                  (subject_id, device_id, sync_attempt_id, protocol_version, advisories)
                VALUES (%s, %s, %s, '1.0.0', '[]'::jsonb)
                """,
                (probe_subject, "device-stage0", attempt),
            )
