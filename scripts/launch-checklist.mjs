import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEM_SUBJECT = "system:launch-readiness";
const DEVICE_ID = process.env.RUNNER_NAME || hostname() || "unknown-runner";
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_DECLARATIONS = 512;
const CHECK_TIMEOUT_MS = 15 * 60 * 1000;

export const TRACK_MANIFESTS = Object.freeze([
  {
    track: "A",
    path: "docs/stages/tracks/track-a-sovereign-protocol/PROGRESS.md",
  },
  {
    track: "B",
    path: "docs/stages/tracks/track-b-cognitive-harness/PROGRESS.md",
  },
]);

export const SUB_CHECKERS = Object.freeze([
  {
    id: "conformance",
    phase: "B0",
    command: "pnpm",
    args: ["conformance"],
    optionalOnFork: false,
  },
  {
    id: "guidance-eval",
    phase: "B8",
    command: "pnpm",
    args: ["guidance:eval"],
    optionalOnFork: true,
  },
  {
    id: "consent-trajectory",
    phase: "B9",
    command: "pnpm",
    args: ["--filter", "@moolam/telemetry", "test"],
    optionalOnFork: false,
  },
]);

export class LaunchChecklistError extends Error {
  constructor(failureClass, message, details = {}) {
    super(message);
    this.name = "LaunchChecklistError";
    this.failureClass = failureClass;
    this.details = details;
  }
}

function event(fields) {
  process.stdout.write(
    `${JSON.stringify({
      event: "launch_checklist.gate",
      subjectId: SYSTEM_SUBJECT,
      deviceId: DEVICE_ID,
      ...fields,
    })}\n`,
  );
}

function boundedRead(filePath) {
  const size = statSync(filePath).size;
  if (size > MAX_MANIFEST_BYTES) {
    throw new LaunchChecklistError(
      "manifest_too_large",
      `${filePath} is ${size} bytes; limit is ${MAX_MANIFEST_BYTES}`,
    );
  }
  return readFileSync(filePath, "utf8");
}

export function parseTrackManifest(text, track, source = "<memory>") {
  const phases = [];
  const seen = new Set();
  let current;

  for (const line of text.split(/\r?\n/)) {
    const heading =
      /^##\s+((?:P|B)\d+)\s+(?:—|-|â€”)\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { id: heading[1], name: heading[2], track, declarations: [] };
      phases.push(current);
      continue;
    }

    const task = /^-\s+\[([ xX])\]\s+\[([A-Z0-9-]+)\]\(([^)]+)\)/.exec(line);
    if (!task) continue;
    if (!current) {
      throw new LaunchChecklistError(
        "manifest_validation",
        `${source}: task ${task[2]} appears before a phase heading`,
      );
    }
    if (seen.has(task[2])) {
      throw new LaunchChecklistError(
        "manifest_validation",
        `${source}: duplicate gate declaration ${task[2]}`,
        { gateId: task[2], phase: current.id },
      );
    }
    seen.add(task[2]);
    current.declarations.push({
      id: task[2],
      complete: task[1].toLowerCase() === "x",
      taskPath: task[3],
    });
    if (seen.size > MAX_DECLARATIONS) {
      throw new LaunchChecklistError(
        "manifest_too_large",
        `${source}: more than ${MAX_DECLARATIONS} gate declarations`,
      );
    }
  }

  if (phases.length === 0 || phases.some((phase) => phase.declarations.length === 0)) {
    throw new LaunchChecklistError(
      "manifest_validation",
      `${source}: every track phase must declare at least one gate`,
    );
  }
  return phases;
}

