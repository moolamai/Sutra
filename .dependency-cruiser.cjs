/**
 * Sutra dependency-direction boundary rules (CK-01 / B-G5).
 *
 * Policy decisions (BOUNRULE-001):
 * - Type-only imports (`import type …`) count as edges for contracts-import-nothing.
 *   Enabled via `options.tsPreCompilationDeps: true`.
 * - Every violation reports the offending file and the violated edge (depcruise text/err).
 *
 * Rules:
 * 1. `ck-01-contracts-import-nothing` — packages/contracts may only depend on itself
 * 2. `no-import-domains` — domains/** is never an import target (repo-wide)
 * 3. `no-relative-cross-package-import` — cross-package edges must use @moolam/* names
 * 4. `anti-cheat-training-gym-forbidden-package-import` — training/gym may reach
 *    packages/runtime-harness only (import the harness; never fork via other pkgs)
 * 5. `anti-cheat-training-no-relative-harness-src` — training/ must not deep-import
 *    packages/runtime-harness/src (use @moolam/runtime-harness)
 * 6. `anti-cheat-training-harness-reimplementation` — content-scan id (reported by
 *    scripts/check-dependency-direction.mjs; not a depcruise edge rule)
 *
 * @type {import("dependency-cruiser").IConfiguration}
 */
const excludePath =
  "node_modules|\\.git|(/|^)(dist|build|coverage|\\.next|\\.turbo)(/|$)|agent-transcripts|terminals|(/|^)tests?(/|$)";

/** Stable rule ids — keep in sync with scripts/check-dependency-direction.mjs */
const RULE_IDS = Object.freeze({
  CONTRACTS_IMPORT_NOTHING: "ck-01-contracts-import-nothing",
  NO_IMPORT_DOMAINS: "no-import-domains",
  NO_RELATIVE_CROSS_PACKAGE: "no-relative-cross-package-import",
  ANTI_CHEAT_GYM_FORBIDDEN_PKG:
    "anti-cheat-training-gym-forbidden-package-import",
  ANTI_CHEAT_NO_RELATIVE_HARNESS_SRC:
    "anti-cheat-training-no-relative-harness-src",
  /** Content-scan rule id (not a depcruise edge — still reported as file→symbol). */
  ANTI_CHEAT_HARNESS_REIMPL: "anti-cheat-training-harness-reimplementation",
});

/** @type {import("dependency-cruiser").IConfiguration} */
const config = {
  forbidden: [
    {
      name: RULE_IDS.CONTRACTS_IMPORT_NOTHING,
      comment:
        "CK-01: @moolam/contracts/src imports nothing — runtime and type-only edges both forbidden. Offending file and import path are reported.",
      severity: "error",
      from: { path: "^packages/contracts/src" },
      to: { pathNot: "^packages/contracts/" },
    },
    {
      name: RULE_IDS.NO_IMPORT_DOMAINS,
      comment:
        "domains/** is data, not a package — no code may import it (repo-wide).",
      severity: "error",
      from: {},
      to: { path: "(^|/)domains/" },
    },
    {
      name: RULE_IDS.NO_RELATIVE_CROSS_PACKAGE,
      comment:
        "Packages must not deep-import another package's src via relative paths; use @moolam/* workspace names.",
      severity: "error",
      from: { path: "^packages/([^/]+)/" },
      to: {
        path: "^packages/",
        pathNot: "^packages/$1/",
        dependencyTypesNot: [
          "npm",
          "npm-dev",
          "npm-optional",
          "npm-peer",
          "npm-bundled",
          "npm-no-pkg",
        ],
      },
    },
    {
      name: RULE_IDS.ANTI_CHEAT_GYM_FORBIDDEN_PKG,
      comment:
        "Anti-cheat: training/gym may import packages/runtime-harness only. " +
        "Other workspace packages are forbidden — production path = training path. " +
        "See training/gym/charter.md.",
      severity: "error",
      from: { path: "^training/gym/" },
      to: {
        path: "^packages/",
        pathNot: "^packages/runtime-harness(/|$)",
      },
    },
    {
      name: RULE_IDS.ANTI_CHEAT_NO_RELATIVE_HARNESS_SRC,
      comment:
        "Anti-cheat: training/ must not deep-import packages/runtime-harness/src. " +
        "Use the @moolam/runtime-harness package export (never a local fork seam).",
      severity: "error",
      from: { path: "^training/" },
      to: { path: "packages/runtime-harness/src/" },
    },
  ],
  options: {
    doNotFollow: {
      path: excludePath,
      dependencyTypes: [
        "npm",
        "npm-dev",
        "npm-optional",
        "npm-peer",
        "npm-bundled",
        "npm-no-pkg",
      ],
    },
    exclude: {
      path: excludePath,
    },
    // Type-only imports count as edges (CK-01 / B2 PRD).
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    moduleSystems: ["es6", "cjs", "tsd"],
    tsConfig: {
      fileName: "tsconfig.base.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};

module.exports = config;
module.exports.RULE_IDS = RULE_IDS;
