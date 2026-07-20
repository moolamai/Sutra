/**
 * Prove CERTRUN-002: certification findings triage + freeze Accepted + gate unlocked + 1.0.0 lockstep.
 *
 * Usage: node scripts/prove-certification-freeze-publish.mjs
 *        pnpm certification:freeze:prove
 */
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  parseFreezeAcceptance,
} from "./check-production-publish-gate.mjs";
import { checkFreezeRfc } from "./check-freeze-rfc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "certification.freeze.prove", ...event })}\n`,
  );
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function verifyCertificationFreezePublish(opts = {}) {
  const subjectId = opts.subjectId ?? "prove.cert.freeze";
  const deviceId = opts.deviceId ?? "ci";
  const events = [];
  const push = (e) => {
    events.push(e);
    if (opts.emit !== false) emit({ ...e, subjectId, deviceId });
  };

  const rfc = readFileSync(
    path.join(REPO, "rfcs", "0001-protocol-1.0-freeze.md"),
    "utf8",
  );
  const findings = JSON.parse(
    readFileSync(
      path.join(REPO, "rfcs", "appendix", "certification-findings.json"),
      "utf8",
    ),
  );
  const gate = JSON.parse(
    readFileSync(
      path.join(REPO, "rfcs", "appendix", "production-publish-gate.json"),
      "utf8",
    ),
  );
  const syncPkg = JSON.parse(
    readFileSync(
      path.join(REPO, "packages", "sync-protocol", "package.json"),
      "utf8",
    ),
  );
  const contractSrc = readFileSync(
    path.join(REPO, "packages", "sync-protocol", "src", "contract.ts"),
    "utf8",
  );
  const changelog = readFileSync(path.join(REPO, "CHANGELOG.md"), "utf8");

  assert(findings.runOutcome === "pass", "certification run must be pass");
  assert(
    findings.stacks.storage.shippedInReferenceMonorepo === false,
    "storage must be non-reference",
  );
  assert(
    findings.stacks.model.shippedInReferenceMonorepo === false,
    "model must be non-reference",
  );
  const fp002 = findings.findings.find((f) => f.id === "FP-002");
  assert(fp002?.status === "closed", "FP-002 must be closed");
  const waived = findings.findings.find((f) => f.id === "CERTRUN-F-003");
  assert(waived?.status === "waived" && waived.expiry, "catalog waiver needs expiry");

  const acceptance = parseFreezeAcceptance(rfc);
  assert(acceptance.accepted, "RFC must be Accepted");
  assert(acceptance.signoffComplete, "maintainer sign-off required");
  assert(!acceptance.hasBlockingIssues, "no Blocks acceptance rows");
  assert(gate.unlocked === true, "production gate must be unlocked");

  const freezeCheck = checkFreezeRfc({ repoRoot: REPO, emitEvents: false });
  assert(freezeCheck.ok, `freeze rfc check: ${freezeCheck.failures?.join("; ")}`);

  assert(syncPkg.version === "1.0.0", "sync-protocol must be 1.0.0");
  assert(
    /PROTOCOL_VERSION = "1\.0\.0"/.test(contractSrc),
    "PROTOCOL_VERSION must be 1.0.0",
  );
  assert(/## \[1\.0\.0\]/.test(changelog), "root CHANGELOG must list 1.0.0");
  assert(
    !/utterance\s*[:=]\s*["'][^"']{20,}/i.test(rfc),
    "RFC must not embed raw utterance bodies",
  );

  push({ outcome: "pass", phase: "verify" });
  return { ok: true, events, acceptance, gate };
}

/** Seeded red: Accepted RFC with a Blocks acceptance row must not unlock. */
export function proveSeededBlockerKeepsGateLocked() {
  const rfc = readFileSync(
    path.join(REPO, "rfcs", "0001-protocol-1.0-freeze.md"),
    "utf8",
  );
  const poisoned = rfc.replace(
    /\| `CERTRUN-F-003`[\s\S]*?\|\n/,
    "| `SEED-BLOCK` | P1 | **Blocks acceptance** | CI | — | seeded |\n",
  );
  const dir = mkdtempSync(path.join(tmpdir(), "prove-freeze-"));
  try {
    const rfcPath = path.join(dir, "rfc.md");
    writeFileSync(rfcPath, poisoned);
    const body = readFileSync(rfcPath, "utf8");
    const acceptance = parseFreezeAcceptance(body);
    assert(acceptance.hasBlockingIssues, "seed must introduce blocker");
    assert(!acceptance.unlocked, "seeded blocker must keep gate locked");
    return { ok: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const green = verifyCertificationFreezePublish();
  if (!green.ok) process.exitCode = 1;

  const red = proveSeededBlockerKeepsGateLocked();
  if (!red.ok) process.exitCode = 1;

  // Idempotent replay of gate write.
  const gateWrite = spawnSync(
    "pnpm",
    ["production-publish:gate", "--", "--write"],
    { cwd: REPO, shell: true, encoding: "utf8" },
  );
  if (gateWrite.status !== 0) {
    process.stderr.write(gateWrite.stderr ?? gateWrite.stdout ?? "");
    process.exitCode = 1;
    return;
  }

  emit({
    outcome: "ok",
    subjectId: "prove.cert.freeze",
    deviceId: "ci",
    phase: "complete",
    unlocked: true,
  });
  process.stdout.write(
    "prove-certification-freeze-publish: OK (findings → Accepted → unlocked → 1.0.0)\n",
  );
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
