"""Master cognitive-state repository protocol and backends.

Both the in-memory (unit tests / zero-infra dev) and Postgres
backends implement :class:`MasterStateRepository`. Reconciliation MUST
run read-merge-write under :meth:`MasterStateRepository.subject_guard`
so concurrent syncs for one ``subjectId`` cannot lose merges.

The Postgres backend uses **psycopg 3** (same driver as ``MemoryGraph``) over a
connection pool: JSONB round-trip, ``pg_advisory_xact_lock`` + ``FOR UPDATE``
serialization, and upsert-on-first-contact. The Stage 1 task brief names
asyncpg; this monorepo already standardizes on sync psycopg for FastAPI
handlers that call repositories directly.

Sovereignty: operations are keyed only by ``subject_id``. Structured
logs carry ``subject_id`` + outcome — never raw CognitiveState bytes.
"""

from __future__ import annotations

import logging
import threading
from contextlib import AbstractContextManager, contextmanager
from datetime import datetime
from typing import TYPE_CHECKING, Iterator, Mapping, Protocol, runtime_checkable

from .contract_models import CognitiveState
from .sync_audit_writer import SyncAuditRecord

if TYPE_CHECKING:
    from psycopg import Connection
    from psycopg_pool import ConnectionPool

logger = logging.getLogger(__name__)

# Bound the in-process lock table (NFR: no unbounded per-subject growth).
_SUBJECT_LOCK_STRIPES = 64

# Minimal subject_states DDL (matches infra/init/01_schema.sql hardening).
_SUBJECT_STATES_ENSURE_SQL = """
CREATE TABLE IF NOT EXISTS subject_states (
    subject_id  TEXT PRIMARY KEY,
    state       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION sutra_touch_subject_states_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_subject_states_touch_updated_at ON subject_states;
CREATE TRIGGER trg_subject_states_touch_updated_at
  BEFORE UPDATE ON subject_states
  FOR EACH ROW
  EXECUTE FUNCTION sutra_touch_subject_states_updated_at();
"""

# sync_audit subset for non-compose deploys (aligned with infra/init/01_schema.sql).
_SYNC_AUDIT_ENSURE_SQL = """
CREATE TABLE IF NOT EXISTS sync_audit (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subject_id          TEXT NOT NULL,
    device_id           TEXT NOT NULL,
    sync_attempt_id     UUID NOT NULL,
    protocol_version    TEXT NOT NULL,
    advisories          JSONB NOT NULL DEFAULT '[]',
    state_vector_before JSONB NOT NULL DEFAULT '{}'::jsonb,
    state_vector_after  JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (sync_attempt_id)
);

ALTER TABLE sync_audit ADD COLUMN IF NOT EXISTS protocol_version TEXT;
ALTER TABLE sync_audit ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE sync_audit ADD COLUMN IF NOT EXISTS state_vector_before JSONB;
ALTER TABLE sync_audit ADD COLUMN IF NOT EXISTS state_vector_after JSONB;

UPDATE sync_audit SET protocol_version = COALESCE(protocol_version, '1.0.0')
WHERE protocol_version IS NULL;
UPDATE sync_audit SET created_at = COALESCE(created_at, now()) WHERE created_at IS NULL;
UPDATE sync_audit SET state_vector_before = COALESCE(state_vector_before, '{}'::jsonb)
WHERE state_vector_before IS NULL;
UPDATE sync_audit SET state_vector_after = COALESCE(state_vector_after, '{}'::jsonb)
WHERE state_vector_after IS NULL;

ALTER TABLE sync_audit ALTER COLUMN protocol_version SET DEFAULT '1.0.0';
ALTER TABLE sync_audit ALTER COLUMN protocol_version SET NOT NULL;
ALTER TABLE sync_audit ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE sync_audit ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE sync_audit ALTER COLUMN state_vector_before SET DEFAULT '{}'::jsonb;
ALTER TABLE sync_audit ALTER COLUMN state_vector_before SET NOT NULL;
ALTER TABLE sync_audit ALTER COLUMN state_vector_after SET DEFAULT '{}'::jsonb;
ALTER TABLE sync_audit ALTER COLUMN state_vector_after SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sync_audit_subject_created
  ON sync_audit (subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_audit_device_created
  ON sync_audit (device_id, created_at DESC);
"""


