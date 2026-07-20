/**
 * Dependency-direction gate (CK-01 + anti-cheat training imports).
 *
 * Encodes Sutra's workspace boundaries via dependency-cruiser:
 * contracts imports nothing (incl. type-only), domains/** is import-forbidden,
 * cross-package edges go through @moolam/* names (no relative escapes),
 * training/gym may only reach packages/runtime-harness, and training/ must
 * not deep-import runtime-harness/src or locally re-implement harness primitives.
 *
 * Usage (repo root):
 *   node scripts/check-dependency-direction.mjs
 *   pnpm deps:lint
 */

import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cruise, format } from "dependency-cruiser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const loaded = require(path.join(REPO_ROOT, ".dependency-cruiser.cjs"));
export const RULE_IDS = loaded.RULE_IDS;

/** Bounded cruise roots (NFR — no unbounded full-repo walk). */
export const DEFAULT_CRUISE_PATHS = Object.freeze([
  "packages",
  "playground",
  "examples",
  "training",
]);

/**
 * Forbidden local harness re-implementations under training/ (charter §2).
 * Content-scan — complements dependency-cruiser import rules.
 */
export const HARNESS_REIMPL_FORBIDDEN_PATTERNS = Object.freeze([
  {
    symbol: "ToolCallParser",
    re: /\b(?:export\s+)?(?:async\s+)?(?:function|class|const)\s+ToolCallParser\b/,
  },
  {
    symbol: "SandboxSeam",
    re: /\b(?:export\s+)?(?:async\s+)?(?:function|class|const)\s+SandboxSeam\b/,
  },
  {
    symbol: "StreamingTurnHost",
    re: /\b(?:export\s+)?(?:async\s+)?(?:function|class|const)\s+StreamingTurnHost\b/,
  },
  {
    symbol: "CorrectionLoop",
    re: /\b(?:export\s+)?(?:async\s+)?(?:function|class|const)\s+CorrectionLoop\b/,
  },
  {
    symbol: "InProcessFakeToolRegistry",
    re: /\b(?:export\s+)?(?:async\s+)?(?:function|class|const)\s+InProcessFakeToolRegistry\b/,
  },
]);

/** Soft cap on files scanned under training/ (NFR). */
export const TRAINING_SCAN_FILE_LIMIT = 512;

