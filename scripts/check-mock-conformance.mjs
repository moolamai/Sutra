/**
 * Contract-mocks CI gate .
 *
 * Runs the full obligation suite against every `@moolam/contract-mocks`
 * harness factory. Any failing obligation blocks merge (exit 1) and the
 * human report always names obligation ID + MUST text.
 *
 * Usage (repo root):
 *   node scripts/check-mock-conformance.mjs
 *   pnpm mocks:conformance
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/** Max suites / events inspected when summarizing failures (NFR). */
export const MOCK_GATE_SUITE_LIMIT = 32;

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "mock.conformance.gate", ...event })}\n`,
  );
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    shell: opts.shell ?? true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    combined: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function forward(label, result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  emit({
    outcome: result.status === 0 ? "ok" : "fail",
    phase: label,
    exitCode: result.status,
  });
}

export function ensureMockConformanceBuilt() {
  const mocksDist = path.join(REPO_ROOT, "packages/contract-mocks/dist/index.js");
  const confDist = path.join(
    REPO_ROOT,
    "packages/contract-conformance/dist/index.js",
  );
  if (
    existsSync(mocksDist) &&
    existsSync(confDist) &&
    process.env.CI !== "true" &&
    process.env.MOCK_CONFORMANCE_FORCE_BUILD !== "1"
  ) {
    emit({ outcome: "ok", phase: "build.skip", reason: "dist-present" });
    return;
  }
  const result = run("pnpm", [
    "exec",
    "turbo",
    "run",
    "build",
    "--filter=@moolam/contract-conformance",
    "--filter=@moolam/contract-mocks",
  ]);
  forward("build", result);
  if (result.status !== 0 || !existsSync(mocksDist) || !existsSync(confDist)) {
    throw new Error(
      `MOCK_CONFORMANCE_GATE_BUILD_FAILED:status=${result.status}\n${result.combined.slice(0, 4000)}`,
    );
  }
}

export function runContractMocksPackageTests() {
  return run("pnpm", ["--filter", "@moolam/contract-mocks", "test"]);
}

/**
 * Full obligation matrix: every contract-mocks harness × its registry.
 * Failures print human reports with obligation IDs (never silent red).
 */
export async function runMockConformanceSuite(options = {}) {
  const confHref = pathToFileURL(
    path.join(REPO_ROOT, "packages/contract-conformance/dist/index.js"),
  ).href;
  const mocksHref = pathToFileURL(
    path.join(REPO_ROOT, "packages/contract-mocks/dist/index.js"),
  ).href;

  const conf = await import(confHref);
  const mocks = await import(mocksHref);

  const suites = (
    options.suites && options.suites.length > 0
      ? options.suites
      : [
          {
            name: "memory",
            registry: conf.createMemoryObligationsRegistry,
            factory: mocks.createMemoryMockHarnessFactory,
          },
          {
            name: "model",
            registry: conf.createModelObligationsRegistry,
            factory: mocks.createModelMockHarnessFactory,
          },
          {
            name: "reasoning",
            registry: conf.createReasoningObligationsRegistry,
            factory: mocks.createReasoningMockHarnessFactory,
          },
          {
            name: "knowledge",
            registry: conf.createKnowledgeObligationsRegistry,
            factory: mocks.createKnowledgeMockHarnessFactory,
          },
          {
            name: "tool",
            registry: conf.createToolObligationsRegistry,
            factory: mocks.createToolMockHarnessFactory,
          },
          {
            name: "planning",
            registry: conf.createPlanningObligationsRegistry,
            factory: mocks.createPlanningMockHarnessFactory,
          },
          {
            name: "speech",
            registry: conf.createSpeechObligationsRegistry,
            factory: mocks.createSpeechMockHarnessFactory,
          },
          {
            name: "vision",
            registry: conf.createVisionObligationsRegistry,
            factory: mocks.createVisionMockHarnessFactory,
          },
          {
            name: "runtime",
            registry: conf.createRuntimeObligationsRegistry,
            factory: mocks.createRuntimeMockHarnessFactory,
          },
        ]
  ).slice(0, MOCK_GATE_SUITE_LIMIT);

  const subjectId = options.subjectId ?? "subj-mock-conformance-ci";
  const deviceId = options.deviceId ?? "dev-mock-conformance-ci";
  const events = [];
  let combined = "";
  let failed = 0;
  let passedSuites = 0;

  for (const suite of suites) {
    const report = await conf.runConformance({
      registry: suite.registry(),
      factory: suite.factory(),
      subjectId: `${subjectId}.${suite.name}`,
      deviceId,
      emit: (e) => {
        events.push(e);
        options.emit?.(e);
      },
    });
    const human = conf.formatHumanReport(report);
    combined += `\n=== mock suite: ${suite.name} ===\n${human}\n`;
    process.stdout.write(`\n=== mock suite: ${suite.name} ===\n`);
    process.stdout.write(human);
    if (!human.endsWith("\n")) process.stdout.write("\n");

    emit({
      outcome: report.exitCode === 0 ? "ok" : "fail",
      phase: `suite.${suite.name}`,
      exitCode: report.exitCode,
      passed: report.passed,
      failed: report.failed,
      subjectId: `${subjectId}.${suite.name}`,
      deviceId,
    });

    if (report.exitCode !== 0) {
      failed += 1;
      const failing = report.verdicts
        .filter((v) => v.outcome !== "pass")
        .slice(0, MOCK_GATE_SUITE_LIMIT);
      for (const v of failing) {
        process.stderr.write(
          `mock.conformance.gate VIOLATION suite=${suite.name} obligationId=${v.obligationId} must=${JSON.stringify(v.mustText)} message=${JSON.stringify(v.message ?? "")}\n`,
        );
      }
    } else {
      passedSuites += 1;
    }
  }

  if (failed > 0 && !/CK-\d+|RT-\d+/i.test(combined)) {
    process.stderr.write(
      "mock.conformance.gate: failure without obligation-id tokens in log — see suite reports above\n",
    );
  }

  return {
    status: failed > 0 ? 1 : 0,
    combined,
    passedSuites,
    failedSuites: failed,
    suiteCount: suites.length,
    events,
  };
}

/**
 * Full gate: build → package tests → full obligation matrix against mocks.
 */
export async function runMockConformanceGate() {
  ensureMockConformanceBuilt();

  const unit = runContractMocksPackageTests();
  forward("unit.contract-mocks", unit);
  if (unit.status !== 0) {
    return { status: unit.status, combined: unit.combined };
  }

  const suite = await runMockConformanceSuite();
  emit({
    outcome: suite.status === 0 ? "ok" : "fail",
    phase: "suite.full",
    exitCode: suite.status,
    passedSuites: suite.passedSuites,
    failedSuites: suite.failedSuites,
  });
  return suite;
}

async function main() {
  try {
    const result = await runMockConformanceGate();
    process.exitCode = result.status === 0 ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
