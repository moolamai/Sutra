/**
 * File-backed, subject-scoped durable store — independent of Sutra monorepo
 * storage packages. Survives process restart via JSONL under dataDir.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const EPISODIC_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

function parseCreatedAtMs(createdAt) {
  const iso = Date.parse(createdAt);
  if (!Number.isNaN(iso)) return iso;
  const physical = Number(String(createdAt).slice(0, 15));
  if (!Number.isFinite(physical)) return Date.now();
  return physical;
}

function kindAwareDecayFactor(kind, createdAt, nowMs) {
  if (kind !== "episodic") return 1;
  const age = Math.max(0, nowMs - parseCreatedAtMs(createdAt));
  if (age === 0) return 1;
  return Math.exp((-Math.LN2 * age) / EPISODIC_HALF_LIFE_MS);
}

/**
 * @param {string} dataDir
 */
export function createFileBackedMemoryBackend(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const journalPath = path.join(dataDir, "memory.jsonl");
  /** @type {Map<string, object>} */
  const rows = new Map();
  let seq = 0;
  let nowMs = Date.now();

  function load() {
    rows.clear();
    seq = 0;
    if (!existsSync(journalPath)) return;
    const text = readFileSync(journalPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.op === "put") {
        rows.set(row.item.id, row.item);
        const n = Number(String(row.item.id).replace(/^mem-/, ""));
        if (Number.isFinite(n)) seq = Math.max(seq, n);
      } else if (row.op === "del") {
        rows.delete(row.id);
      }
    }
  }

  function persistPut(item) {
    appendFileSync(journalPath, `${JSON.stringify({ op: "put", item })}\n`, "utf8");
  }

  function persistDel(id) {
    appendFileSync(journalPath, `${JSON.stringify({ op: "del", id })}\n`, "utf8");
  }

  load();

  function openHandle() {
    return {
      async remember(item) {
        const id = `mem-${++seq}`;
        const row = { ...item, id };
        rows.set(id, row);
        persistPut(row); // durable before resolve
        return row;
      },
      async recall(query) {
        const limit = query.limit ?? 16;
        const hits = [];
        for (const item of rows.values()) {
          if (item.subjectId !== query.subjectId) continue;
          if (query.topicId !== undefined && item.topicId !== query.topicId) {
            continue;
          }
          hits.push({
            item,
            score: kindAwareDecayFactor(item.kind, item.createdAt, nowMs),
          });
        }
        hits.sort(
          (a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id),
        );
        return hits.slice(0, limit);
      },
      async associate() {},
      async forget(id) {
        rows.delete(id);
        persistDel(id);
      },
      async compact() {
        return 0;
      },
    };
  }

  return {
    open: openHandle,
    /** Simulate docker/process restart: reload durable journal. */
    restart() {
      load();
      return openHandle();
    },
    nowMs: () => nowMs,
    setNowMs: (ms) => {
      nowMs = ms;
    },
    /** Bounded sync attempt ledger for idempotent replay probes. */
    syncLedger: createSyncLedger(path.join(dataDir, "sync-attempts.json")),
  };
}

function createSyncLedger(filePath) {
  /** @type {Set<string>} */
  let applied = new Set();
  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      if (Array.isArray(raw.applied)) applied = new Set(raw.applied);
    } catch {
      applied = new Set();
    }
  }

  function flush() {
    const tmp = `${filePath}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ applied: [...applied].slice(-256) }, null, 2)}\n`,
      "utf8",
    );
    renameSync(tmp, filePath);
  }

  return {
    /**
     * Apply once per syncAttemptId. Replay returns { applied: false }.
     * @param {string} syncAttemptId
     * @param {() => void} effect
     */
    applyOnce(syncAttemptId, effect) {
      if (!syncAttemptId || typeof syncAttemptId !== "string") {
        throw new Error("syncAttemptId required");
      }
      if (applied.has(syncAttemptId)) {
        return { applied: false, duplicate: true };
      }
      effect();
      applied.add(syncAttemptId);
      flush();
      return { applied: true, duplicate: false };
    },
    has(syncAttemptId) {
      return applied.has(syncAttemptId);
    },
    reload() {
      if (!existsSync(filePath)) {
        applied = new Set();
        return;
      }
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      applied = new Set(Array.isArray(raw.applied) ? raw.applied : []);
    },
  };
}
