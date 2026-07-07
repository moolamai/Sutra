"""Memory & Context Engine (MCE) — pgvector-backed long-term subject memory.

The cloud half of the platform's memory system. Each subject accumulates a
personal memory graph: corrections, milestones, preferences, and episodic
traces, embedded and stored in Postgres with the ``vector`` extension.
Retrieval is time-decayed cosine KNN, mirroring the scoring semantics of
the edge's ``LocalVectorDb`` so a session feels continuous across the
online/offline boundary.

Schema is created idempotently by :meth:`MemoryGraph.ensure_schema` and
matches ``infra/init/01_schema.sql`` (source of truth for migrations).
"""

from __future__ import annotations

import logging
import math
import time
import uuid
from dataclasses import dataclass
from typing import Literal, Sequence

import numpy as np
from pgvector.psycopg import register_vector
from psycopg import Connection
from psycopg_pool import ConnectionPool

logger = logging.getLogger(__name__)

MemoryKind = Literal["correction", "milestone", "preference", "episodic"]

EMBEDDING_DIMENSION = 768  # nomic-embed-text / gte-base class models
EPISODIC_HALF_LIFE_DAYS = 30.0


@dataclass(frozen=True)
class MemoryHit:
    """One retrieved memory with its decay-weighted relevance score."""

    memory_id: uuid.UUID
    concept_id: str
    text: str
    kind: MemoryKind
    score: float


SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS subject_memories (
    id           UUID PRIMARY KEY,
    subject_id   TEXT NOT NULL,
    concept_id   TEXT NOT NULL,
    text         TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('correction','milestone','preference','episodic')),
    embedding    vector(768) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memories_subject ON subject_memories (subject_id, concept_id);

-- HNSW gives better recall/latency than IVFFlat at our per-subject
-- cardinalities and needs no training step, so it works from row #1.
CREATE INDEX IF NOT EXISTS idx_memories_embedding
    ON subject_memories USING hnsw (embedding vector_cosine_ops);