export function evaluateTrackGates(phases) {
  return phases.map((phase) => {
    const violations = phase.declarations
      .filter((declaration) => !declaration.complete)
      .map((declaration) => ({
        gateId: declaration.id,
        taskPath: declaration.taskPath,
        message: `${phase.track}/${phase.id} gate ${declaration.id} is not complete`,
      }));
    return {
      id: `track-${phase.track.toLowerCase()}-${phase.id.toLowerCase()}`,
      track: phase.track,
      phase: phase.id,
      outcome: violations.length === 0 ? "pass" : "fail",
      failureClass: violations.length === 0 ? null : "gate_regression",
      violations,
    };
  });
}

function sensitiveKey(value) {
  return /^(rawKeystrokes|rawContent|prompt|utterance|transcript|content)$/i.test(
    value,
  );
}

function findSensitiveKey(value, prefix = "$") {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey(key)) return `${prefix}.${key}`;
    const nested = findSensitiveKey(child, `${prefix}.${key}`);
    if (nested) return nested;
  }
  return null;
}

export function validateCertificationReport(profile, report, profileId) {
  const violations = [];
  const requiredIdentity = [
    ["profileId", profile.profileId],
    ["adapter", profile.adapter],
    ["subjectId", profile.subjectId],
    ["deviceId", profile.deviceId],
  ];
  for (const [field, expected] of requiredIdentity) {
    if (report[field] !== expected) {
      violations.push(`${field}: expected ${expected}, received ${report[field]}`);
    }
  }
  if (report.outcome !== "pass") violations.push(`outcome: ${report.outcome}`);
  if (report.failures?.length) {
    violations.push(`failures: ${JSON.stringify(report.failures)}`);
  }
  if (report.modelArtifactSha256 !== profile.modelArtifact?.artifactSha256) {
    violations.push(
      `artifact hash mismatch: profile=${profile.modelArtifact?.artifactSha256} report=${report.modelArtifactSha256}`,
    );
  }
  if (report.measuredArtifactSha256 !== report.modelArtifactSha256) {
    violations.push(
      `measured artifact hash mismatch: expected=${report.modelArtifactSha256} measured=${report.measuredArtifactSha256}`,
    );
  }
  if (report.egressRecord?.ok !== true || report.egressRecord?.attemptCount !== 0) {
    violations.push("locality egress proof is not zero-egress");
  }
  for (const verdict of report.obligationVerdicts ?? []) {
    if (verdict.outcome !== "pass") {
      violations.push(`obligation ${verdict.obligationId}: ${verdict.outcome}`);
    }
  }
  for (const [benchId, bench] of Object.entries(report.p95Benches ?? {})) {
    if (bench.ok !== true) violations.push(`benchmark ${benchId}: not green`);
  }
  const exposed = findSensitiveKey(report);
  if (exposed) violations.push(`sovereignty violation: raw-content field ${exposed}`);

  return {
    id: `certification-${profileId}`,
    track: "B",
    phase: "B6",
    subjectId: report.subjectId,
    deviceId: report.deviceId,
    outcome: violations.length === 0 ? "pass" : "fail",
    failureClass: violations.length === 0 ? null : "certification_mismatch",
    violations: violations.map((message) => ({
      gateId: `certification-${profileId}`,
      message,
    })),
  };
}

export function checkCertificationRegistry(root = REPO_ROOT) {
  const certificationRoot = path.join(
    root,
    "packages/bindings-slm/certification",
  );
  const registry = JSON.parse(
    boundedRead(path.join(certificationRoot, "registry.json")),
  );
  if (
    !Array.isArray(registry.profiles) ||
    registry.profiles.length === 0 ||
    registry.profiles.length > 32
  ) {
    throw new LaunchChecklistError(
      "manifest_validation",
      "certification registry must declare 1..32 profiles",
    );
  }

  const identities = new Set();
  return registry.profiles.map((entry) => {
    const profile = JSON.parse(
      boundedRead(path.resolve(certificationRoot, entry.profileRelpath)),
    );
    const report = JSON.parse(
      boundedRead(path.resolve(certificationRoot, entry.committedReportRelpath)),
    );
    const identity = `${report.subjectId}\0${report.deviceId}`;
    const result = validateCertificationReport(profile, report, entry.id);
    if (identities.has(identity)) {
      result.outcome = "fail";
      result.failureClass = "subject_isolation";
      result.violations.push({
        gateId: result.id,
        message: `duplicate certification subject/device identity ${report.subjectId}/${report.deviceId}`,
      });
    }
    identities.add(identity);
    return result;
  });
}

