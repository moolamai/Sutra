/**
 * Sync A P6 golden-turn fixture bytes into this package.
 *
 * Copies committed JSON from `@moolam/sync-protocol/fixtures/golden-turns`.
 * Prints a unified-style summary of drift. Never auto-commits — human review
 * required before git add.
 *
 * Usage:
 *   node scripts/sync-a-p6-golden-turns.mjs           # copy upstream → local
 *   node scripts/sync-a-p6-golden-turns.mjs --check   # exit 1 on drift / missing
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const DEST = join(PKG, "fixtures", "golden-turns");
const SRC = join(PKG, "..", "sync-protocol", "fixtures", "golden-turns");

const checkOnly = process.argv.includes("--check");

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

if (!existsSync(SRC)) {
  die(`A P6 golden fixture source missing: ${SRC}`);
}

mkdirSync(DEST, { recursive: true });

const srcFiles = readdirSync(SRC)
  .filter((f) => f.endsWith(".json"))
  .sort();
const destFiles = existsSync(DEST)
  ? readdirSync(DEST).filter((f) => f.endsWith(".json")).sort()
  : [];

let drift = 0;
const report = [];

for (const file of srcFiles) {
  const srcPath = join(SRC, file);
  const destPath = join(DEST, file);
  const srcBytes = readFileSync(srcPath);
  const srcText = srcBytes.toString("utf8").replace(/\r\n/g, "\n");
  if (!existsSync(destPath)) {
    drift += 1;
    report.push(`MISSING_LOCAL ${file}`);
    if (!checkOnly) {
      writeFileSync(destPath, srcText, "utf8");
      report.push(`  → copied`);
    }
    continue;
  }
  const destText = readFileSync(destPath, "utf8").replace(/\r\n/g, "\n");
  if (destText !== srcText) {
    drift += 1;
    report.push(`DRIFT ${file} (local differs from A P6)`);
    if (!checkOnly) {
      writeFileSync(destPath, srcText, "utf8");
      report.push(`  → overwritten from A P6 (review before commit)`);
    }
  } else {
    report.push(`OK ${file}`);
  }
}

for (const file of destFiles) {
  if (!srcFiles.includes(file)) {
    drift += 1;
    report.push(`EXTRA_LOCAL ${file} (not in A P6 corpus)`);
  }
}

// Origin stamp for operators (not a golden turn file).
const originPath = join(DEST, "A-P6-ORIGIN.txt");
const originBody =
  "Source: packages/sync-protocol/fixtures/golden-turns\n" +
  "Sync: pnpm --filter @moolam/runtime-harness golden:sync\n" +
  "Do not hand-edit expectedFrames. Human review required before commit.\n";
if (!checkOnly) {
  writeFileSync(originPath, originBody, "utf8");
} else if (
  !existsSync(originPath) ||
  readFileSync(originPath, "utf8").replace(/\r\n/g, "\n") !== originBody
) {
  drift += 1;
  report.push("DRIFT A-P6-ORIGIN.txt");
}

process.stdout.write(report.join("\n") + "\n");
process.stdout.write(
  checkOnly
    ? `check: drift=${drift} src=${srcFiles.length} dest=${destFiles.length}\n`
    : `sync: drift=${drift} copied_or_ok=${srcFiles.length} (never auto-commits)\n`,
);

if (checkOnly && drift > 0) {
  die(
    "A P6 golden fixtures out of sync with runtime-harness. " +
      "Run: pnpm --filter @moolam/runtime-harness golden:sync",
  );
}