/** Max violation lines rendered in human output. */
export const VIOLATION_REPORT_LIMIT = 64;

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "dependency.direction.gate", ...event })}\n`,
  );
}

/**
 * @param {import("dependency-cruiser").ICruiseResult} result
 * @returns {{ rule: string, from: string, to: string }[]}
 */
export function extractViolations(result) {
  const out = [];
  for (const mod of result.modules ?? []) {
    for (const dep of mod.dependencies ?? []) {
      for (const rule of dep.rules ?? []) {
        if (rule.severity === "error" || rule.severity === "warn") {
          out.push({
            rule: rule.name,
            from: mod.source,
            to: dep.resolved || dep.module,
          });
        }
      }
    }
  }
  return out.slice(0, VIOLATION_REPORT_LIMIT);
}

/**
 * Format file→edge lines: never a bare boolean on failure.
 * @param {{ rule: string, from: string, to: string }[]} violations
 */
export function formatViolationEdges(violations) {
  if (violations.length === 0) return "";
  return violations
    .map((v) => `${v.rule}: ${v.from} → ${v.to}`)
    .join("\n");
}

/**
 * Scan training/** source for local harness primitive re-implementations.
 * @param {string} [root]
 * @returns {{
 *   violations: { rule: string, from: string, to: string }[],
 *   filesScanned: number,
 * }}
 */
export function scanTrainingForHarnessReimplementation(root = REPO_ROOT) {
  const trainingRoot = path.join(root, "training");
  /** @type {{ rule: string, from: string, to: string }[]} */
  const violations = [];
  let filesScanned = 0;

  /** @param {string} dir */
  function walk(dir) {
    if (filesScanned >= TRAINING_SCAN_FILE_LIMIT) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (filesScanned >= TRAINING_SCAN_FILE_LIMIT) return;
      const name = ent.name;
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) {
        continue;
      }
      const abs = path.join(dir, name);
      if (ent.isDirectory()) {
        // Skip test dirs — same bound as depcruise exclude for tests.
        if (/^tests?$/i.test(name)) continue;
        walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!/\.(mjs|cjs|js|ts|tsx)$/.test(name)) continue;
      filesScanned += 1;
      let text;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      for (const pat of HARNESS_REIMPL_FORBIDDEN_PATTERNS) {
        if (pat.re.test(text)) {
          const rel = path.relative(root, abs).replace(/\\/g, "/");
          violations.push({
            rule: RULE_IDS.ANTI_CHEAT_HARNESS_REIMPL,
            from: rel,
            to: pat.symbol,
          });
        }
      }
    }
  }

  try {
    if (statSync(trainingRoot).isDirectory()) {
      walk(trainingRoot);
    }
  } catch {
    // No training/ tree — nothing to scan.
  }

  return {
    violations: violations.slice(0, VIOLATION_REPORT_LIMIT),
    filesScanned,
  };
}

/**
 * Run dependency-cruiser against `paths` under `cwd` with the shared rule set.
 * When cwd is the live repo root, also content-scans training/ for harness reimpl
 * unless `scanHarnessReimpl: false`.
 *
 * @param {{
 *   cwd?: string,
 *   paths?: string[],
 *   subjectId?: string,
 *   deviceId?: string,
 *   emitEvents?: boolean,
 *   scanHarnessReimpl?: boolean,
 * }} [options]
 */
export async function runDependencyDirectionGate(options = {}) {
  const cwd = options.cwd ?? REPO_ROOT;
  const paths = options.paths ?? [...DEFAULT_CRUISE_PATHS];
  const subjectId = options.subjectId ?? "subj-deps-direction-ci";
  const deviceId = options.deviceId ?? "dev-deps-direction-ci";
  const emitEvents = options.emitEvents !== false;
  const scanHarnessReimpl =
    options.scanHarnessReimpl !== undefined
      ? options.scanHarnessReimpl
      : cwd === REPO_ROOT;

  if (emitEvents) {
    emit({
      outcome: "start",
      phase: "cruise",
      subjectId,
      deviceId,
      paths,
      cwd: path.relative(REPO_ROOT, cwd) || ".",
    });
  }

  const ruleSet = {
    forbidden: loaded.forbidden,
    allowed: loaded.allowed,
    allowedSeverity: loaded.allowedSeverity,
    required: loaded.required,
  };

  // Only cruise paths that exist under cwd (scratch trees may omit playground).
  const existingPaths = paths.filter((p) => {
    try {
      return statSync(path.join(cwd, p)).isDirectory();
    } catch {
      return false;
    }
  });
  if (existingPaths.length === 0) {
    return {
      status: 1,
      violations: [],
      edgeText: "",
      textReport: "no cruise paths present under cwd",
      combined: "no cruise paths present under cwd",
      summary: { error: 1 },
      subjectId,
      deviceId,
    };
  }

  const cruiseResult = await cruise(existingPaths, {
    ...loaded.options,
    baseDir: cwd,
    // Relative tsconfig only resolves under the live repo root.
    ...(cwd === REPO_ROOT
      ? {}
      : {
          tsConfig: undefined,
          tsPreCompilationDeps: true,
        }),
    validate: true,
    ruleSet,
  });

  const output = cruiseResult.output;
  /** @type {{ rule: string, from: string, to: string }[]} */
  let violations = extractViolations(output);

  if (scanHarnessReimpl) {
    const scanned = scanTrainingForHarnessReimplementation(cwd);
    violations = [...violations, ...scanned.violations].slice(
      0,
      VIOLATION_REPORT_LIMIT,
    );
    if (emitEvents) {
      emit({
        outcome: scanned.violations.length === 0 ? "ok" : "fail",
        phase: "harness_reimpl_scan",
        subjectId,
        deviceId,
        filesScanned: scanned.filesScanned,
        violationCount: scanned.violations.length,
      });
    }
  }

  const edgeText = formatViolationEdges(violations);
  let textReport = "";
  if (typeof output === "string") {
    textReport = output;
  } else if ((output.summary?.error ?? 0) > 0 || violations.length > 0) {
    try {
      textReport = format(output, "err").output;
    } catch {
      textReport = edgeText;
    }
  }

  const status = output.summary?.error > 0 || violations.length > 0 ? 1 : 0;
  const combined = [textReport, edgeText].filter(Boolean).join("\n");

  if (emitEvents) {
    emit({
      outcome: status === 0 ? "ok" : "fail",
      phase: "cruise",
      subjectId,
      deviceId,
      exitCode: status,
      errorCount: output.summary?.error ?? violations.length,
      violationCount: violations.length,
      rules: [...new Set(violations.map((v) => v.rule))],
    });
  }

  return {
    status,
    violations,
    edgeText,
    textReport,
    combined,
    summary: output.summary,
    subjectId,
    deviceId,
  };
}

/**
 * Scratch-tree seeded violations — does not mutate the working tree.
 * Used by unit tests and fuller prove path.
 *
 * @param {
 *   | "contracts-type-only"
 *   | "domains"
 *   | "relative-cross-package"
 *   | "gym-forbidden-package"
 *   | "training-relative-harness-src"
 *   | "harness-reimplementation"
 * } kind
 */
export async function runSeededDependencyViolation(kind) {
  const root = mkdtempSync(path.join(tmpdir(), `sutra-deps-${kind}-`));
  try {
    if (kind === "contracts-type-only") {
      const dir = path.join(root, "packages/contracts/src");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "index.ts"),
        `import type { ZodType } from "zod";\nexport type T = ZodType;\n`,
      );
      return await runDependencyDirectionGate({
        cwd: root,
        paths: ["packages"],
        subjectId: "subj-seed-contracts-type",
        deviceId: "dev-seed-deps",
        emitEvents: false,
        scanHarnessReimpl: false,
      });
    }

    if (kind === "domains") {
      mkdirSync(path.join(root, "domains/teacher"), { recursive: true });
      writeFileSync(
        path.join(root, "domains/teacher/profile.ts"),
        `export const domain = "teacher";\n`,
      );
      const pkg = path.join(root, "packages/cognitive-core/src");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        path.join(pkg, "leak.ts"),
        `import { domain } from "../../../domains/teacher/profile.js";\nexport const d = domain;\n`,
      );
      return await runDependencyDirectionGate({
        cwd: root,
        paths: ["packages"],
        subjectId: "subj-seed-domains",
        deviceId: "dev-seed-deps",
        emitEvents: false,
        scanHarnessReimpl: false,
      });
    }

    if (kind === "relative-cross-package") {
      const a = path.join(root, "packages/contract-mocks/src");
      const b = path.join(root, "packages/cognitive-core/src");
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });
      writeFileSync(path.join(b, "hidden.ts"), `export const secret = 1;\n`);
      writeFileSync(
        path.join(a, "escape.ts"),
        `import { secret } from "../../cognitive-core/src/hidden.js";\nexport const s = secret;\n`,
      );
      return await runDependencyDirectionGate({
        cwd: root,
        paths: ["packages"],
        subjectId: "subj-seed-relative",
        deviceId: "dev-seed-deps",
        emitEvents: false,
        scanHarnessReimpl: false,
      });
    }

    if (kind === "gym-forbidden-package") {
      const core = path.join(root, "packages/cognitive-core/src");
      const gym = path.join(root, "training/gym/src");
      mkdirSync(core, { recursive: true });
      mkdirSync(gym, { recursive: true });
      writeFileSync(path.join(core, "loop.ts"), `export const loop = 1;\n`);
      writeFileSync(
        path.join(gym, "fork_path.mjs"),
        `import { loop } from "../../../packages/cognitive-core/src/loop.js";\nexport const x = loop;\n`,
      );
      return await runDependencyDirectionGate({
        cwd: root,
        paths: ["training", "packages"],
        subjectId: "subj-seed-gym-forbidden",
        deviceId: "dev-seed-deps",
        emitEvents: false,
        scanHarnessReimpl: false,
      });
    }

    if (kind === "training-relative-harness-src") {
      const harnessSrc = path.join(root, "packages/runtime-harness/src");
      const gym = path.join(root, "training/gym/src");
      mkdirSync(harnessSrc, { recursive: true });
      mkdirSync(gym, { recursive: true });
      writeFileSync(
        path.join(harnessSrc, "tool_call_parser.ts"),
        `export class ToolCallParser {}\n`,
      );
      writeFileSync(
        path.join(gym, "deep_import.mjs"),
        `import { ToolCallParser } from "../../../packages/runtime-harness/src/tool_call_parser.js";\nexport const P = ToolCallParser;\n`,
      );
      return await runDependencyDirectionGate({
        cwd: root,
        paths: ["training", "packages"],
        subjectId: "subj-seed-harness-src",
        deviceId: "dev-seed-deps",
        emitEvents: false,
        // Content-scan would also fire on the stub — gate import rule alone.
        scanHarnessReimpl: false,
      });
    }

    if (kind === "harness-reimplementation") {
      const gym = path.join(root, "training/gym/src");
      mkdirSync(gym, { recursive: true });
      writeFileSync(
        path.join(gym, "local_parser.mjs"),
        `export class ToolCallParser {\n  parse() { return null; }\n}\n`,
      );
      return await runDependencyDirectionGate({
        cwd: root,
        paths: ["training"],
        subjectId: "subj-seed-harness-reimpl",
        deviceId: "dev-seed-deps",
        emitEvents: false,
        scanHarnessReimpl: true,
      });
    }

    throw new Error(`UNKNOWN_SEED_KIND:${kind}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function main() {
  const result = await runDependencyDirectionGate({
    subjectId: "subj-deps-direction-ci",
    deviceId: "dev-deps-direction-ci",
  });
  if (result.edgeText) {
    process.stderr.write(`${result.edgeText}\n`);
  }
  if (result.textReport && result.status !== 0) {
    process.stderr.write(`${result.textReport}\n`);
  }
  process.exitCode = result.status;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    emit({
      outcome: "error",
      phase: "main",
      subjectId: "subj-deps-direction-ci",
      deviceId: "dev-deps-direction-ci",
      failureClass: "unhandled",
      message: err instanceof Error ? err.message : String(err),
    });
    process.stderr.write(
      `DEPENDENCY_DIRECTION_GATE_FAILED:${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
