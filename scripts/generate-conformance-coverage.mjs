/**
 * Compile conformance coverage report for the Protocol 1.0 freeze RFC appendix.
 *
 * Runs every published obligation registry against its known-good reference
 * harness, maps obligation IDs → pass/fail, and writes:
 *   - rfcs/appendix/conformance-coverage.json
 *   - rfcs/appendix/conformance-coverage.md
 *
 * Coverage = passed ÷ declared × 100 (evidence-link / obligation coverage).
 * Replay is idempotent: same catalog + known-good factories → same verdicts.
 *
 * Usage (repo root):
 *   node scripts/generate-conformance-coverage.mjs
 *   pnpm conformance:coverage
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const APPENDIX_DIR = path.join(REPO_ROOT, "rfcs", "appendix");
export const REPORT_JSON = path.join(APPENDIX_DIR, "conformance-coverage.json");
export const REPORT_MD = path.join(APPENDIX_DIR, "conformance-coverage.md");

const DIST = path.join(
  REPO_ROOT,
  "packages",
  "contract-conformance",
  "dist",
  "index.js",
);

export const DEFAULT_SUBJECT_ID = "ci-freeze-coverage";
export const DEFAULT_DEVICE_ID = "ci";

/**
 * Published suite catalog — one row per public interface registry.
 * `suite` is the B-track executable evidence file.
 */
