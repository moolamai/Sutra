-- Sutra cloud engine bootstrap schema.
-- Source of truth for the MCE tables; sutra_orchestrator.memory_graph
-- creates the same objects idempotently at runtime for non-compose deploys.
--
-- Irreversibility (TASK-A-P1-POSTMASTST-STATSCHEMI-001):
--   This hardening is roll-forward only. Down-migrating (dropping columns,
--   reversing received_at → created_at, or deleting sync_audit rows) would
--   destroy SYNC-06 operator evidence and break hot-path repositories that
--   rely on PK / JSONB shape. Restore from backup if a change must be undone.
--
-- Idempotency:
--   Safe to re-apply against an empty database and against a database that
--   already ran the Stage 0 init script (CREATE IF NOT EXISTS + ADD COLUMN
--   IF NOT EXISTS + conditional rename). Concurrent re-application is a no-op.

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

-- ---------------------------------------------------------------------------
-- subject_states — master CognitiveState documents (CRDT-converged JSONB)
-- Ownership: cloud orchestrator MasterStateStore / Postgres repository.
-- Isolation: one row per subject_id (PRIMARY KEY). Cross-subject access is a
--   defect; every read/write MUST filter on subject_id.
-- Sovereignty: `state` may contain learner content. It MUST remain inside the
--   declared locality boundary (on-device / self-hosted). Observability events
--   about this table carry subject_id + device_id + outcome only — never raw
--   state bytes or plaintext content.
-- Retention: retained for the lifetime of the subject. Subject erasure is an
--   explicit operator action (DROP row / GDPR workflow), never a side effect
--   of sync. No TTL purge on this table.
-- Concurrency: repositories MUST serialize updates per subject_id
--   (SELECT … FOR UPDATE or state-vector CAS) so concurrent reconciliations
--   cannot lose merges.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subject_states (
    subject_id  TEXT PRIMARY KEY,
    state       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE subject_states IS
  'Master CognitiveState JSONB keyed by subject_id; lifetime retention; locality-bound.';
COMMENT ON COLUMN subject_states.subject_id IS
  'Subject isolation key; sole ownership boundary for master state.';
COMMENT ON COLUMN subject_states.state IS
  'Opaque CognitiveState JSONB bytes; round-trip MUST preserve exact document.';
COMMENT ON COLUMN subject_states.updated_at IS
  'Server wall time of last successful write; maintained by trigger on UPDATE.';

-- Keep updated_at current on every UPDATE (idempotent function + trigger).
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

-- ---------------------------------------------------------------------------
-- sync_audit — append-only SYNC-06 reconciliation evidence
-- Ownership: cloud orchestrator sync audit writer (future P1 repository).
-- Isolation: every row is scoped by subject_id (+ device_id for fleet views).
-- Sovereignty: advisories are typed codes + metadata only — never raw learner
--   utterance or CognitiveState payloads. Application emitters MUST NOT put
--   plaintext content into advisories JSONB.
-- Append-only invariant: application code MUST NOT UPDATE or DELETE rows.
--   Replayed sync_attempt_id is rejected by UNIQUE (idempotent retry = no
--   double row). Operator purge (retention) is an out-of-band job, not an
--   app path.
-- Retention: retain ≥ 90 days for operator triage and Playground inspector.
--   Older rows may be archived/purged by a scheduled retention job keyed on
--   created_at; the application never truncates this table on the hot path.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_audit (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subject_id        TEXT NOT NULL,
    device_id         TEXT NOT NULL,
    sync_attempt_id   UUID NOT NULL,
    protocol_version  TEXT NOT NULL,
    advisories        JSONB NOT NULL DEFAULT '[]',
    state_vector_before JSONB NOT NULL DEFAULT '{}'::jsonb,
    state_vector_after  JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (sync_attempt_id)
);

-- Stage 0 → P1 hardening for databases that already created sync_audit with
-- received_at and without protocol_version. No-ops on fresh installs.
ALTER TABLE sync_audit
  ADD COLUMN IF NOT EXISTS protocol_version TEXT;

ALTER TABLE sync_audit
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

ALTER TABLE sync_audit
  ADD COLUMN IF NOT EXISTS state_vector_before JSONB;

ALTER TABLE sync_audit
  ADD COLUMN IF NOT EXISTS state_vector_after JSONB;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sync_audit'
      AND column_name = 'received_at'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sync_audit'
      AND column_name = 'created_at'
  ) THEN
    ALTER TABLE sync_audit RENAME COLUMN received_at TO created_at;
  ELSIF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sync_audit'
      AND column_name = 'received_at'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sync_audit'
      AND column_name = 'created_at'
  ) THEN
    -- Both present after a partial harden: fold timestamps, drop legacy name.
    EXECUTE $sql$
      UPDATE sync_audit
      SET created_at = COALESCE(created_at, received_at, now())
    $sql$;
    ALTER TABLE sync_audit DROP COLUMN received_at;
  END IF;
