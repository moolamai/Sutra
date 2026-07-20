/**
 * Gate for conformance stub + binding certification guides (QUIC-002).
 *
 * Usage (repo root):
 *   node scripts/check-quic-conformance-binding-guides.mjs
 *   pnpm quic-guides:check
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const CONFORMANCE_CANONICAL = path.join(
  REPO_ROOT,
  "docs",
  "sdk",
  "conformance-stub-guide.md",
);
export const BINDING_CANONICAL = path.join(
  REPO_ROOT,
  "docs",
  "sdk",
  "binding-certification-guide.md",
);
export const CONFORMANCE_LANDING = path.join(
  REPO_ROOT,
  "docs-site",
  "src",
  "quickstarts",
  "conformance.md",
);
export const BINDING_LANDING = path.join(
  REPO_ROOT,
  "docs-site",
  "src",
  "quickstarts",
  "binding-certification.md",
);

export const OBLIGATIONS = Object.freeze({
  MISSING_CANONICAL: "docs_site.quic.guides.missing_canonical",
  MISSING_SITE_LANDING: "docs_site.quic.guides.missing_site_landing",
  MISSING_SECTION: "docs_site.quic.guides.missing_section",
  MONOREPO_PATH_LEAK: "docs_site.quic.guides.monorepo_path_leak",
  MISSING_LINK: "docs_site.quic.guides.missing_link",
  STALE_VERIFICATION: "docs_site.quic.guides.stale_verification",
});

/** Forbidden deep monorepo source leaks in stranger-facing guides. */
export const FORBIDDEN_PATH_RES = Object.freeze([
  /packages\/[a-z0-9-]+\/src\//i,
]);

const CONFORMANCE_PATTERNS = Object.freeze([
  { id: "conformance-cli", re: /pnpm exec conformance|conformance --self-check/ },
  { id: "stub-factory", re: /createStubMemoryHarnessFactory|stub/i },
  { id: "runConformance", re: /runConformance/ },
  { id: "subjectId", re: /subjectId/ },
  { id: "verified-date", re: /Verified:[*\s]*20\d{2}-\d{2}-\d{2}/ },
  { id: "pass-fail", re: /pass\/fail|outcome.*pass|exit \*\*0\*\*/i },
  { id: "concurrent", re: /[Cc]oncurrent/ },
  { id: "idempotent", re: /idempotent/i },
  { id: "no-raw-content", re: /never (put |embed )?raw learner|never utterance|synthetic `probe\.\*`/i },
]);

const CONFORMANCE_LINKS = Object.freeze([
  { id: "binding-guide", re: /binding-certification-guide\.md/ },
  { id: "certified-binding", re: /CERTIFIED-BINDING\.md/ },
]);

const BINDING_PATTERNS = Object.freeze([
  { id: "certify", re: /run certify|bindings-slm certify|certify --profile/ },
  { id: "ck-03", re: /CK-03\.[123]/ },
  { id: "locality", re: /egressRecord|B1|locality/i },
  { id: "pass-fail", re: /Pass \(green\)|Fail \(red\)|outcome.: .pass/i },
  { id: "subjectId", re: /subjectId/ },
  { id: "verified-date", re: /Verified:[*\s]*20\d{2}-\d{2}-\d{2}/ },
  { id: "idempotent", re: /idempotent/i },
  { id: "no-content-bodies", re: /never.*utterance|no content bodies|prompt bodies/i },
]);

const BINDING_LINKS = Object.freeze([
  { id: "conformance-stub", re: /conformance-stub-guide\.md/ },
  { id: "certified-binding", re: /CERTIFIED-BINDING\.md/ },
]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "docs_site.quic.guides", ...event })}\n`,
  );
}

function parseVerifiedDate(body) {
  const m = body.match(/Verified:[*\s]*(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function checkGuide(opts) {
  const {
    label,
    canonicalPath,
    landingPath,
    patterns,
    links,
    landingNeedle,
    now,
    maxAgeDays,
  } = opts;
  const violations = [];

  if (!existsSync(canonicalPath)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_CANONICAL,
      detail: `${label}: missing ${path.relative(REPO_ROOT, canonicalPath).replace(/\\/g, "/")}`,
    });
    return violations;
  }

  if (!existsSync(landingPath)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_SITE_LANDING,
      detail: `${label}: missing site landing`,
    });
  }

  const body = readFileSync(canonicalPath, "utf8");
  const landing = existsSync(landingPath) ? readFileSync(landingPath, "utf8") : "";

  for (const pattern of patterns) {
    if (!pattern.re.test(body)) {
      violations.push({
        obligation: OBLIGATIONS.MISSING_SECTION,
        detail: `${label}: missing required content: ${pattern.id}`,
      });
    }
  }

  for (const link of links) {
    if (!link.re.test(body)) {
      violations.push({
        obligation: OBLIGATIONS.MISSING_LINK,
        detail: `${label}: must link ${link.id}`,
      });
    }
  }

  for (const re of FORBIDDEN_PATH_RES) {
    if (re.test(body)) {
      violations.push({
        obligation: OBLIGATIONS.MONOREPO_PATH_LEAK,
        detail: `${label}: must not deep-link package src trees`,
      });
    }
  }

  if (landing && landingNeedle && !landingNeedle.test(landing)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_LINK,
      detail: `${label}: site landing must point at canonical guide`,
    });
  }

  const verified = parseVerifiedDate(body);
  if (!verified) {
    violations.push({
      obligation: OBLIGATIONS.STALE_VERIFICATION,
      detail: `${label}: must include Verified: YYYY-MM-DD`,
    });
  } else {
    const ageMs = now.getTime() - verified.getTime();
    const maxMs = maxAgeDays * 24 * 60 * 60 * 1000;
    if (ageMs > maxMs || ageMs < -maxMs) {
      violations.push({
        obligation: OBLIGATIONS.STALE_VERIFICATION,
        detail: `${label}: Verified date must be within the last ${maxAgeDays} days`,
      });
    }
  }

  return violations;
}

export function validateQuicConformanceBindingGuides(opts = {}) {
  const now = opts.now ?? new Date();
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const violations = [];

  violations.push(
    ...checkGuide({
      label: "conformance-stub",
      canonicalPath: opts.conformanceCanonical ?? CONFORMANCE_CANONICAL,
      landingPath: opts.conformanceLanding ?? CONFORMANCE_LANDING,
      patterns: CONFORMANCE_PATTERNS,
      links: CONFORMANCE_LINKS,
      landingNeedle: /conformance-stub-guide/,
      now,
      maxAgeDays,
    }),
  );

  violations.push(
    ...checkGuide({
      label: "binding-certification",
      canonicalPath: opts.bindingCanonical ?? BINDING_CANONICAL,
      landingPath: opts.bindingLanding ?? BINDING_LANDING,
      patterns: BINDING_PATTERNS,
      links: BINDING_LINKS,
      landingNeedle: /binding-certification-guide/,
      now,
      maxAgeDays,
    }),
  );

  return {
    status: violations.length === 0 ? 0 : 1,
    violations,
  };
}

export function runQuicConformanceBindingGuidesCheck(opts = {}) {
  const subjectId = opts.subjectId ?? "docs-site-quic-guides";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;

  const result = validateQuicConformanceBindingGuides(opts);
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
    combined: "OK: conformance stub + binding certification guides consistent",
  };
}

function main() {
  const result = runQuicConformanceBindingGuidesCheck();
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
