/**
 * Gate for the implementor quickstart (install → first turn → sync).
 *
 * Usage (repo root):
 *   node scripts/check-implementor-quickstart.mjs
 *   pnpm implementor-quickstart:check
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const CANONICAL = path.join(
  REPO_ROOT,
  "docs",
  "sdk",
  "implementor-quickstart.md",
);
export const SITE_LANDING = path.join(
  REPO_ROOT,
  "docs-site",
  "src",
  "quickstarts",
  "implementor.md",
);

export const OBLIGATIONS = Object.freeze({
  MISSING_CANONICAL: "docs_site.quic.implementor.missing_canonical",
  MISSING_SITE_LANDING: "docs_site.quic.implementor.missing_site_landing",
  MISSING_SECTION: "docs_site.quic.implementor.missing_section",
  MONOREPO_PATH_LEAK: "docs_site.quic.implementor.monorepo_path_leak",
  MISSING_LINK: "docs_site.quic.implementor.missing_link",
  STALE_VERIFICATION: "docs_site.quic.implementor.stale_verification",
});

/** Commands / phrases the guide must document (copy-paste path). */
export const REQUIRED_PATTERNS = Object.freeze([
  { id: "create-sutra", re: /create-sutra/ },
  { id: "npm-install", re: /npm install/ },
  { id: "npm-smoke", re: /npm run smoke/ },
  { id: "typecheck", re: /npm run typecheck/ },
  { id: "subjectId", re: /subjectId/ },
  { id: "syncAttemptId", re: /syncAttemptId/ },
  { id: "postSync", re: /postSync|\/v1\/sync/ },
  { id: "verified-date", re: /Verified:[*\s]*20\d{2}-\d{2}-\d{2}/ },
  { id: "concurrent-turns", re: /[Cc]oncurrent turns/ },
  { id: "idempotent", re: /idempotent/i },
  { id: "no-raw-content", re: /never (put |log )?raw learner|no utterance body|Never log raw/i },
  { id: "scratch-packs", re: /scratch packs|file:.*moolam-sdk|publish:rehearsal:verify/i },
  { id: "observability-override", re: /@moolam\/observability/ },
]);

/** Public guide links — not deep package source trees. */
export const REQUIRED_LINKS = Object.freeze([
  { id: "conformance", re: /conformance-quickstart\.md/ },
  { id: "certification", re: /CERTIFIED-BINDING\.md/ },
  { id: "protocol", re: /protocol\/README\.md|Protocol README/ },
]);

/** Forbidden deep monorepo source leaks in the stranger-facing guide. */
export const FORBIDDEN_PATH_RES = Object.freeze([
  /packages\/[a-z0-9-]+\/src\//i,
  /packages\/contract-conformance\/bin\//i,
]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "docs_site.quic.implementor", ...event })}\n`,
  );
}

function parseVerifiedDate(body) {
  const m = body.match(/Verified:[*\s]*(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function validateImplementorQuickstart(opts = {}) {
  const canonicalPath = opts.canonicalPath ?? CANONICAL;
  const siteLandingPath = opts.siteLandingPath ?? SITE_LANDING;
  const now = opts.now ?? new Date();
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const violations = [];

  if (!existsSync(canonicalPath)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_CANONICAL,
      detail: "docs/sdk/implementor-quickstart.md is required",
    });
    return { status: 1, violations };
  }

  if (!existsSync(siteLandingPath)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_SITE_LANDING,
      detail: "docs-site/src/quickstarts/implementor.md is required",
    });
  }

  const body = readFileSync(canonicalPath, "utf8");
  const landing = existsSync(siteLandingPath)
    ? readFileSync(siteLandingPath, "utf8")
    : "";

  for (const pattern of REQUIRED_PATTERNS) {
    if (!pattern.re.test(body)) {
      violations.push({
        obligation: OBLIGATIONS.MISSING_SECTION,
        detail: `canonical guide missing required content: ${pattern.id}`,
      });
    }
  }

  for (const link of REQUIRED_LINKS) {
    if (!link.re.test(body)) {
      violations.push({
        obligation: OBLIGATIONS.MISSING_LINK,
        detail: `canonical guide must link ${link.id} (public docs path)`,
      });
    }
  }

  for (const re of FORBIDDEN_PATH_RES) {
    if (re.test(body)) {
      violations.push({
        obligation: OBLIGATIONS.MONOREPO_PATH_LEAK,
        detail: `canonical guide must not deep-link monorepo sources matching ${re}`,
      });
    }
  }

  if (landing && !/implementor-quickstart|\/reference\/sdk\/implementor-quickstart/.test(landing)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_LINK,
      detail: "site landing must point at the canonical implementor quickstart",
    });
  }

  const verified = parseVerifiedDate(body);
  if (!verified) {
    violations.push({
      obligation: OBLIGATIONS.STALE_VERIFICATION,
      detail: "canonical guide must include Verified: YYYY-MM-DD",
    });
  } else {
    const ageMs = now.getTime() - verified.getTime();
    const maxMs = maxAgeDays * 24 * 60 * 60 * 1000;
    if (ageMs > maxMs || ageMs < -maxMs) {
      violations.push({
        obligation: OBLIGATIONS.STALE_VERIFICATION,
        detail: `Verified date must be within the last ${maxAgeDays} days (found ${verified.toISOString().slice(0, 10)})`,
      });
    }
  }

  return {
    status: violations.length === 0 ? 0 : 1,
    violations,
  };
}

export function runImplementorQuickstartCheck(opts = {}) {
  const subjectId = opts.subjectId ?? "docs-site-quic-implementor";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;

  const result = validateImplementorQuickstart(opts);
  if (result.status !== 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "validate",
        violationCount: result.violations.length,
      });
    }
    return {
      status: 1,
      violations: result.violations,
      combined: result.violations
        .map((v) => `[${v.obligation}] ${v.detail}`)
        .join("\n"),
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "validate",
    });
  }

  return {
    status: 0,
    violations: [],
    combined: "OK: implementor quickstart guide consistent",
  };
}

function main() {
  const result = runImplementorQuickstartCheck();
  if (result.status !== 0) {
    process.stderr.write(`${result.combined}\n`);
    process.exit(result.status);
  }
  process.stdout.write(`${result.combined}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
