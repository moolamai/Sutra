/**
 * Execute independent certification run: environment manifest + per-obligation report.
 *
 * Uses independence-kit fixtures + published obligation catalog. Storage/model
 * stacks are local to this artifact (not monorepo reference bindings).
 *
 * Usage:
 *   node artifacts/independent-certification/scripts/run-certification.mjs
 *   node artifacts/independent-certification/scripts/run-certification.mjs --seed unstable-embed
 */
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CERTIFICATION_OBLIGATION_IDS,
  createIndependentCertificationFactory,
} from "../src/factory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const REPO = path.join(ROOT, "..", "..");
const REPORTS = path.join(ROOT, "reports");

function parseArgs(argv) {
  const out = { seedMode: "good", subjectId: "cert.indep.a", deviceId: "ext-ci-1" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed") out.seedMode = argv[++i] ?? "good";
    else if (argv[i] === "--subject-id") out.subjectId = argv[++i] ?? out.subjectId;
    else if (argv[i] === "--device-id") out.deviceId = argv[++i] ?? out.deviceId;
  }
  return out;
}

function collectEnvironmentManifest(opts) {
  const node = process.versions.node;
  let kitVersion = null;
  const manifestPath = path.join(
    REPO,
    "packages",
    "contract-conformance",
    "fixtures",
    "independence-kit",
    "MANIFEST.json",
  );
  if (existsSync(manifestPath)) {
    kitVersion = JSON.parse(readFileSync(manifestPath, "utf8")).kitVersion;
  }

  return {
    schemaVersion: "independent-certification.environment.v1",
    collectedAt: new Date().toISOString(),
    subjectId: opts.subjectId,
    deviceId: opts.deviceId,
    runtime: {
      node,
      platform: process.platform,
      arch: process.arch,
    },
    stacks: {
      storage: {
        id: "file-jsonl-v1",
        shippedInReferenceMonorepo: false,
        detail: "artifacts/independent-certification/src/storage.mjs",
      },
      model: {
        id: "deterministic-on-device-v1",
        shippedInReferenceMonorepo: false,
        detail: "artifacts/independent-certification/src/model.mjs",
      },
    },
    independenceKit: {
      package: "@moolam/contract-conformance",
      kitVersion,
      monorepoCheckoutRequired: false,
    },
    obligationIds: [...CERTIFICATION_OBLIGATION_IDS],
    seedMode: opts.seedMode,
  };
}

/**
 * @param {{ seedMode?: string, subjectId?: string, deviceId?: string, dataDir?: string, emit?: (e: object) => void }} [options]
 */
export async function runIndependentCertification(options = {}) {
  const seedMode = options.seedMode ?? "good";
  const subjectId = options.subjectId ?? "cert.indep.a";
  const deviceId = options.deviceId ?? "ext-ci-1";
  const dataDir =
    options.dataDir ??
    path.join(ROOT, "data", `cert-${Date.now()}-${process.pid}`);

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(REPORTS, { recursive: true });

  const events = [];
  const emit =
    options.emit ??
    ((e) => {
      events.push(e);
    });

  const distCli = path.join(
    REPO,
    "packages",
    "contract-conformance",
    "dist",
    "cli.js",
  );
  const distIndex = path.join(
    REPO,
    "packages",
    "contract-conformance",
    "dist",
    "index.js",
  );

  const { buildExternalConformanceRegistry } = await import(
    pathToFileURL(distCli).href
  );
  const { runConformance } = await import(pathToFileURL(distIndex).href);

  const registry = buildExternalConformanceRegistry();
  const factory = createIndependentCertificationFactory({
    dataDir,
    seedMode,
  });

  emit({
    event: "certification.run",
    outcome: "start",
    subjectId,
    deviceId,
    seedMode,
  });

  const report = await runConformance({
    registry,
    factory,
    subjectId,
    deviceId,
    obligationIds: CERTIFICATION_OBLIGATION_IDS,
    deadlineMs: seedMode === "hang" ? 40 : 5_000,
    emit: (e) => {
      emit({
        event: e.event ?? "conformance.obligation",
        outcome: e.outcome,
        subjectId: e.subjectId ?? subjectId,
        deviceId: e.deviceId ?? deviceId,
        obligationId: e.obligationId,
        attribution: e.attribution,
      });
    },
  });

  const env = collectEnvironmentManifest({ subjectId, deviceId, seedMode });
  const artifact = {
    schemaVersion: "independent-certification.report.v1",
    outcome: report.exitCode === 0 ? "pass" : "fail",
    exitCode: report.exitCode,
    environment: env,
    verdicts: report.verdicts.map((v) => ({
      obligationId: v.obligationId,
      outcome: v.outcome,
      attribution: v.attribution,
      contract: v.contract,
      mustText: v.mustText,
      message: v.message,
      subjectId: v.subjectId,
      deviceId: v.deviceId,
      durationMs: v.durationMs,
    })),
    summary: {
      passed: report.passed,
      failed: report.failed,
      timedOut: report.timedOut,
      errored: report.errored,
    },
    events,
  };

  emit({
    event: "certification.run",
    outcome: artifact.outcome,
    subjectId,
    deviceId,
    passed: report.passed,
    failed: report.failed,
  });

  return { report, artifact, env, dataDir };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  // Ensure conformance package is built (kit + dist).
  const build = spawnSync(
    "pnpm",
    ["--filter", "@moolam/contract-conformance", "run", "build"],
    { cwd: REPO, encoding: "utf8", shell: true, stdio: "inherit" },
  );
  if (build.status !== 0) {
    process.exitCode = 1;
    return;
  }

  const events = [];
  const { artifact, dataDir } = await runIndependentCertification({
    ...args,
    emit: (e) => {
      events.push(e);
      process.stderr.write(`${JSON.stringify(e)}\n`);
    },
  });
  artifact.events = events;

  const envPath = path.join(REPORTS, "environment-manifest.json");
  const reportPath = path.join(REPORTS, "certification-report.json");
  writeFileSync(envPath, `${JSON.stringify(artifact.environment, null, 2)}\n`);
  writeFileSync(reportPath, `${JSON.stringify(artifact, null, 2)}\n`);

  // Cleanup durable scratch unless failing for inspection.
  if (artifact.exitCode === 0 && existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
  }

  process.stdout.write(
    `independent-certification: ${artifact.outcome} (passed=${artifact.summary.passed} failed=${artifact.summary.failed}) → ${reportPath}\n`,
  );
  process.exitCode = artifact.exitCode;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
