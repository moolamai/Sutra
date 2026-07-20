/**
 * Unit coverage for threat-model STRIDE enumeration gate.
 * Run: node --test scripts/check-threat-model-stride.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OBLIGATIONS,
  REQUIRED_RESIDUAL_IDS,
  REQUIRED_THREAT_IDS,
  checkThreatModelStride,
  parseResidualRisks,
  parseStrideThreats,
  sectionBetween,
  testLinkFromCell,
} from "./check-threat-model-stride.mjs";

test("happy path: committed THREAT-MODEL STRIDE tables pass", () => {
  const result = checkThreatModelStride();
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(result.threats, REQUIRED_THREAT_IDS.length);
  assert.equal(result.residuals, REQUIRED_RESIDUAL_IDS.length);
});

test("helpers: extract test link from markdown cell", () => {
  const link = testLinkFromCell(
    "`packages/edge-agent/tests/edge_agent_turn_completed.test.mjs`",
  );
  assert.equal(link, "packages/edge-agent/tests/edge_agent_turn_completed.test.mjs");
});

test("edge: missing threat row fails MISSING_THREAT", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-stride-"));
  try {
    const stride = [
      "### Surface 1",
      "| Threat ID | Crossing | STRIDE | Threat | Mitigation | Test link | Status |",
      "|-----------|----------|--------|--------|------------|-----------|--------|",
      "| `TH-EDGE-001` | `TB-EDGE-02` | S | t | m | `packages/cognitive-core/tests/plan_stage_integration.test.mjs` | mitigated |",
    ].join("\n");
    const residual = [
      "| Risk ID | Related crossing | Status | Owner | Review date | Acceptance rationale |",
      "|---------|------------------|--------|-------|-------------|----------------------|",
      ...REQUIRED_RESIDUAL_IDS.map(
        (id) =>
          `| \`${id}\` | \`TB-X\` | accepted | owner | 2026-10-01 | acceptance rationale long enough here |`,
      ),
    ].join("\n");
    const body = [
      "## STRIDE enumeration",
      stride,
      "## Edge-case coverage",
      "x",
      "## Residual risk register",
      residual,
      "## Correlation",
    ].join("\n");
    writeFileSync(path.join(dir, "THREAT-MODEL.md"), body, "utf8");
    const result = checkThreatModelStride({
      threatModelPath: path.join(dir, "THREAT-MODEL.md"),
      repoRoot: path.resolve(dir, ".."),
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.startsWith(OBLIGATIONS.MISSING_THREAT)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: broken test link fails BROKEN_TEST_LINK", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-stride-broken-"));
  try {
    const rows = REQUIRED_THREAT_IDS.map((id, i) =>
      i === 0
        ? `| \`${id}\` | \`TB-X\` | S | t | m | \`packages/no/such/file.test.mjs\` | mitigated |`
        : `| \`${id}\` | \`TB-X\` | S | t | m | \`packages/cognitive-core/tests/plan_stage_integration.test.mjs\` | mitigated |`,
    );
    const stride = [
      "### Surface",
      "| Threat ID | Crossing | STRIDE | Threat | Mitigation | Test link | Status |",
      "|-----------|----------|--------|--------|------------|-----------|--------|",
      ...rows,
    ].join("\n");
    const residual = REQUIRED_RESIDUAL_IDS.map(
      (id) =>
        `| \`${id}\` | \`TB-X\` | accepted | owner | 2026-10-01 | acceptance rationale long enough here |`,
    ).join("\n");
    const body = [
      "## STRIDE enumeration",
      stride,
      "## Edge-case coverage",
      "## Residual risk register",
      "| Risk ID | Related crossing | Status | Owner | Review date | Acceptance rationale |",
      "|---------|------------------|--------|-------|-------------|----------------------|",
      residual,
      "## Correlation",
    ].join("\n");
    writeFileSync(path.join(dir, "THREAT-MODEL.md"), body, "utf8");
    const result = checkThreatModelStride({
      threatModelPath: path.join(dir, "THREAT-MODEL.md"),
      repoRoot: path.resolve(dir, ".."),
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) => f.startsWith(OBLIGATIONS.BROKEN_TEST_LINK)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sovereignty: incomplete residual register fails INCOMPLETE_RESIDUAL", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-stride-res-"));
  try {
    const rows = REQUIRED_THREAT_IDS.map(
      (id) =>
        `| \`${id}\` | \`TB-X\` | S | t | m | \`packages/cognitive-core/tests/plan_stage_integration.test.mjs\` | mitigated |`,
    );
    const body = [
      "## STRIDE enumeration",
      "| Threat ID | Crossing | STRIDE | Threat | Mitigation | Test link | Status |",
      ...rows,
      "## Edge-case coverage",
      "## Residual risk register",
      "| Risk ID | Related crossing | Status | Owner | Review date | Acceptance rationale |",
      "| `RR-TLS-001` | `TB-SYNC-02` | accepted | | 2026-10-01 | short |",
      "## Correlation",
    ].join("\n");
    writeFileSync(path.join(dir, "THREAT-MODEL.md"), body, "utf8");
    const result = checkThreatModelStride({
      threatModelPath: path.join(dir, "THREAT-MODEL.md"),
      repoRoot: path.resolve(dir, ".."),
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) => f.includes(OBLIGATIONS.INCOMPLETE_RESIDUAL)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseStrideThreats: reads status and link from table", () => {
  const section = `
| \`TH-EDGE-001\` | \`TB-EDGE-02\` | S | threat | mit | \`packages/edge-agent/tests/edge_agent_turn_completed.test.mjs\` | mitigated |
`;
  const map = parseStrideThreats(section);
  assert.equal(map.get("TH-EDGE-001")?.status, "mitigated");
  assert.equal(
    map.get("TH-EDGE-001")?.testLink,
    "packages/edge-agent/tests/edge_agent_turn_completed.test.mjs",
  );
});

test("sectionBetween: extracts markdown blocks", () => {
  const body = "## STRIDE enumeration\nfoo\n## Edge-case coverage\nbar";
  assert.equal(sectionBetween(body, "## STRIDE enumeration", "## Edge-case coverage").trim(), "foo");
});