export function suiteCatalog(cc) {
  const wireBundle = cc.loadWireFixtureBundle();
  return [
    {
      contract: "SyncRequest (wire shape)",
      suite: "packages/contract-conformance/tests/wire_shape.test.mjs",
      createRegistry: () => cc.createWireShapeRegistry(wireBundle),
      factory: () => cc.validSyncRequestProducer(wireBundle),
    },
    {
      contract: "MemoryInterface",
      suite: "packages/contract-conformance/tests/memory_obligations.test.mjs",
      createRegistry: () => cc.createMemoryObligationsRegistry(),
      factory: cc.createDurableMemoryHarnessFactory(),
    },
    {
      contract: "ModelInterface",
      suite: "packages/contract-conformance/tests/model_obligations.test.mjs",
      createRegistry: () => cc.createModelObligationsRegistry(),
      factory: cc.createStableModelHarnessFactory(),
    },
    {
      contract: "ModelInterface locality policy",
      suite: "packages/contract-conformance/tests/locality_policy.test.mjs",
      createRegistry: () => cc.createLocalityPolicyObligationsRegistry(),
      factory: cc.createCompliantLocalityHarnessFactory(),
    },
    {
      contract: "ReasoningInterface",
      suite: "packages/contract-conformance/tests/reasoning_obligations.test.mjs",
      createRegistry: () => cc.createReasoningObligationsRegistry(),
      factory: cc.createTracedReasoningHarnessFactory(),
    },
    {
      contract: "SpeechInterface",
      suite: "packages/contract-conformance/tests/speech_obligations.test.mjs",
      createRegistry: () => cc.createSpeechObligationsRegistry(),
      factory: cc.createStreamingSpeechHarnessFactory(),
    },
    {
      contract: "VisionInterface",
      suite: "packages/contract-conformance/tests/vision_obligations.test.mjs",
      createRegistry: () => cc.createVisionObligationsRegistry(),
      factory: cc.createStrictVisionHarnessFactory(),
    },
    {
      contract: "ToolInterface",
      suite: "packages/contract-conformance/tests/tool_obligations.test.mjs",
      createRegistry: () => cc.createToolObligationsRegistry(),
      factory: cc.createWriteAheadToolHarnessFactory(),
    },
    {
      contract: "PlanningInterface",
      suite: "packages/contract-conformance/tests/planning_obligations.test.mjs",
      createRegistry: () => cc.createPlanningObligationsRegistry(),
      factory: cc.createCyclicPlanningHarnessFactory(),
    },
    {
      contract: "KnowledgeConnectorInterface",
      suite: "packages/contract-conformance/tests/knowledge_obligations.test.mjs",
      createRegistry: () => cc.createKnowledgeObligationsRegistry(),
      factory: cc.createCitedKnowledgeHarnessFactory(),
    },
    {
      contract: "CAST cold-start",
      suite: "packages/contract-conformance/tests/cast_obligations.test.mjs",
      createRegistry: () => cc.createCastObligationsRegistry(),
      factory: cc.createCompliantCastHarnessFactory(),
    },
    {
      contract: "Runtime lifecycle",
      suite: "packages/contract-conformance/tests/runtime_obligations.test.mjs",
      createRegistry: () => cc.createRuntimeObligationsRegistry(),
      factory: cc.createReferenceRuntimeHarnessFactory(),
    },
    {
      contract: "Refusal composition (CK-10)",
      suite: "packages/contract-conformance/tests/refusal_decline.test.mjs",
      createRegistry: () => cc.createRefusalObligationsRegistry(),
      factory: cc.createCompliantRefusalHarnessFactory(),
    },
  ];
}

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "conformance.coverage", ...event })}\n`,
  );
}

function pct(passed, declared) {
  if (declared <= 0) return 0;
  return Math.round((passed / declared) * 10000) / 100;
}

/**
 * @param {{
 *   subjectId?: string,
 *   deviceId?: string,
 *   cc?: object,
 *   generatedAt?: string,
 * }} [opts]
 */
export async function compileConformanceCoverage(opts = {}) {
  const subjectId = (opts.subjectId ?? DEFAULT_SUBJECT_ID).trim();
  if (!subjectId) {
    throw new Error("subjectId is required (subject isolation)");
  }
  const deviceId = opts.deviceId ?? DEFAULT_DEVICE_ID;
  if (!existsSync(DIST) && !opts.cc) {
    throw new Error(
      `conformance dist missing: build @moolam/contract-conformance first (${DIST})`,
    );
  }
  const cc = opts.cc ?? (await import(`file://${DIST.replace(/\\/g, "/")}`));
  const suites = suiteCatalog(cc);
  /** @type {object[]} */
  const interfaces = [];
  /** @type {string[]} */
  const events = [];

  for (let i = 0; i < suites.length; i++) {
    const suite = suites[i];
    const suiteSubject = `${subjectId}::${i}`;
    const registry = suite.createRegistry();
    const report = await cc.runConformance({
      registry,
      factory: suite.factory,
      subjectId: suiteSubject,
      deviceId,
      emit: (e) => {
        events.push(e);
        if (e.event === "conformance.runner") {
          emit({
            outcome: e.outcome,
            obligationId: e.obligationId,
            subjectId: e.subjectId,
            deviceId: e.deviceId ?? deviceId,
            contract: suite.contract,
          });
        }
      },
    });

    const declared = report.verdicts.length;
    const passed = report.verdicts.filter((v) => v.outcome === "pass").length;
    const failed = declared - passed;
    interfaces.push({
      contract: suite.contract,
      suite: suite.suite,
      declared,
      passed,
      failed,
      coveragePercent: pct(passed, declared),
      obligations: report.verdicts.map((v) => ({
        id: v.obligationId,
        outcome: v.outcome,
        contract: v.contract,
        mustText: v.mustText,
        durationMs: v.durationMs,
        ...(v.message ? { message: v.message } : {}),
      })),
    });
  }

  const declared = interfaces.reduce((n, row) => n + row.declared, 0);
  const passed = interfaces.reduce((n, row) => n + row.passed, 0);
  const failed = interfaces.reduce((n, row) => n + row.failed, 0);
  const report = {
    kind: "conformance-coverage-report",
    reportVersion: "1.0.0",
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    subjectId,
    deviceId,
    summary: {
      interfaces: interfaces.length,
      declared,
      passed,
      failed,
      coveragePercent: pct(passed, declared),
      exitCode: failed === 0 ? 0 : 1,
    },
    interfaces,
    notes: {
      method:
        "covered published obligations ÷ declared published obligations × 100",
      sovereignty:
        "Every suite run is scoped by subjectId; report never includes raw learner content",
      fieldPilotBlocker:
        "FP-002 (Indic STT classroom noise) Closed — hi-classroom-noise fixture + fp002_classroom_noise.test.mjs",
      bTrackSuite:
        "suite column links B-track obligation test modules under packages/contract-conformance/tests/",
    },
  };

  return { report, events };
}

