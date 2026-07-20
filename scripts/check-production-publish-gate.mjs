/**
 * P5 production-publish gate — unlocks only when RFC 0001 is Accepted.
 *
 * Derives unlock state from rfcs/0001-protocol-1.0-freeze.md:
 *   - Status starts with "Accepted"
 *   - Maintainer acceptance names people (not Pending)
 *   - No open "Blocks acceptance" rows remain
 *
 * Writes / verifies rfcs/appendix/production-publish-gate.json and enforces
 * that release.yml refuses production registry publish while locked.
 *
 * Usage:
 *   node scripts/check-production-publish-gate.mjs
 *   node scripts/check-production-publish-gate.mjs --write
 *   pnpm production-publish:gate
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const RFC_PATH = path.join(
  REPO_ROOT,
  "rfcs",
  "0001-protocol-1.0-freeze.md",
);
export const GATE_JSON = path.join(
  REPO_ROOT,
  "rfcs",
  "appendix",
  "production-publish-gate.json",
);
export const RELEASE_WORKFLOW = path.join(
  REPO_ROOT,
  ".github",
  "workflows",
  "release.yml",
);
export const PUBLISH_CHECKLIST = path.join(
  REPO_ROOT,
  "docs",
  "sdk",
  "PUBLISH-CHECKLIST.md",
);

export const OBLIGATIONS = Object.freeze({
  MISSING_RFC: "prod_publish.missing_rfc",
  MISSING_WORKFLOW: "prod_publish.missing_workflow",
  MISSING_CHECKLIST: "prod_publish.missing_checklist",
  WORKFLOW_UNWIRED: "prod_publish.workflow_unwired",
  CHECKLIST_UNWIRED: "prod_publish.checklist_unwired",
  GATE_FILE_DRIFT: "prod_publish.gate_file_drift",
  ACCEPTED_WITHOUT_SIGNOFF: "prod_publish.accepted_without_signoff",
  ACCEPTED_WITH_BLOCKER: "prod_publish.accepted_with_blocker",
  UNLOCKED_WHILE_DRAFT: "prod_publish.unlocked_while_draft",
  SOVEREIGNTY: "prod_publish.sovereignty_incomplete",
  INVALID_GATE: "prod_publish.invalid_gate",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "production_publish.gate", ...event })}\n`,
  );
}

/**
 * @param {string} body
 */
export function parseFreezeAcceptance(body) {
  const status =
    /\|\s*\*\*Status\*\*\s*\|\s*([^|]+)\|/.exec(body)?.[1]?.trim() ?? "";
  const signoff =
    /\|\s*\*\*Maintainer acceptance\*\*\s*\|\s*([^|]+)\|/.exec(body)?.[1]?.trim() ??
    "";
  const issueBlock =
    /## Open issue disposition([\s\S]*?)(?=## Acceptance criteria)/.exec(
      body,
    )?.[1] ??
    /## Open issue disposition([\s\S]*?)(?=## )/.exec(body)?.[1] ??
    "";

  const blockingIssueRows = issueBlock.split(/\r?\n/).filter((line) => {
    if (!line.startsWith("|")) return false;
    if (/^\|\s*-+/.test(line) || /^\|\s*Issue\s*\|/i.test(line)) return false;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    return cells.some(
      (c) =>
        /^\*\*Blocks acceptance\*\*$/i.test(c) ||
        /^Blocks acceptance$/i.test(c),
    );
  });

  const accepted = /^Accepted\b/i.test(status);
  const signoffComplete =
    Boolean(signoff) &&
    !/pending/i.test(signoff) &&
    /\d{4}-\d{2}-\d{2}/.test(signoff);
  const hasBlockingIssues = blockingIssueRows.length > 0;
  const unlocked = accepted && signoffComplete && !hasBlockingIssues;

  let reason;
  if (unlocked) {
    reason = "RFC Accepted with maintainer sign-off; no blocking issues";
  } else if (!accepted) {
    reason = `RFC status is not Accepted (${status || "missing"})`;
  } else if (!signoffComplete) {
    reason =
      "Maintainer acceptance row incomplete (need named maintainers + dates)";
  } else {
    reason = `Blocking issues remain: ${blockingIssueRows.length}`;
  }

  return {
    status,
    signoff,
    accepted,
    signoffComplete,
    hasBlockingIssues,
    blockingIssueCount: blockingIssueRows.length,
    unlocked,
    reason,
  };
}