class StaleStateVectorError(Exception):
    """Optimistic concurrency failure: the expected state vector no longer matches.

    Callers must re-read, re-merge, and retry — never last-write-wins overwrite.
    """

    def __init__(self, subject_id: str) -> None:
        self.subject_id = subject_id
        super().__init__(
            f"stale state vector for subject '{subject_id}'; re-read and retry"
        )


class CrossSubjectAccessError(Exception):
    """Raised when a put attempts to write under a mismatched subjectId.

    Cross-subject access is a defect, not a feature gap.
    """

    def __init__(self, expected_subject_id: str, actual_subject_id: str) -> None:
        self.expected_subject_id = expected_subject_id
        self.actual_subject_id = actual_subject_id
        super().__init__(
            f"cross-subject write refused: expected='{expected_subject_id}' "
            f"state.subjectId='{actual_subject_id}'"
        )


class MasterStateUnavailableError(Exception):
    """Postgres master-state backend could not be reached (fail fast at startup)."""


@runtime_checkable
class MasterStateRepository(Protocol):
    """Contract shared by in-memory and Postgres master-state backends."""

    def get_state(self, subject_id: str) -> CognitiveState | None:
        """Return the master document for ``subject_id``, or ``None`` if not found.

        Not-found is distinct from an empty document: missing subjects yield
        ``None``; callers (e.g. first sync) treat that as insert-on-put.
        """
        ...

    def put_state(
        self,
        state: CognitiveState,
        *,
        expected_state_vector: Mapping[str, str] | None = None,
        expected_subject_id: str | None = None,
    ) -> None:
        """Upsert ``state`` keyed by ``state.subjectId``.

        When ``expected_state_vector`` is provided and a row already exists,
        the write is rejected with :class:`StaleStateVectorError` unless the
        stored vector equals the expectation (CAS).

        When ``expected_subject_id`` is provided, it MUST equal ``state.subjectId``
        or :class:`CrossSubjectAccessError` is raised.
        """
        ...

    def subject_guard(self, subject_id: str) -> AbstractContextManager[None]:
        """Serialize read-merge-write for one ``subject_id``.

        Callers MUST hold the guard across get→merge→put for a reconciliation.
        """
        ...

    def append_sync_audit(self, record: SyncAuditRecord) -> None:
        """Append one sync_audit row inside the active ``subject_guard`` transaction.

        MUST be called while the guard for ``record.subject_id`` is held so the
        audit row commits atomically with the state write. Replay of the same
        ``sync_attempt_id`` is idempotent (no second row).
        """
        ...

    def query_sync_audit(
        self,
        subject_id: str,
        *,
        limit: int,
        cursor_created_at: datetime | None = None,
        cursor_attempt_id: str | None = None,
        advisory_code: str | None = None,
    ) -> list[SyncAuditRecord]:
        """Newest-first keyset page for ``subject_id``.

        Returns at most ``limit + 1`` rows so callers can detect a next page
        without COUNT(*). Cursor is exclusive: rows strictly older than
        ``(cursor_created_at, cursor_attempt_id)``. Unknown subjects yield [].
        """
        ...