"""


class MemoryGraph:
    """Long-term adaptation store for one deployment (multi-tenant by
    ``subject_id``).

    All methods are synchronous psycopg-3 over a connection pool; FastAPI
    handlers call them via ``run_in_threadpool`` to keep the event loop hot.
    """

    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    @classmethod
    def from_dsn(cls, dsn: str, *, pool_size: int = 8) -> "MemoryGraph":
        """Build a graph over a fresh pool. pgvector's adapter is registered
        on every connection at checkout."""

        def _configure(conn: Connection) -> None:
            register_vector(conn)

        pool = ConnectionPool(dsn, min_size=1, max_size=pool_size, configure=_configure)
        return cls(pool)

    def ensure_schema(self) -> None:
        """Idempotently create extension, table, and indexes."""
        with self._pool.connection() as conn:
            conn.execute(SCHEMA_SQL)
            conn.commit()
        logger.info("subject_memories schema ensured (dim=%d)", EMBEDDING_DIMENSION)

    # ── writes ──────────────────────────────────────────────────────────

    def remember(
        self,
        subject_id: str,
        concept_id: str,
        text: str,
        kind: MemoryKind,
        embedding: Sequence[float],
    ) -> uuid.UUID:
        """Persist one memory. Raises ``ValueError`` on dimension mismatch
        rather than letting Postgres reject it a round-trip later."""
        vector = np.asarray(embedding, dtype=np.float32)
        if vector.shape != (EMBEDDING_DIMENSION,):
            raise ValueError(
                f"embedding has shape {vector.shape}, expected ({EMBEDDING_DIMENSION},); "
                "did the embedding model change without a corpus re-embed?"
            )
        memory_id = uuid.uuid4()
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO subject_memories (id, subject_id, concept_id, text, kind, embedding)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (memory_id, subject_id, concept_id, text, kind, vector),
            )
            conn.commit()
        return memory_id

    # ── retrieval ───────────────────────────────────────────────────────

    def recall(
        self,
        subject_id: str,
        query_embedding: Sequence[float],
        *,
        concept_id: str | None = None,
        limit: int = 8,
    ) -> list[MemoryHit]:
        """Decay-weighted KNN over the subject's memory graph.

        Corrections never decay — a dormant correction resurfacing three
        months later is exactly what long-term adaptation must catch.
        Episodic memories decay with a 30-day half-life.
        """
        vector = np.asarray(query_embedding, dtype=np.float32)
        candidate_pool = max(limit * 4, 32)  # over-fetch, then decay-rerank

        sql = """
            SELECT id, concept_id, text, kind,
                   1 - (embedding <=> %s) AS similarity,
                   EXTRACT(EPOCH FROM (now() - created_at)) AS age_seconds
            FROM subject_memories
            WHERE subject_id = %s {concept_filter}
            ORDER BY embedding <=> %s
            LIMIT %s
        """.format(concept_filter="AND concept_id = %s" if concept_id else "")

        params: tuple = (
            (vector, subject_id, concept_id, vector, candidate_pool)
            if concept_id
            else (vector, subject_id, vector, candidate_pool)
        )

        with self._pool.connection() as conn:
            rows = conn.execute(sql, params).fetchall()

        half_life_s = EPISODIC_HALF_LIFE_DAYS * 86_400
        hits = [
            MemoryHit(
                memory_id=row[0],
                concept_id=row[1],
                text=row[2],
                kind=row[3],
                score=float(row[4])
                * (
                    math.exp(-math.log(2) * float(row[5]) / half_life_s)
                    if row[3] == "episodic"
                    else 1.0
                ),
            )
            for row in rows
        ]
        hits.sort(key=lambda h: h.score, reverse=True)
        return hits[:limit]

    # ── maintenance ─────────────────────────────────────────────────────

    def compact_episodic(self, subject_id: str, *, older_than_days: float = 180.0) -> int:
        """Drop fully-decayed episodic memories. Returns rows removed.

        Invoked by the nightly maintenance task; corrections, milestones,
        and preferences are retained indefinitely.
        """
        with self._pool.connection() as conn:
            cursor = conn.execute(
                """
                DELETE FROM subject_memories
                WHERE subject_id = %s AND kind = 'episodic'
                  AND created_at < now() - make_interval(days => %s)
                """,
                (subject_id, older_than_days),
            )
            conn.commit()
            removed = cursor.rowcount
        if removed:
            logger.info("compacted %d episodic memories for subject=%s", removed, subject_id)
        return removed


class InMemoryMemoryGraph:
    """Dependency-free stand-in with identical semantics, used by unit tests
    and by ``SUTRA_OFFLINE_DEV=1`` runs where Postgres is unavailable."""

    def __init__(self) -> None:
        self._rows: list[tuple[uuid.UUID, str, str, str, MemoryKind, np.ndarray, float]] = []

    def ensure_schema(self) -> None:  # parity no-op
        return None

    def remember(
        self,
        subject_id: str,
        concept_id: str,
        text: str,
        kind: MemoryKind,
        embedding: Sequence[float],
    ) -> uuid.UUID:
        memory_id = uuid.uuid4()
        vector = np.asarray(embedding, dtype=np.float32)
        self._rows.append((memory_id, subject_id, concept_id, text, kind, vector, time.time()))
        return memory_id

    def recall(
        self,
        subject_id: str,
        query_embedding: Sequence[float],
        *,
        concept_id: str | None = None,
        limit: int = 8,
    ) -> list[MemoryHit]:
        query = np.asarray(query_embedding, dtype=np.float32)
        qn = np.linalg.norm(query)
        half_life_s = EPISODIC_HALF_LIFE_DAYS * 86_400
        now = time.time()
        hits: list[MemoryHit] = []
        for mid, sid, cid, text, kind, vec, created in self._rows:
            if sid != subject_id or (concept_id and cid != concept_id):
                continue
            denom = qn * np.linalg.norm(vec)
            similarity = float(np.dot(query, vec) / denom) if denom else 0.0
            decay = math.exp(-math.log(2) * (now - created) / half_life_s) if kind == "episodic" else 1.0
            hits.append(MemoryHit(mid, cid, text, kind, similarity * decay))
        hits.sort(key=lambda h: h.score, reverse=True)
        return hits[:limit]