function runSubChecker(checker, { forkPr = false } = {}) {
  if (forkPr && checker.optionalOnFork) {
    return {
      id: checker.id,
      track: "B",
      phase: checker.phase,
      outcome: "skip",
      failureClass: null,
      violations: [],
      reason: "optional_on_fork_pr",
    };
  }

  const started = Date.now();
  const child = spawnSync(checker.command, checker.args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // Windows resolves pnpm through its .cmd shim; commands and args are static.
    shell: process.platform === "win32",
    timeout: CHECK_TIMEOUT_MS,
    windowsHide: true,
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  const timedOut = child.error?.code === "ETIMEDOUT";
  const spawnFailed = child.error && !timedOut;
  const exitCode = child.status ?? 1;
  return {
    id: checker.id,
    track: "B",
    phase: checker.phase,
    outcome: exitCode === 0 && !timedOut ? "pass" : "fail",
    failureClass: timedOut
      ? "downstream_timeout"
      : spawnFailed
        ? "downstream_spawn"
        : exitCode
          ? "subcheck_failure"
          : null,
    durationMs: Date.now() - started,
    exitCode,
    violations:
      exitCode === 0 && !timedOut
        ? []
        : [
            {
              gateId: checker.id,
              message: timedOut
                ? `${checker.phase} gate ${checker.id} timed out after ${CHECK_TIMEOUT_MS}ms`
                : spawnFailed
                  ? `${checker.phase} gate ${checker.id} could not start: ${child.error.message}`
                : `${checker.phase} gate ${checker.id} exited ${exitCode}`,
            },
          ],
  };
}

export function aggregateResults(results) {
  const failures = results.flatMap((result) => result.violations ?? []);
  return {
    schemaVersion: "launch-checklist.report.v1",
    event: "launch_checklist.completed",
    subjectId: SYSTEM_SUBJECT,
    deviceId: DEVICE_ID,
    recordedAt: new Date().toISOString(),
    outcome: failures.length === 0 ? "green" : "red",
    counts: {
      pass: results.filter((result) => result.outcome === "pass").length,
      fail: results.filter((result) => result.outcome === "fail").length,
      skip: results.filter((result) => result.outcome === "skip").length,
    },
    results,
    failures,
  };
}

function parseArgs(argv) {
  const options = {
    forkPr: false,
    prove: false,
    selfTest: false,
    reportPath: process.env.LAUNCH_CHECKLIST_REPORT || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--fork-pr") options.forkPr = true;
    else if (argv[index] === "--prove") options.prove = true;
    else if (argv[index] === "--self-test") options.selfTest = true;
    else if (argv[index] === "--report" && argv[index + 1]) {
      options.reportPath = argv[++index];
    } else {
      throw new LaunchChecklistError(
        "argument_validation",
        `unknown or incomplete argument: ${argv[index]}`,
      );
    }
  }
  return options;
}

export function proveSeededGateViolation() {
  const manifest = TRACK_MANIFESTS.find((entry) => entry.track === "B");
  const sourcePath = path.join(REPO_ROOT, manifest.path);
  const scratchRoot = mkdtempSync(
    path.join(tmpdir(), "sutra-launch-checklist-proof-"),
  );
  const scratchPath = path.join(scratchRoot, "track-b-progress.md");

  try {
    const committed = boundedRead(sourcePath);
    const greenText = committed.replace(
      /^(-\s+\[)[ xX](\]\s+\[[A-Z0-9-]+\]\([^)]+\))/gm,
      "$1x$2",
    );
    writeFileSync(scratchPath, greenText, "utf8");

    const greenBefore = aggregateResults(
      evaluateTrackGates(
        parseTrackManifest(boundedRead(scratchPath), "B", "<scratch-green>"),
      ),
    );
    if (greenBefore.outcome !== "green") {
      throw new LaunchChecklistError(
        "proof_baseline_failure",
        "normalized scratch manifest did not produce a green baseline",
      );
    }

    const seed = /^(-\s+\[)x(\]\s+\[([A-Z0-9-]+)\]\([^)]+\))/m.exec(
      greenText,
    );
    if (!seed) {
      throw new LaunchChecklistError(
        "proof_seed_failure",
        "Track B scratch manifest has no gate declaration to seed",
      );
    }
    const seededText =
      greenText.slice(0, seed.index) +
      `${seed[1]} ${seed[2]}` +
      greenText.slice(seed.index + seed[0].length);
    writeFileSync(scratchPath, seededText, "utf8");

    const seededReport = aggregateResults(
      evaluateTrackGates(
        parseTrackManifest(boundedRead(scratchPath), "B", "<scratch-seeded>"),
      ),
    );
    const seededFailure = seededReport.failures.find(
      (failure) => failure.gateId === seed[3],
    );
    const seededResult = seededReport.results.find((result) =>
      result.violations?.some((violation) => violation.gateId === seed[3]),
    );
    if (
      seededReport.outcome !== "red" ||
      seededReport.failures.length !== 1 ||
      !seededFailure ||
      !seededResult
    ) {
      throw new LaunchChecklistError(
        "proof_expected_red",
        `seeded gate ${seed[3]} did not fail alone with its phase`,
      );
    }

    writeFileSync(scratchPath, greenText, "utf8");
    const restoredReport = aggregateResults(
      evaluateTrackGates(
        parseTrackManifest(boundedRead(scratchPath), "B", "<scratch-restored>"),
      ),
    );
    if (
      restoredReport.outcome !== "green" ||
      boundedRead(scratchPath) !== greenText
    ) {
      throw new LaunchChecklistError(
        "proof_restore_failure",
        `restoring seeded gate ${seed[3]} did not return the scratch checklist to green`,
      );
    }
    if (boundedRead(sourcePath) !== committed) {
      throw new LaunchChecklistError(
        "proof_source_mutation",
        "seeded proof changed the committed Track B manifest",
      );
    }

    return {
      schemaVersion: "launch-checklist.proof.v1",
      event: "launch_checklist.seeded_violation",
      subjectId: SYSTEM_SUBJECT,
      deviceId: DEVICE_ID,
      outcome: "pass",
      seeded: {
        gateId: seed[3],
        track: seededResult.track,
        phase: seededResult.phase,
        checklistOutcome: seededReport.outcome,
        failureClass: seededResult.failureClass,
        message: seededFailure.message,
      },
      restored: {
        checklistOutcome: restoredReport.outcome,
      },
    };
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

export function runSelfTests() {
  const green = parseTrackManifest(
    "## P0 — Wire\n\n- [x] [GATE-A](./a.md) — complete\n",
    "A",
  );
  assert.equal(aggregateResults(evaluateTrackGates(green)).outcome, "green");

  const broken = parseTrackManifest(
    "## B8 — Guidance\n\n- [ ] [GATE-B](./b.md) — regressed\n",
    "B",
  );
  const brokenReport = aggregateResults(evaluateTrackGates(broken));
  assert.equal(brokenReport.outcome, "red");
  assert.match(brokenReport.failures[0].message, /B\/B8 gate GATE-B/);

  assert.throws(
    () =>
      parseTrackManifest(
        "## B0 — One\n- [x] [DUP](./a)\n## B1 — Two\n- [x] [DUP](./b)\n",
        "B",
      ),
    (error) => error.failureClass === "manifest_validation",
  );

  const profile = {
    profileId: "fixture",
    adapter: "local",
    subjectId: "subject-a",
    deviceId: "device-a",
    modelArtifact: { artifactSha256: "a".repeat(64) },
  };
  const report = {
    profileId: "fixture",
    adapter: "local",
    subjectId: "subject-a",
    deviceId: "device-a",
    outcome: "pass",
    failures: [],
    modelArtifactSha256: "b".repeat(64),
    measuredArtifactSha256: "b".repeat(64),
    egressRecord: { ok: true, attemptCount: 0 },
    obligationVerdicts: [],
    p95Benches: {},
    rawKeystrokes: "forbidden",
  };
  const cert = validateCertificationReport(profile, report, "fixture");
  assert.equal(cert.outcome, "fail");
  assert.match(
    cert.violations.map((entry) => entry.message).join("\n"),
    /artifact hash mismatch[\s\S]*sovereignty violation/,
  );

  const optional = SUB_CHECKERS.find((checker) => checker.optionalOnFork);
  assert.equal(runSubChecker(optional, { forkPr: true }).outcome, "skip");
  return { tests: 5, outcome: "pass" };
}

export function runChecklist(options = {}) {
  const phaseResults = TRACK_MANIFESTS.flatMap((manifest) => {
    const manifestPath = path.join(REPO_ROOT, manifest.path);
    return evaluateTrackGates(
      parseTrackManifest(
        boundedRead(manifestPath),
        manifest.track,
        manifest.path,
      ),
    );
  });

  const results = [
    ...phaseResults,
    ...SUB_CHECKERS.map((checker) => runSubChecker(checker, options)),
    ...checkCertificationRegistry(),
  ];
  return aggregateResults(results);
}

function writeReport(reportPath, report) {
  const destination = path.resolve(REPO_ROOT, reportPath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
  });
  event({ outcome: "ok", operation: "report.write", reportPath });
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.selfTest) {
      const result = runSelfTests();
      event({ outcome: "ok", operation: "self_test", ...result });
      return;
    }
    if (options.prove) {
      const proof = proveSeededGateViolation();
      process.stdout.write(
        `LAUNCH GATE EXPECTED RED ${proof.seeded.gateId}: ${proof.seeded.message}\n`,
      );
      event({
        outcome: proof.outcome,
        operation: "seeded_violation.prove",
        gateId: proof.seeded.gateId,
        track: proof.seeded.track,
        phase: proof.seeded.phase,
        seededOutcome: proof.seeded.checklistOutcome,
        restoredOutcome: proof.restored.checklistOutcome,
        failureClass: proof.seeded.failureClass,
      });
      return;
    }

    event({ outcome: "started", operation: "aggregate", forkPr: options.forkPr });
    const report = runChecklist(options);
    for (const result of report.results) {
      event({
        outcome: result.outcome,
        operation: "gate",
        gateId: result.id,
        track: result.track,
        phase: result.phase,
        failureClass: result.failureClass,
        durationMs: result.durationMs,
      });
    }
    for (const failure of report.failures) {
      process.stderr.write(
        `LAUNCH GATE FAIL DIFF ${failure.gateId}: ${failure.message}\n`,
      );
    }
    if (options.reportPath) writeReport(options.reportPath, report);
    event({
      outcome: report.outcome,
      operation: "aggregate",
      counts: report.counts,
      failureClasses: [
        ...new Set(
          report.results.map((result) => result.failureClass).filter(Boolean),
        ),
      ],
    });
    if (report.outcome !== "green") process.exitCode = 1;
  } catch (error) {
    const failureClass =
      error instanceof LaunchChecklistError
        ? error.failureClass
        : error.code === "ENOENT"
          ? "missing_declaration"
          : error instanceof SyntaxError
            ? "manifest_validation"
            : "internal_error";
    event({
      outcome: "fail",
      operation: "aggregate",
      failureClass,
      message: error.message,
    });
    process.stderr.write(`LAUNCH GATE ERROR [${failureClass}]: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
