// Memory retrieval latency: LocalVectorDb brute-force cosine search over
// realistic on-device corpus sizes (the store's documented sweet spot is
// below ~50k vectors).
import { LocalVectorDb } from "sutra-sdk";
import { bench } from "./_shared/bench.mjs";

function memoryDriver() {
  const rows = new Map();
  return {
    async execute(sql, params = []) {
      if (sql.includes("INSERT OR REPLACE INTO memory_records")) {
        rows.set(params[0], {
          id: params[0], subject_id: params[1], concept_id: params[2],
          text: params[3], vector: params[4], kind: params[5], created_at: params[6],
        });
      }
    },
    async query(sql, params = []) {
      if (sql.includes("COUNT(*)")) return [{ n: 0 }];
      return [...rows.values()].filter((r) => r.subject_id === params[0]);
    },
  };
}

const DIM = 384;
function randomVector(seed) {
  const v = new Float32Array(DIM);
  let x = seed + 1;
  for (let i = 0; i < DIM; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v[i] = x / 2147483648 - 0.5;
  }
  return v;
}

for (const corpus of [1000, 5000, 20000]) {
  const db = new LocalVectorDb(memoryDriver());
  await db.initialize();
  for (let i = 0; i < corpus; i++) {
    await db.upsert({
      id: `m${i}`,
      subjectId: "bench-subject",
      conceptId: `concept.${i % 40}`,
      text: `memory ${i}`,
      vector: randomVector(i),
      kind: i % 10 === 0 ? "correction" : "episodic",
      createdAt: `${String(1_700_000_000_000 + i).padStart(15, "0")}:000000:bench-device`,
    });
  }
  const query = randomVector(999_999);
  await bench(`search top-8 of ${corpus} vectors (dim ${DIM})`, () => db.search("bench-subject", query, { limit: 8 }), {
    warmup: 5,
    iterations: 50,
  });
}
