/**
 * Template copy and placeholder substitution for create-sutra.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_VERSION_RANGE, validateChoices } from "./choices.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_ROOT = path.resolve(__dirname, "..");
export const TEMPLATES_ROOT = path.join(TOOL_ROOT, "templates");

export const OBLIGATIONS = Object.freeze({
  CHOICES_INVALID: "create_sutra.choices.invalid",
  OUTPUT_EXISTS: "create_sutra.output.exists",
  TEMPLATE_MISSING: "create_sutra.template.missing",
  WORKSPACE_PROTOCOL: "create_sutra.package.workspace_protocol",
  SDK_DEPENDENCY_MISSING: "create_sutra.package.sdk_missing",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "create_sutra.scaffold", ...event })}\n`,
  );
}

export function substitutePlaceholders(text, vars) {
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, String(value));
  }
  return out;
}

export function buildSubstitutionVars(resolved) {
  const pack = resolved.domainPack;
  return {
    PROJECT_NAME: resolved.projectName,
    DOMAIN_PACK: pack.id,
    DOMAIN_ID: pack.domainId,
    PACK_ID: pack.packId,
    DOMAIN_CHARTER: pack.charter,
    DOMAIN_REFUSALS_JSON: JSON.stringify(pack.refusals),
    DOMAIN_LANGUAGES_JSON: JSON.stringify(pack.languages),
    TASK_GRAPH_JSON: JSON.stringify(pack.taskGraph, null, 2),
    STORAGE_DRIVER: resolved.storageDriver.id,
    TRANSPORT: resolved.transport.id,
    SDK_VERSION: SDK_VERSION_RANGE,
  };
}

export function copyTemplateTree(srcDir, destDir, vars, opts = {}) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, entry);
    const destName = entry.replace(/\.template$/u, "");
    const destPath = path.join(destDir, destName);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyTemplateTree(srcPath, destPath, vars, opts);
      continue;
    }
    if (!entry.endsWith(".template")) {
      if (opts.skipNonTemplate) continue;
      cpSync(srcPath, destPath);
      continue;
    }
    const text = readFileSync(srcPath, "utf8");
    writeFileSync(destPath, substitutePlaceholders(text, vars));
  }
}

export function writeBindingStubs(outDir, resolved) {
  const bindingsDir = path.join(outDir, "src", "bindings");
  mkdirSync(bindingsDir, { recursive: true });

  const storageSrc = path.join(
    TEMPLATES_ROOT,
    "bindings",
    resolved.storageDriver.templateFile,
  );
  const transportSrc = path.join(
    TEMPLATES_ROOT,
    "bindings",
    resolved.transport.templateFile,
  );

  if (!existsSync(storageSrc)) {
    throw new Error(`${OBLIGATIONS.TEMPLATE_MISSING}: ${storageSrc}`);
  }
  if (!existsSync(transportSrc)) {
    throw new Error(`${OBLIGATIONS.TEMPLATE_MISSING}: ${transportSrc}`);
  }

  copyFileSync(storageSrc, path.join(bindingsDir, "storage.ts"));
  copyFileSync(transportSrc, path.join(bindingsDir, "transport.ts"));
}

export function validateGeneratedPackageJson(outDir) {
  const violations = [];
  const pkgPath = path.join(outDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

  const sdkDep = pkg.dependencies?.["sutra-sdk"];
  if (!sdkDep) {
    violations.push({
      obligation: OBLIGATIONS.SDK_DEPENDENCY_MISSING,
      detail: "package.json must depend on sutra-sdk",
    });
  } else if (String(sdkDep).startsWith("workspace:")) {
    violations.push({
      obligation: OBLIGATIONS.WORKSPACE_PROTOCOL,
      detail: "sutra-sdk must use a semver range, not workspace: protocol",
    });
  }

  return { status: violations.length === 0 ? 0 : 1, violations, pkg };
}

export function runCreateSutraScaffold(opts = {}) {
  const subjectId = opts.subjectId ?? "create-sutra-scaffold";
  const deviceId = opts.deviceId ?? "cli";
  const emitEvents = opts.emitEvents !== false;
  const outDir = path.resolve(opts.outDir ?? path.join(process.cwd(), opts.projectName ?? ""));
  const overwrite = opts.overwrite === true;

  const validated = validateChoices({
    projectName: opts.projectName,
    domainPack: opts.domainPack,
    storageDriver: opts.storageDriver,
    transport: opts.transport,
  });

  if (validated.status !== 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "choices",
        violationCount: validated.violations.length,
      });
    }
    return {
      status: 1,
      phase: "choices",
      violations: validated.violations,
      combined: formatViolations(validated.violations),
    };
  }

  if (existsSync(outDir) && !overwrite) {
    const violation = {
      obligation: OBLIGATIONS.OUTPUT_EXISTS,
      detail: `output directory already exists: ${outDir}`,
    };
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "output",
        obligation: violation.obligation,
      });
    }
    return {
      status: 1,
      phase: "output",
      violations: [violation],
      combined: formatViolations([violation]),
    };
  }

  const vars = buildSubstitutionVars(validated.resolved);
  mkdirSync(outDir, { recursive: true });

  try {
    copyTemplateTree(path.join(TEMPLATES_ROOT, "project"), outDir, vars);
    writeBindingStubs(outDir, validated.resolved);
  } catch (err) {
    const detail = String(err);
    const obligation = detail.includes(OBLIGATIONS.TEMPLATE_MISSING)
      ? OBLIGATIONS.TEMPLATE_MISSING
      : "create_sutra.scaffold.failed";
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "template",
      });
    }
    return {
      status: 1,
      phase: "template",
      violations: [{ obligation, detail }],
      combined: `CREATE_SUTRA_FAILED: ${detail}`,
    };
  }

  const pkgCheck = validateGeneratedPackageJson(outDir);
  if (pkgCheck.status !== 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "package",
        violationCount: pkgCheck.violations.length,
      });
    }
    return {
      status: 1,
      phase: "package",
      violations: pkgCheck.violations,
      combined: formatViolations(pkgCheck.violations),
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "scaffold",
      projectName: validated.resolved.projectName,
      domainPack: validated.resolved.domainPack.id,
      storageDriver: validated.resolved.storageDriver.id,
      transport: validated.resolved.transport.id,
      outDir,
    });
  }

  return {
    status: 0,
    phase: "scaffold",
    outDir,
    projectName: validated.resolved.projectName,
    combined: `OK: scaffolded ${validated.resolved.projectName} at ${outDir}`,
  };
}

function formatViolations(violations) {
  return `CREATE_SUTRA_FAILED (${violations.length} violation(s)):\n${violations
    .map((v) => `[${v.obligation}] ${v.detail}`)
    .join("\n")}`;
}