class InMemoryMasterStateStore:
    """Process-local dict backend — contract-identical to the Postgres store.

    Durable only for the process lifetime. Suitable for unit tests and for
    local ``uvicorn`` without ``SUTRA_PG_DSN``. Restart clears all state
    (durability integration lives with the Postgres backend).
    """

    backend_name = "memory"

    def __init__(self) -> None:
        self._states: dict[str, CognitiveState] = {}
        self._audit_by_attempt: dict[str, SyncAuditRecord] = {}
        self._stripes = [threading.RLock() for _ in range(_SUBJECT_LOCK_STRIPES)]
        logger.info(
            "master_state_backend=%s outcome=ready",
            self.backend_name,
        )

    def _lock_for(self, subject_id: str) -> threading.RLock:
        # hash() is process-salted; stable within the process for striping.
        return self._stripes[hash(subject_id) % _SUBJECT_LOCK_STRIPES]

    def get_state(self, subject_id: str) -> CognitiveState | None:
        if not subject_id:
            raise ValueError("subject_id must be non-empty")
        state = self._states.get(subject_id)
        logger.info(
            "master_state_get subject_id=%s outcome=%s backend=%s",
            subject_id,
            "hit" if state is not None else "not_found",
            self.backend_name,
        )
        return state

    def put_state(
        self,
        state: CognitiveState,
        *,
        expected_state_vector: Mapping[str, str] | None = None,
        expected_subject_id: str | None = None,
    ) -> None:
        subject_id = state.subjectId
        if not subject_id:
            raise ValueError("state.subjectId must be non-empty")

        if expected_subject_id is not None and subject_id != expected_subject_id:
            logger.warning(
                "master_state_put subject_id=%s outcome=cross_subject_refused "
                "expected_subject_id=%s backend=%s",
                subject_id,
                expected_subject_id,
                self.backend_name,
            )
            raise CrossSubjectAccessError(expected_subject_id, subject_id)

        current = self._states.get(subject_id)
        if expected_state_vector is not None and current is not None:
            if dict(current.stateVector) != dict(expected_state_vector):
                logger.warning(
                    "master_state_put subject_id=%s outcome=stale_state_vector backend=%s",
                    subject_id,
                    self.backend_name,
                )
                raise StaleStateVectorError(subject_id)

        self._states[subject_id] = state
        logger.info(
            "master_state_put subject_id=%s outcome=%s backend=%s",
            subject_id,
            "insert" if current is None else "update",
            self.backend_name,
        )

    @contextmanager
    def subject_guard(self, subject_id: str) -> Iterator[None]:
        if not subject_id:
            raise ValueError("subject_id must be non-empty")
        lock = self._lock_for(subject_id)
        with lock:
            logger.info(
                "master_state_guard subject_id=%s outcome=acquired backend=%s",
                subject_id,
                self.backend_name,
            )
            try:
                yield
            finally:
                logger.info(
                    "master_state_guard subject_id=%s outcome=released backend=%s",
                    subject_id,
                    self.backend_name,
                )

    def append_sync_audit(self, record: SyncAuditRecord) -> None:
        if not record.subject_id:
            raise ValueError("record.subject_id must be non-empty")
        existing = self._audit_by_attempt.get(record.sync_attempt_id)
        if existing is not None:
            if existing.subject_id != record.subject_id:
                raise CrossSubjectAccessError(existing.subject_id, record.subject_id)
            logger.info(
                "sync_audit_append subject_id=%s device_id=%s "
                "outcome=duplicate_ignored backend=%s advisories=%d",
                record.subject_id,
                record.device_id,
                self.backend_name,
                len(record.advisories),
            )
            return

        self._audit_by_attempt[record.sync_attempt_id] = record
        logger.info(
            "sync_audit_append subject_id=%s device_id=%s outcome=inserted "
            "backend=%s advisories=%d",
            record.subject_id,
            record.device_id,
            self.backend_name,
            len(record.advisories),
        )

    def list_sync_audit(self, subject_id: str) -> list[SyncAuditRecord]:
        """Test helper: subject-scoped audit rows (bounded by in-memory set)."""
        return [
            row
            for row in self._audit_by_attempt.values()
            if row.subject_id == subject_id
        ]

    def query_sync_audit(
        self,
        subject_id: str,
        *,
        limit: int,
        cursor_created_at: datetime | None = None,
        cursor_attempt_id: str | None = None,
        advisory_code: str | None = None,
    ) -> list[SyncAuditRecord]:
        if not subject_id:
            raise ValueError("subject_id must be non-empty")
        if limit < 1:
            raise ValueError("limit must be >= 1")

        rows = [r for r in self._audit_by_attempt.values() if r.subject_id == subject_id]
        if advisory_code is not None:
            rows = [r for r in rows if advisory_code in r.advisory_codes()]
        rows.sort(
            key=lambda r: (r.created_at, r.sync_attempt_id),
            reverse=True,
        )
        if cursor_created_at is not None and cursor_attempt_id is not None:
            rows = [
                r
                for r in rows
                if (r.created_at, r.sync_attempt_id)
                < (cursor_created_at, cursor_attempt_id)
            ]

        page = rows[: limit + 1]
        logger.info(
            "sync_audit_query subject_id=%s outcome=ok backend=%s items=%d "
            "limit=%d advisory_filtered=%s",
            subject_id,
            self.backend_name,
            len(page),
            limit,
            advisory_code is not None,
        )
        return page

    # ── Compatibility aliases (AgentRuntime / early call sites use get/put) ──

    def get(self, subject_id: str) -> CognitiveState | None:
        return self.get_state(subject_id)

    def put(self, state: CognitiveState) -> None:
        self.put_state(state)


