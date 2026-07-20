/**
 * Detect whether CI should run the gym replay parity job.
 *
 * Triggers on changes under:
 *   - training/gym/
 *   - packages/runtime-harness/
 *   - .github/workflows/ci.yml (workflow self-changes must re-prove the gate)
 *   - .github/workflows/ci-nightly.yml
 *
 * Usage (GitHub Actions):
 *   node training/gym/scripts/detect-parity-ci-paths.mjs \
 *     --event pull_request --base <sha> --head <sha> >> "$GITHUB_OUTPUT"
 *
 * Prints GITHUB_OUTPUT lines: run=true|false and matched=<csv|none>
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Path prefixes that must run gym replay parity (charter invariant). */
export const GYM_REPLAY_PARITY_PATH_PREFIXES = Object.freeze([
  "training/gym/",
  "packages/runtime-harness/",
  ".github/workflows/ci.yml",
  ".github/workflows/ci-nightly.yml",
]);

/**
 * @param {string} filePath
 * @param {readonly string[]} [prefixes]
 */
export function pathTriggersGymReplayParity(
  filePath,
  prefixes = GYM_REPLAY_PARITY_PATH_PREFIXES,
) {
  const p = String(filePath || "").replace(/\\/g, "/");
  if (!p) return false;
  return prefixes.some(
    (prefix) => p === prefix.replace(/\/$/, "") || p.startsWith(prefix),
  );
}

/**
 * @param {readonly string[]} files
 * @param {readonly string[]} [prefixes]
 */
export function selectParityTriggeringPaths(
  files,
  prefixes = GYM_REPLAY_PARITY_PATH_PREFIXES,
) {
  const matched = [];
  const seen = new Set();
  for (const f of files) {
    const norm = String(f || "").replace(/\\/g, "/");
    if (!norm || seen.has(norm)) continue;
    if (pathTriggersGymReplayParity(norm, prefixes)) {
      seen.add(norm);
      matched.push(norm);
    }
  }
  return matched;
}

/**
 * @param {{
 *   eventName: string,
 *   base?: string | null,
 *   head?: string | null,
 *   files?: string[] | null,
 * }} input
 */
export function decideGymReplayParityRun(input) {
  const eventName = String(input.eventName || "").trim();
  // Push to main: always run (merge already landed; keep trunk green).
  if (eventName === "push") {
    return {
      run: true,
      matched: ["(push-always)"],
      detail: "push event always runs gym replay parity",
    };
  }

  if (Array.isArray(input.files)) {
    const matched = selectParityTriggeringPaths(input.files);
    return {
      run: matched.length > 0,
      matched: matched.length > 0 ? matched : [],
      detail:
        matched.length > 0
          ? `matched ${matched.length} path(s)`
          : "no gym/harness path changes",
    };
  }

  const base = String(input.base || "").trim();
  const head = String(input.head || "").trim();
  if (!base || !head || /^0+$/.test(base)) {
    // Missing base (first push / shallow) — fail closed: run the gate.
    return {
      run: true,
      matched: ["(missing-base-fail-closed)"],
      detail: "base sha missing — fail closed, run parity",
    };
  }

  let files = [];
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", `${base}...${head}`],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    files = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    return {
      run: true,
      matched: ["(git-diff-fail-closed)"],
      detail: `git diff failed — fail closed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const matched = selectParityTriggeringPaths(files);
  return {
    run: matched.length > 0,
    matched,
    detail:
      matched.length > 0
        ? `matched ${matched.length} path(s)`
        : "no gym/harness path changes",
  };
}

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--event" && argv[i + 1]) {
      out.event = argv[++i];
    } else if (a === "--base" && argv[i + 1]) {
      out.base = argv[++i];
    } else if (a === "--head" && argv[i + 1]) {
      out.head = argv[++i];
    } else if (a === "--files-json" && argv[i + 1]) {
      out.filesJson = argv[++i];
    }
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  /** @type {string[] | null} */
  let files = null;
  if (args.filesJson) {
    files = JSON.parse(args.filesJson);
  }
  const decided = decideGymReplayParityRun({
    eventName: args.event ?? "pull_request",
    base: args.base ?? null,
    head: args.head ?? null,
    files,
  });

  const matchedCsv =
    decided.matched.length > 0 ? decided.matched.slice(0, 32).join(",") : "none";
  // stdout is appended to GITHUB_OUTPUT — only key=value lines.
  process.stdout.write(`run=${decided.run ? "true" : "false"}\n`);
  process.stdout.write(`matched=${matchedCsv}\n`);
  process.stderr.write(
    `${JSON.stringify({
      event: "training.gym.replay_parity",
      phase: "ci_path_filter",
      outcome: "ok",
      subjectId: null,
      deviceId: "ci-path-filter",
      run: decided.run,
      matchedCount: decided.matched.length,
      detail: decided.detail,
    })}\n`,
  );
  return decided;
}

const thisFile = fileURLToPath(import.meta.url);
const invokedAs =
  process.argv[1] != null ? path.resolve(process.argv[1]) : "";
if (invokedAs && path.resolve(thisFile) === invokedAs) {
  main();
}
