// memory: the on-device LocalVectorDb over a minimal in-memory
// StorageDriver. Demonstrates durable upsert, similarity search, and
// kind-aware decay (corrections never decay; episodics do).
import { LocalVectorDb } from "@moolam/sdk";
import { embed } from "../_shared/mocks.mjs";

/** In-memory StorageDriver implementing the statements LocalVectorDb issues. */
function memoryDriver() {
  const rows = new Map();
  return {
    async execute(sql, params = []) {
      if (sql.trim().startsWith("CREATE")) return;
      if (sql.includes("INSERT OR REPLACE INTO memory_records")) {
        rows.set(params[0], {
          id: params[0], subject_id: params[1], concept_id: params[2],
          text: params[3], vector: params[4], kind: params[5], created_at: params[6],
        });
      } else if (sql.startsWith("DELETE")) {
        for (const [id, r] of rows) if (r.kind === "episodic" && r.created_at < params[0]) rows.delete(id);
      }
    },
    async query(sql, params = []) {
      if (sql.includes("COUNT(*)")) {
        const n = [...rows.values()].filter((r) => r.kind === "episodic" && r.created_at < params[0]).length;
        return [{ n }];
      }
      const bySubject = [...rows.values()].filter((r) => r.subject_id === params[0]);
      return sql.includes("concept_id = ?") ? bySubject.filter((r) => r.concept_id === params[1]) : bySubject;
    },
  };
}

const hlc = (msAgo) => `${String(Date.now() - msAgo).padStart(15, "0")}:000000:demo-device`;
const db = new LocalVectorDb(memoryDriver(), { episodicHalfLifeDays: 30 });
await db.initialize();

const put = (id, text, kind, msAgo) =>
  db.upsert({ id, subjectId: "subject-3", conceptId: "math.ratios", text, vector: Float32Array.from(embed(text)), kind, createdAt: hlc(msAgo) });

await put("m1", "confused ratio with fraction notation", "correction", 90 * 86_400_000);
await put("m2", "solved ratio word problems fluently today", "episodic", 90 * 86_400_000);
await put("m3", "prefers visual explanations over symbolic ones", "preference", 1_000);

const hits = await db.search("subject-3", Float32Array.from(embed("ratio confusion")), { limit: 3 });
for (const h of hits) console.log(`${h.record.kind.padEnd(10)} score=${h.score.toFixed(3)}  ${h.record.text}`);

const correction = hits.find((h) => h.record.kind === "correction");
const episodic = hits.find((h) => h.record.kind === "episodic");
if (!correction || !episodic) throw new Error("expected both kinds retrieved");
if (episodic.score >= correction.score) throw new Error("90-day-old episodic must decay below the never-decaying correction");
console.log("decay policy  : correction retained, episodic decayed");
console.log("memory OK");