/**
 * @param {{
 *   unlocked: boolean,
 *   status: string,
 *   signoff: string,
 *   reason: string,
 *   subjectId?: string,
 *   deviceId?: string,
 *   evaluatedAt?: string,
 * }} args
 */
export function buildGateDocument(args) {
  return {
    kind: "production-publish-gate",
    schemaVersion: 1,
    unlocked: args.unlocked,
    rfcPath: "rfcs/0001-protocol-1.0-freeze.md",
    rfcStatus: args.status,
    maintainerAcceptance: args.signoff,
    reason: args.reason,
    npmAllowProdPublish: args.unlocked ? "true" : "false",
    pypiAllowProdPublish: args.unlocked ? "true" : "false",
    subjectId: args.subjectId ?? "ci-production-publish-gate",
    deviceId: args.deviceId ?? "ci",
    evaluatedAt: args.evaluatedAt ?? new Date().toISOString(),
  };
}

/**
 * @param {object} doc
 */
export function formatGateStable(doc) {
  // Drop evaluatedAt for equality checks (timestamps change).
  const { evaluatedAt: _ignored, ...rest } = doc;
  return rest;
}

/**
 * @param {{
 *   rfcPath?: string,
 *   gatePath?: string,
 *   releasePath?: string,
 *   checklistPath?: string,
 *   write?: boolean,
 *   allowProdEnv?: string,
 * }} [opts]
 */