/**
 * @param {object} report
 */
export function formatCoverageMarkdown(report) {
  const lines = [
    "# Conformance coverage report — Protocol 1.0 freeze appendix",
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Kind** | \`${report.kind}\` |`,
    `| **Report version** | \`${report.reportVersion}\` |`,
    `| **Generated at** | ${report.generatedAt} |`,
    `| **subjectId** | \`${report.subjectId}\` |`,
    `| **deviceId** | \`${report.deviceId}\` |`,
    `| **Declared obligations** | ${report.summary.declared} |`,
    `| **Passed** | ${report.summary.passed} |`,
    `| **Failed** | ${report.summary.failed} |`,
    `| **Coverage** | **${report.summary.coveragePercent}%** |`,
    `| **Exit code** | ${report.summary.exitCode} |`,
    "",
    "> Generated by `pnpm conformance:coverage`. Obligation IDs map to pass/fail",
    "> from known-good reference harnesses. Suite paths are B-track executable",
    "> evidence. Metadata only — never raw learner content.",
    "",
    "## Per-interface summary",
    "",
    "| Public interface | Declared | Passed | Failed | Coverage | B-track suite |",
    "|------------------|--------:|-------:|-------:|---------:|---------------|",
  ];

  for (const row of report.interfaces) {
    lines.push(
      `| ${row.contract} | ${row.declared} | ${row.passed} | ${row.failed} | **${row.coveragePercent}%** | \`${row.suite}\` |`,
    );
  }

  lines.push(
    "",
    "## Obligation verdicts",
    "",
    "| Obligation ID | Contract | Outcome | Interface |",
    "|---------------|----------|---------|-----------|",
  );

  for (const row of report.interfaces) {
    for (const obl of row.obligations) {
      lines.push(
        `| \`${obl.id}\` | ${obl.contract} | **${obl.outcome}** | ${row.contract} |`,
      );
    }
  }

  lines.push(
    "",
    "## Notes",
    "",
    `- Method: ${report.notes.method}`,
    `- Sovereignty: ${report.notes.sovereignty}`,
    `- Field-pilot: ${report.notes.fieldPilotBlocker}`,
    `- B-track: ${report.notes.bTrackSuite}`,
    "",
    "Parent RFC: [`rfcs/0001-protocol-1.0-freeze.md`](../0001-protocol-1.0-freeze.md)",
    "",
  );

  return `${lines.join("\n")}`;
}

/**
 * @param {{ report: object, jsonPath?: string, mdPath?: string }} args
 */
export function writeCoverageArtifacts(args) {
  const jsonPath = args.jsonPath ?? REPORT_JSON;
  const mdPath = args.mdPath ?? REPORT_MD;
  mkdirSync(path.dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(args.report, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, formatCoverageMarkdown(args.report), "utf8");
  return { jsonPath, mdPath };
}

async function main() {
  const { report } = await compileConformanceCoverage();
  const { jsonPath, mdPath } = writeCoverageArtifacts({ report });
  emit({
    outcome: report.summary.exitCode === 0 ? "ok" : "fail",
    subjectId: report.subjectId,
    deviceId: report.deviceId,
    declared: report.summary.declared,
    passed: report.summary.passed,
    failed: report.summary.failed,
    coveragePercent: report.summary.coveragePercent,
    interfaces: report.summary.interfaces,
    jsonPath: path.relative(REPO_ROOT, jsonPath).replace(/\\/g, "/"),
    mdPath: path.relative(REPO_ROOT, mdPath).replace(/\\/g, "/"),
  });
  if (report.summary.exitCode !== 0) {
    process.stderr.write(
      `conformance coverage failed: ${report.summary.failed} obligation(s) not pass\n`,
    );
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    process.stderr.write(
      `${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
