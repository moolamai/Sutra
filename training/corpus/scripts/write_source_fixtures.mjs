import { createHash } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "fixtures", "sources");

const und = [
  '{"docId":"doc.und.ratio.compare","text":"A ratio compares two quantities by division."}',
  '{"docId":"doc.und.ratio.equivalent","text":"Equivalent ratios represent the same comparison."}',
  "",
].join("\n");

const ret = [
  '{"docId":"doc.ret.syllabus.ratios","text":"CBSE Class 8 ratios syllabus locator for RAG only."}',
  "",
].join("\n");

writeFileSync(path.join(dir, "teacher-und-ratios.jsonl"), und, "utf8");
writeFileSync(path.join(dir, "teacher-ret-syllabus.jsonl"), ret, "utf8");

for (const f of ["teacher-und-ratios.jsonl", "teacher-ret-syllabus.jsonl"]) {
  const b = readFileSync(path.join(dir, f));
  console.log(
    f,
    `sha256:${createHash("sha256").update(b).digest("hex")}`,
    `first=${b[0]}`,
  );
}