export function checkProductionPublishGate(opts = {}) {
  const rfcPath = opts.rfcPath ?? RFC_PATH;
  const gatePath = opts.gatePath ?? GATE_JSON;
  const releasePath = opts.releasePath ?? RELEASE_WORKFLOW;
  const checklistPath = opts.checklistPath ?? PUBLISH_CHECKLIST;
  /** @type {string[]} */
  const failures = [];

  if (!existsSync(rfcPath)) {
    failures.push(`${OBLIGATIONS.MISSING_RFC}:${rfcPath}`);
    return { ok: false, failures, unlocked: false };
  }

  const rfcBody = readFileSync(rfcPath, "utf8");
  const parsed = parseFreezeAcceptance(rfcBody);

  if (parsed.accepted && !parsed.signoffComplete) {
    failures.push(OBLIGATIONS.ACCEPTED_WITHOUT_SIGNOFF);
  }
  if (parsed.accepted && parsed.hasBlockingIssues) {
    failures.push(OBLIGATIONS.ACCEPTED_WITH_BLOCKER);
  }

  if (
    !/## Maintainer acceptance workflow/i.test(rfcBody) ||
    !/production-publish:gate/i.test(rfcBody) ||
    !/NPM_ALLOW_PROD_PUBLISH/i.test(rfcBody)
  ) {
    failures.push(`${OBLIGATIONS.MISSING_RFC}:acceptance_workflow`);
  }

  if (
    !/subjectId/.test(rfcBody) ||
    !/deviceId/.test(rfcBody) ||
    !/never raw learner/i.test(rfcBody)
  ) {
    failures.push(OBLIGATIONS.SOVEREIGNTY);
  }

  const expected = buildGateDocument({
    unlocked: parsed.unlocked,
    status: parsed.status,
    signoff: parsed.signoff,
    reason: parsed.reason,
    evaluatedAt: "STABLE",
  });

  if (opts.write) {
    mkdirSync(path.dirname(gatePath), { recursive: true });
    const live = buildGateDocument({
      unlocked: parsed.unlocked,
      status: parsed.status,
      signoff: parsed.signoff,
      reason: parsed.reason,
    });
    writeFileSync(gatePath, `${JSON.stringify(live, null, 2)}\n`, "utf8");
  }

  if (!existsSync(gatePath)) {
    failures.push(`${OBLIGATIONS.GATE_FILE_DRIFT}:missing`);
  } else {
    /** @type {any} */
    let gate;
    try {
      gate = JSON.parse(readFileSync(gatePath, "utf8"));
    } catch (err) {
      failures.push(
        `${OBLIGATIONS.INVALID_GATE}:${err instanceof Error ? err.message : String(err)}`,
      );
      gate = null;
    }
    if (gate) {
      if (
        gate.kind !== "production-publish-gate" ||
        gate.schemaVersion !== 1 ||
        typeof gate.unlocked !== "boolean"
      ) {
        failures.push(OBLIGATIONS.INVALID_GATE);
      }
      const stableExpected = formatGateStable(expected);
      const stableActual = formatGateStable(gate);
      if (JSON.stringify(stableExpected) !== JSON.stringify(stableActual)) {
        failures.push(
          `${OBLIGATIONS.GATE_FILE_DRIFT}:expected_unlocked=${expected.unlocked}:actual_unlocked=${gate.unlocked}`,
        );
      }
      if (gate.unlocked === true && !parsed.unlocked) {
        failures.push(OBLIGATIONS.UNLOCKED_WHILE_DRAFT);
      }
      if (!gate.subjectId || !gate.deviceId) {
        failures.push(OBLIGATIONS.SOVEREIGNTY);
      }
    }
  }

  if (!existsSync(releasePath)) {
    failures.push(OBLIGATIONS.MISSING_WORKFLOW);
  } else {
    const wf = readFileSync(releasePath, "utf8");
    if (
      !/check-production-publish-gate\.mjs/.test(wf) ||
      !/FREEZE_RFC_UNLOCKED/.test(wf) ||
      !/production-publish-gate\.json/.test(wf)
    ) {
      failures.push(OBLIGATIONS.WORKFLOW_UNWIRED);
    }
    // While locked, workflow must not treat npm allow flag as sufficient alone.
    if (
      !/FREEZE_RFC_UNLOCKED/.test(wf) ||
      !/ALLOW_PROD/.test(wf)
    ) {
      failures.push(OBLIGATIONS.WORKFLOW_UNWIRED);
    }
  }

  if (!existsSync(checklistPath)) {
    failures.push(OBLIGATIONS.MISSING_CHECKLIST);
  } else {
    const checklist = readFileSync(checklistPath, "utf8");
    if (
      !/production-publish:gate/i.test(checklist) ||
      !/FREEZE_RFC_UNLOCKED/i.test(checklist) ||
      !/0001-protocol-1\.0-freeze/i.test(checklist) ||
      !/NPM_ALLOW_PROD_PUBLISH/i.test(checklist)
    ) {
      failures.push(OBLIGATIONS.CHECKLIST_UNWIRED);
    }
  }

  // Env consistency: if CI forces allow-prod while gate locked, fail.
  const allowProdEnv =
    opts.allowProdEnv ??
    process.env.NPM_ALLOW_PROD_PUBLISH ??
    process.env.ALLOW_PROD_PUBLISH ??
    "false";
  if (parsed.unlocked !== true && allowProdEnv === "true") {
    failures.push(
      `${OBLIGATIONS.UNLOCKED_WHILE_DRAFT}:env_NPM_ALLOW_PROD_PUBLISH=true`,
    );
  }

  const ok = failures.length === 0;
  return {
    ok,
    failures,
    unlocked: parsed.unlocked,
    status: parsed.status,
    reason: parsed.reason,
    expected,
  };
}

function main() {
  const write = process.argv.includes("--write");
  const result = checkProductionPublishGate({ write });
  emit({
    outcome: result.ok ? "ok" : "fail",
    subjectId: "ci-production-publish-gate",
    deviceId: "ci",
    unlocked: result.unlocked,
    status: result.status,
    reason: result.reason,
    failureCount: result.failures.length,
  });
  if (!result.ok) {
    for (const f of result.failures) process.stderr.write(`${f}\n`);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) main();
