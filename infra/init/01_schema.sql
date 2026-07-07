-- Sutra cloud engine bootstrap schema.
-- Source of truth for the MCE tables; sutra_orchestrator.memory_graph
-- creates the same objects idempotently at runtime for non-compose deploys.

CREATE EXTENSION IF NOT EXISTS vector;

-- Long-term subject memory graph (MCE).
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
CREATE INDEX IF NOT EXISTS idx_memories_embedding
    ON subject_memories USING hnsw (embedding vector_cosine_ops);

-- Master cognitive-state documents (CRDT-converged JSONB replicas).
CREATE TABLE IF NOT EXISTS subject_states (
    subject_id  TEXT PRIMARY KEY,
    state       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only sync audit for the Playground's protocol inspector.
CREATE TABLE IF NOT EXISTS sync_audit (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subject_id       TEXT NOT NULL,
    device_id        TEXT NOT NULL,
    sync_attempt_id  UUID NOT NULL,
    advisories       JSONB NOT NULL DEFAULT '[]',
    received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (sync_attempt_id)
);