END $$;

-- Fill NOT NULL contracts for any row created under Stage 0 defaults.
UPDATE sync_audit
SET protocol_version = COALESCE(protocol_version, '1.0.0')
WHERE protocol_version IS NULL;

UPDATE sync_audit
SET created_at = COALESCE(created_at, now())
WHERE created_at IS NULL;

UPDATE sync_audit
SET state_vector_before = COALESCE(state_vector_before, '{}'::jsonb)
WHERE state_vector_before IS NULL;

UPDATE sync_audit
SET state_vector_after = COALESCE(state_vector_after, '{}'::jsonb)
WHERE state_vector_after IS NULL;

ALTER TABLE sync_audit
  ALTER COLUMN protocol_version SET DEFAULT '1.0.0';

ALTER TABLE sync_audit
  ALTER COLUMN protocol_version SET NOT NULL;

ALTER TABLE sync_audit
  ALTER COLUMN created_at SET DEFAULT now();

ALTER TABLE sync_audit
  ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE sync_audit
  ALTER COLUMN state_vector_before SET DEFAULT '{}'::jsonb;

ALTER TABLE sync_audit
  ALTER COLUMN state_vector_before SET NOT NULL;

ALTER TABLE sync_audit
  ALTER COLUMN state_vector_after SET DEFAULT '{}'::jsonb;

ALTER TABLE sync_audit
  ALTER COLUMN state_vector_after SET NOT NULL;

COMMENT ON TABLE sync_audit IS
  'Append-only sync reconciliation audit (SYNC-06); ≥90d retention; no app UPDATE/DELETE.';
COMMENT ON COLUMN sync_audit.subject_id IS
  'Subject isolation key; all audit queries MUST filter on subject_id.';
COMMENT ON COLUMN sync_audit.device_id IS
  'Device that initiated the attempt; used for advisory-storm fleet views.';
COMMENT ON COLUMN sync_audit.protocol_version IS
  'Wire PROTOCOL_VERSION observed on the reconciliation request.';
COMMENT ON COLUMN sync_audit.advisories IS
  'Typed SyncAdvisory JSON array; codes only — never raw learner content.';
COMMENT ON COLUMN sync_audit.state_vector_before IS
  'State vector snapshot before merge (summary only — no CognitiveState body).';
COMMENT ON COLUMN sync_audit.state_vector_after IS
  'State vector snapshot after merge (summary only — no CognitiveState body).';
COMMENT ON COLUMN sync_audit.created_at IS
  'Server ingest time for the audit row (renamed from Stage 0 received_at).';

-- Operator / Playground history is subject-scoped and time-ordered; bound scans.
CREATE INDEX IF NOT EXISTS idx_sync_audit_subject_created
  ON sync_audit (subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_audit_device_created
  ON sync_audit (device_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- aggregation_batches — consent-attached behavioral metadata rollups
-- Isolation: idempotency and every lookup are keyed by (subject_id, batch_id).
-- Privacy: payload is aggregation.v1 metadata only; raw prompts, utterances,
--   keystrokes, and model output are forbidden by ingress validation.
-- Atomicity: one batch is one INSERT; conflict replay writes no partial rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aggregation_batches (
    subject_id   TEXT NOT NULL,
    batch_id     TEXT NOT NULL,
    device_id    TEXT NOT NULL,
    rollup_count INTEGER NOT NULL CHECK (rollup_count BETWEEN 0 AND 100),
    payload      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (subject_id, batch_id)
);

COMMENT ON TABLE aggregation_batches IS
  'Consent-attached aggregation.v1 metadata batches; subject-scoped and idempotent.';
COMMENT ON COLUMN aggregation_batches.subject_id IS
  'Subject isolation key; all reads and writes MUST include this value.';
COMMENT ON COLUMN aggregation_batches.payload IS
  'Validated aggregation metadata only; raw learner content is forbidden.';

CREATE INDEX IF NOT EXISTS idx_aggregation_batches_subject_created
  ON aggregation_batches (subject_id, created_at DESC, batch_id DESC);
