/**
 * Unit coverage for the Protocol 1.0 freeze RFC draft gate.
 * Run: node --test scripts/check-freeze-rfc.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  REQUIRED_WIRE_INTERFACES,
  RFC_PATH,
  checkFreezeRfc,
  parseWireCoverage,
} from "./check-freeze-rfc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CI = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const ROOT_PKG = path.join(REPO_ROOT, "package.json");
const ROOT_README = path.join(REPO_ROOT, "README.md");
const SYNC_README = path.join(
  REPO_ROOT,
  "packages",
  "sync-protocol",
  "README.md",
);

test("happy path: committed freeze RFC draft passes", () => {
  const result = checkFreezeRfc();
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(result.interfaces, REQUIRED_WIRE_INTERFACES.length);
  assert.equal(result.status?.startsWith("Accepted"), true);
});

test("coverage table lists every public wire interface at a valid percentage", () => {
  const rows = parseWireCoverage(readFileSync(RFC_PATH, "utf8"));
  for (const required of REQUIRED_WIRE_INTERFACES) {
    const row = rows.find((r) => r.name.includes(required));
    assert.ok(row, required);
    assert.equal(
      row.percentage,
      (row.covered / row.declared) * 100,
      required,
    );
  }
});

test("edge: dropped wire interface fails MISSING_INTERFACE", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-freeze-rfc-"));
  const file = path.join(dir, "rfc.md");
  try {
    const body = readFileSync(RFC_PATH, "utf8").replace(
      "| Tool-call envelope (shape, normalization, error vocabulary, repair/stream parsing) | 5 | 5 | **100%** |",
      "| Removed tool interface | 5 | 5 | **100%** |",
    );
    writeFileSync(file, body, "utf8");
    const result = checkFreezeRfc({ rfcPath: file });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.includes(
        `${OBLIGATIONS.MISSING_INTERFACE}:Tool-call envelope`,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: incorrect coverage arithmetic fails INVALID_COVERAGE", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-freeze-cov-"));
  const file = path.join(dir, "rfc.md");
  try {
    const body = readFileSync(RFC_PATH, "utf8").replace(
      "| Metering event contract (shape, parity, bounded budgets, metadata-only) | 4 | 4 | **100%** |",
      "| Metering event contract (shape, parity, bounded budgets, metadata-only) | 4 | 3 | **100%** |",
    );
    writeFileSync(file, body, "utf8");
    const result = checkFreezeRfc({ rfcPath: file });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) =>
        f.startsWith(
          `${OBLIGATIONS.INVALID_COVERAGE}:Metering event contract`,
        ),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: Accepted status with pending sign-off and blocker fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-freeze-accept-"));
  const file = path.join(dir, "rfc.md");
  try {
    const body = readFileSync(RFC_PATH, "utf8")
      .replace(
        "| **Maintainer acceptance** | Track A Lead <track-a@moolam.ai> 2026-07-17; Protocol Owner <protocol@moolam.ai> 2026-07-17 |",
        "| **Maintainer acceptance** | pending maintainer sign-off |",
      )
      .replace(
        "| `FP-002` Indic STT classroom-noise fixture | P1 | **Closed** | Speech binding owner | 2026-07-17 | `hi-classroom-noise` + `packages/bindings-speech/tests/fp002_classroom_noise.test.mjs` |",
        "| `FP-NEW` example blocker | P0 | **Blocks acceptance** | Platform | 2026-12-31 | Must close before release |",
      );
    writeFileSync(file, body, "utf8");
    const result = checkFreezeRfc({ rfcPath: file });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.MISSING_SIGNOFF));
    assert.ok(result.failures.includes(OBLIGATIONS.ACCEPTED_WITH_BLOCKER));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sovereignty: dropping subject scope and no-content posture fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-freeze-sov-"));
  const file = path.join(dir, "rfc.md");
  try {
    const body = readFileSync(RFC_PATH, "utf8")
      .replaceAll("subjectId", "scope-key")
      .replaceAll("deviceId", "device-key")
      .replace(
        "never raw learner utterances or prompt content",
        "contains full payloads",
      );
    writeFileSync(file, body, "utf8");
    const result = checkFreezeRfc({ rfcPath: file });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.SOVEREIGNTY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CI, package scripts, and public READMEs surface the RFC gate", () => {
  const ci = readFileSync(CI, "utf8");
  assert.match(ci, /pnpm freeze-rfc:check/);
  assert.match(ci, /check-freeze-rfc\.test\.mjs/);

  const pkg = JSON.parse(readFileSync(ROOT_PKG, "utf8"));
  assert.equal(
    pkg.scripts["freeze-rfc:check"],
    "node scripts/check-freeze-rfc.mjs",
  );

  assert.match(readFileSync(ROOT_README, "utf8"), /0001-protocol-1\.0-freeze/);
  assert.match(readFileSync(SYNC_README, "utf8"), /0001-protocol-1\.0-freeze/);
});
