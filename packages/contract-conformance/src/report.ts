/**
 * Machine-readable + human conformance reports .
 *
 * Human table shows obligation ID + MUST text on failure.
 * JSON mode is stable for CI / implementor tooling.
 */

export type VerdictOutcome = "pass" | "fail" | "error" | "timeout";

/** Who owns the failure — setup/check/teardown fault vs harness bug. */
export type FailureAttribution = "implementation" | "harness";

export interface ObligationVerdict {
  obligationId: string;
  contract: string;
  mustText: string;
  outcome: VerdictOutcome;
  attribution: FailureAttribution;
  durationMs: number;
  subjectId: string;
  deviceId?: string;
  /** Short failure detail — never raw learner content. */
  message?: string;
}

export interface ConformanceRunReport {
  kind: "conformance-run-report";
  reportVersion: "1.0.0";
  passed: number;
  failed: number;
  timedOut: number;
  errored: number;
  /** `0` when every verdict passed; `1` otherwise (CI aggregate). */
  exitCode: 0 | 1;
  verdicts: ObligationVerdict[];
}

export type ReportFormat = "human" | "json";

/** CI aggregate: any non-pass → exit 1. */
export function aggregateExitCode(
  verdicts: readonly ObligationVerdict[],
): 0 | 1 {
  return verdicts.every((v) => v.outcome === "pass") ? 0 : 1;
}

/** Build a stable run report from per-obligation verdicts. */
export function buildRunReport(
  verdicts: readonly ObligationVerdict[],
): ConformanceRunReport {
  let passed = 0;
  let failed = 0;
  let timedOut = 0;
  let errored = 0;
  for (const v of verdicts) {
    switch (v.outcome) {
      case "pass":
        passed++;
        break;
      case "fail":
        failed++;
        break;
      case "timeout":
        timedOut++;
        break;
      case "error":
        errored++;
        break;
    }
  }
  return {
    kind: "conformance-run-report",
    reportVersion: "1.0.0",
    passed,
    failed,
    timedOut,
    errored,
    exitCode: aggregateExitCode(verdicts),
    verdicts: [...verdicts],
  };
}

function padOutcome(outcome: VerdictOutcome): string {
  return outcome.toUpperCase().padEnd(7, " ");
}

/**
 * Human-readable per-obligation table.
 * Failures always include the verbatim MUST text (and optional message).
 */
export function formatHumanReport(report: ConformanceRunReport): string {
  const lines: string[] = [];
  lines.push("Conformance verdicts");
  lines.push("────────────────────");
  for (const v of report.verdicts) {
    lines.push(
      `${padOutcome(v.outcome)}  ${v.obligationId}  ${v.contract}  ${v.durationMs}ms  [${v.attribution}]  subject=${v.subjectId}`,
    );
    if (v.outcome !== "pass") {
      lines.push(`         MUST: ${v.mustText}`);
      if (v.message) {
        lines.push(`         detail: ${v.message}`);
      }
    }
  }
  lines.push("────────────────────");
  lines.push(
    `${report.passed} passed, ${report.failed} failed, ${report.timedOut} timed out, ${report.errored} errored — exit ${report.exitCode}`,
  );
  return `${lines.join("\n")}\n`;
}

/** Stable JSON document (same shape as {@link ConformanceRunReport}). */
export function formatJsonReport(report: ConformanceRunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Render in the requested format. */
export function formatReport(
  report: ConformanceRunReport,
  format: ReportFormat = "human",
): string {
  return format === "json" ? formatJsonReport(report) : formatHumanReport(report);
}

/**
 * Write the report to a stream.
 * Returns the aggregate exit code for CI.
 */
export function writeReport(
  report: ConformanceRunReport,
  options: {
    format?: ReportFormat;
    stdout: { write(chunk: string): void };
  },
): 0 | 1 {
  options.stdout.write(formatReport(report, options.format ?? "human"));
  return report.exitCode;
}