class PostgresMasterStateStore:
    """JSONB master-state repository with per-subject transactional serialization.

    ``subject_guard`` opens a transaction, takes ``pg_advisory_xact_lock``
    (covers first-insert races) and ``SELECT … FOR UPDATE`` on an existing
    row, then binds that connection to the calling thread so get/put share
    the lock for the full read-merge-write.
    """

    backend_name = "postgres"

    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool
        self._local = threading.local()
        logger.info(
            "master_state_backend=%s outcome=ready",
            self.backend_name,
        )

    @classmethod
    def from_dsn(
        cls,
        dsn: str,
        *,
        pool_size: int = 8,
        ensure_schema: bool = True,
    ) -> PostgresMasterStateStore:
        """Open a pool and fail fast if Postgres is unreachable."""
        from psycopg_pool import ConnectionPool

        connect_dsn = dsn
        if "connect_timeout=" not in dsn:
            sep = "&" if "?" in dsn else "?"
            connect_dsn = f"{dsn}{sep}connect_timeout=5"

        try:
            pool = ConnectionPool(
                connect_dsn,
                min_size=1,
                max_size=pool_size,
                open=True,
                timeout=10.0,
            )
            with pool.connection() as conn:
                conn.execute("SELECT 1")
        except Exception as err:
            logger.error(
                "master_state_backend=postgres outcome=unavailable err_type=%s",
                type(err).__name__,
            )
            raise MasterStateUnavailableError(
                "Postgres master state unavailable at startup — refusing to boot "
                "half-alive. Check SUTRA_PG_DSN and database readiness."
            ) from err

        store = cls(pool)
        if ensure_schema:
            store.ensure_schema()
        return store

    def ensure_schema(self) -> None:
        """Idempotently create ``subject_states`` + ``sync_audit`` (+ triggers)."""
        from psycopg.pq import ExecStatus

        with self._pool.connection() as conn:
            for label, script in (
                ("subject_states", _SUBJECT_STATES_ENSURE_SQL),
                ("sync_audit", _SYNC_AUDIT_ENSURE_SQL),
            ):
                result = conn.pgconn.exec_(script.encode("utf-8"))
                if result.status == ExecStatus.FATAL_ERROR:
                    raise RuntimeError(
                        f"{label}: "
                        + result.error_message.decode("utf-8", errors="replace")
                    )
            conn.commit()
        logger.info(
            "master_state_schema outcome=ensured backend=%s",
            self.backend_name,
        )

    def close(self) -> None:
        self._pool.close()

    def _tx_conn(self) -> Connection | None:
        return getattr(self._local, "conn", None)

    def _fetch_state(self, conn: Connection, subject_id: str) -> CognitiveState | None:
        row = conn.execute(
            "SELECT state FROM subject_states WHERE subject_id = %s",
            (subject_id,),
        ).fetchone()
        if row is None:
            return None
        return CognitiveState.model_validate(row[0])

    def get_state(self, subject_id: str) -> CognitiveState | None:
        if not subject_id:
            raise ValueError("subject_id must be non-empty")

        conn = self._tx_conn()
        if conn is not None:
            state = self._fetch_state(conn, subject_id)
        else:
            with self._pool.connection() as short:
                state = self._fetch_state(short, subject_id)

        logger.info(
            "master_state_get subject_id=%s outcome=%s backend=%s",
            subject_id,
            "hit" if state is not None else "not_found",
            self.backend_name,
        )
        return state

    def put_state(
        self,
        state: CognitiveState,
        *,
        expected_state_vector: Mapping[str, str] | None = None,
        expected_subject_id: str | None = None,
    ) -> None:
        from psycopg.types.json import Jsonb

        subject_id = state.subjectId
        if not subject_id:
            raise ValueError("state.subjectId must be non-empty")

        if expected_subject_id is not None and subject_id != expected_subject_id:
            logger.warning(
                "master_state_put subject_id=%s outcome=cross_subject_refused "
                "expected_subject_id=%s backend=%s",
                subject_id,
                expected_subject_id,
                self.backend_name,
            )
            raise CrossSubjectAccessError(expected_subject_id, subject_id)

        payload = Jsonb(state.model_dump(mode="json"))

        def _write(conn: Connection) -> str:
            current = self._fetch_state(conn, subject_id)
            if expected_state_vector is not None and current is not None:
                if dict(current.stateVector) != dict(expected_state_vector):
                    logger.warning(
                        "master_state_put subject_id=%s outcome=stale_state_vector "
                        "backend=%s",
                        subject_id,
                        self.backend_name,
                    )
                    raise StaleStateVectorError(subject_id)

            # Upsert: first contact inserts; concurrent firsts serialize via guard.
            conn.execute(
                """
                INSERT INTO subject_states (subject_id, state)
                VALUES (%s, %s)
                ON CONFLICT (subject_id) DO UPDATE
                  SET state = EXCLUDED.state
                """,
                (subject_id, payload),
            )
            return "insert" if current is None else "update"

        tx = self._tx_conn()
        if tx is not None:
            outcome = _write(tx)
        else:
            with self._pool.connection() as conn:
                with conn.transaction():
                    # Serialize even outside an outer guard (safe default).
                    conn.execute(
                        "SELECT pg_advisory_xact_lock(hashtext(%s))",
                        (subject_id,),
                    )
                    conn.execute(
                        """
                        SELECT subject_id FROM subject_states
                        WHERE subject_id = %s FOR UPDATE
                        """,
                        (subject_id,),
                    )
                    outcome = _write(conn)

        logger.info(
            "master_state_put subject_id=%s outcome=%s backend=%s",
            subject_id,
            outcome,
            self.backend_name,
        )

    @contextmanager
    def subject_guard(self, subject_id: str) -> Iterator[None]:
        if not subject_id:
            raise ValueError("subject_id must be non-empty")
        if self._tx_conn() is not None:
            raise RuntimeError(
                "nested subject_guard is not supported on PostgresMasterStateStore"
            )

        with self._pool.connection() as conn:
            try:
                with conn.transaction():
                    # Advisory lock covers first-insert (no row yet for FOR UPDATE).
                    conn.execute(
                        "SELECT pg_advisory_xact_lock(hashtext(%s))",
                        (subject_id,),
                    )
                    conn.execute(
                        """
                        SELECT subject_id FROM subject_states
                        WHERE subject_id = %s FOR UPDATE
                        """,
                        (subject_id,),
                    )
                    self._local.conn = conn
                    self._local.subject_id = subject_id
                    logger.info(
                        "master_state_guard subject_id=%s outcome=acquired backend=%s",
                        subject_id,
                        self.backend_name,
                    )
                    try:
                        yield
                    finally:
                        self._local.conn = None
                        self._local.subject_id = None
                        logger.info(
                            "master_state_guard subject_id=%s outcome=released backend=%s",
                            subject_id,
                            self.backend_name,
                        )
            except Exception:
                logger.error(
                    "master_state_guard subject_id=%s outcome=rolled_back backend=%s",
                    subject_id,
                    self.backend_name,
                )
                raise

    def get(self, subject_id: str) -> CognitiveState | None:
        return self.get_state(subject_id)

    def put(self, state: CognitiveState) -> None:
        self.put_state(state)

    def append_sync_audit(self, record: SyncAuditRecord) -> None:
        """INSERT sync_audit on the guard connection (same txn as state put)."""
        from psycopg.types.json import Jsonb

        conn = self._tx_conn()
        if conn is None:
            raise RuntimeError(
                "append_sync_audit requires an active subject_guard transaction"
            )
        guard_subject = getattr(self._local, "subject_id", None)
        if guard_subject is not None and guard_subject != record.subject_id:
            logger.warning(
                "sync_audit_append subject_id=%s outcome=cross_subject_refused "
                "expected_subject_id=%s backend=%s",
                record.subject_id,
                guard_subject,
                self.backend_name,
            )
            raise CrossSubjectAccessError(guard_subject, record.subject_id)

        result = conn.execute(
            """
            INSERT INTO sync_audit (
                subject_id, device_id, sync_attempt_id, protocol_version,
                advisories, state_vector_before, state_vector_after
            )
            VALUES (%s, %s, %s::uuid, %s, %s, %s, %s)
            ON CONFLICT (sync_attempt_id) DO NOTHING
            """,
            (
                record.subject_id,
                record.device_id,
                record.sync_attempt_id,
                record.protocol_version,
                Jsonb([dict(a) for a in record.advisories]),
                Jsonb(dict(record.state_vector_before)),
                Jsonb(dict(record.state_vector_after)),
            ),
        )
        inserted = result.rowcount == 1
        logger.info(
            "sync_audit_append subject_id=%s device_id=%s outcome=%s "
            "backend=%s advisories=%d",
            record.subject_id,
            record.device_id,
            "inserted" if inserted else "duplicate_ignored",
            self.backend_name,
            len(record.advisories),
        )

    def query_sync_audit(
        self,
        subject_id: str,
        *,
        limit: int,
        cursor_created_at: datetime | None = None,
        cursor_attempt_id: str | None = None,
        advisory_code: str | None = None,
    ) -> list[SyncAuditRecord]:
        if not subject_id:
            raise ValueError("subject_id must be non-empty")
        if limit < 1:
            raise ValueError("limit must be >= 1")

        # Keyset: exclusive older-than cursor under (created_at DESC, attempt DESC).
        sql = """
            SELECT subject_id, device_id, sync_attempt_id::text, protocol_version,
                   advisories, state_vector_before, state_vector_after, created_at
            FROM sync_audit
            WHERE subject_id = %s
              AND (
                    %s::timestamptz IS NULL
                    OR (created_at, sync_attempt_id::text)
                       < (%s::timestamptz, %s::text)
                  )
              AND (
                    %s::text IS NULL
                    OR EXISTS (
                         SELECT 1
                         FROM jsonb_array_elements(advisories) AS adv
                         WHERE adv->>'code' = %s
                    )
                  )
            ORDER BY created_at DESC, sync_attempt_id DESC
            LIMIT %s
            """
        fetch_limit = limit + 1
        with self._pool.connection() as conn:
            rows = conn.execute(
                sql,
                (
                    subject_id,
                    cursor_created_at,
                    cursor_created_at,
                    cursor_attempt_id,
                    advisory_code,
                    advisory_code,
                    fetch_limit,
                ),
            ).fetchall()

        items: list[SyncAuditRecord] = []
        for row in rows:
            advisories_raw = row[4] or []
            advisories = tuple(
                {"code": str(a["code"]), "detail": str(a["detail"])}
                for a in advisories_raw
            )
            created = row[7]
            if created is not None and created.tzinfo is None:
                from datetime import timezone

                created = created.replace(tzinfo=timezone.utc)
            items.append(
                SyncAuditRecord(
                    subject_id=str(row[0]),
                    device_id=str(row[1]),
                    sync_attempt_id=str(row[2]),
                    protocol_version=str(row[3]),
                    advisories=advisories,
                    state_vector_before=dict(row[5] or {}),
                    state_vector_after=dict(row[6] or {}),
                    created_at=created,
                )
            )

        logger.info(
            "sync_audit_query subject_id=%s outcome=ok backend=%s items=%d "
            "limit=%d advisory_filtered=%s",
            subject_id,
            self.backend_name,
            len(items),
            limit,
            advisory_code is not None,
        )
        return items


# Historical name retained for AgentRuntime type hints and imports.
MasterStateStore = InMemoryMasterStateStore


def select_master_state_backend(dsn: str | None) -> MasterStateRepository:
    """Select Postgres when ``dsn`` is set; otherwise the in-memory backend.

    Postgres selection uses :meth:`PostgresMasterStateStore.from_dsn`, which
    fail-fasts with :class:`MasterStateUnavailableError` when the database is
    unreachable — never a half-alive server.
    """
    if dsn:
        # Deferred so unit tests without psycopg pool wiring stay light when
        # only the memory path is exercised.
        return PostgresMasterStateStore.from_dsn(dsn)
    return InMemoryMasterStateStore()
