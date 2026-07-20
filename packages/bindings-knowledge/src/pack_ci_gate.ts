/**
 * CI gate for flagship knowledge packs: validate-pack + domains/ freshness.
 *
 * Runs against committed knowledge-packs/* (data only — never imports domains/).
 */

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FLAGSHIP_PACK_SPECS,
  checkFlagshipPackFreshness,
  resolveRepoRoot,
  type FlagshipPackId,
  type PackBuildTelemetry,
} from "./pack_build.js";
import { type PackFormatTelemetry } from "./pack_format.js";
import {
  validatePack,
  type ValidatePackResult,
} from "./pack_validator.js";

/** Fixed check clock compatible with committed flagship pack builtAt stamps. */
export const FLAGSHIP_PACKS_CI_NOW_MS = Date.parse("2026-07-15T00:00:00.000Z");

export const FLAGSHIP_PACK_IDS = Object.keys(
  FLAGSHIP_PACK_SPECS,
) as FlagshipPackId[];

export type FlagshipPacksCiTelemetry = {
  event: "bindings_knowledge.flagship_packs_ci";
  op: "validate" | "freshness" | "gate" | "prove";
  outcome: "ok" | "error" | "red" | "green";
  subjectId: string;
  deviceId: string;
  pack?: FlagshipPackId;
  packId?: string;
  failureClass?: string;
  detail?: string;
};

type GateTelemetry =
  | FlagshipPacksCiTelemetry
  | PackBuildTelemetry
  | PackFormatTelemetry;

export type FlagshipPackGateRow = {
  pack: FlagshipPackId;
  validateOk: boolean;
  freshnessOk: boolean;
  packId?: string;
  passageCount?: number;
  sourceFingerprint?: string;
  failureClass?: string;
  detail?: string;
};

export type FlagshipPacksCiGateResult = {
  ok: boolean;
  subjectId: string;
  deviceId: string;
  rows: FlagshipPackGateRow[];
  failures: string[];
};

export type FlagshipPacksCiGateOptions = {
  repoRoot?: string;
  subjectId?: string;
  deviceId?: string;
  nowMs?: number;
  /** Limit to one pack (default: all flagship packs). */
  packIds?: FlagshipPackId[];
  onTelemetry?: (e: GateTelemetry) => void;
};

function emit(
  onTelemetry: ((e: GateTelemetry) => void) | undefined,
  partial: Omit<FlagshipPacksCiTelemetry, "event">,
): void {
  onTelemetry?.({
    event: "bindings_knowledge.flagship_packs_ci",
    ...partial,
  });
}

/**
 * Validate each flagship pack and assert provenance freshness vs domains/.
 */
export function runFlagshipPacksCiGate(
  options: FlagshipPacksCiGateOptions = {},
): FlagshipPacksCiGateResult {
  const subjectId = options.subjectId?.trim() || "subj.pack.ci.gate";
  const deviceId = options.deviceId?.trim() || "dev-pack-ci";
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const nowMs = options.nowMs ?? FLAGSHIP_PACKS_CI_NOW_MS;
  const packIds = options.packIds ?? FLAGSHIP_PACK_IDS;
  const rows: FlagshipPackGateRow[] = [];
  const failures: string[] = [];

  emit(options.onTelemetry, {
    op: "gate",
    outcome: "ok",
    subjectId,
    deviceId,
    detail: "start",
  });

  for (const pack of packIds) {
    const spec = FLAGSHIP_PACK_SPECS[pack];
    const packRoot = path.resolve(repoRoot, spec.outRelpath);
    const row: FlagshipPackGateRow = {
      pack,
      validateOk: false,
      freshnessOk: false,
    };

    const validated: ValidatePackResult = validatePack(packRoot, {
      subjectId: `${subjectId}.${pack}`,
      deviceId,
      nowMs,
      ...(options.onTelemetry !== undefined
        ? {
            onTelemetry: (e: PackFormatTelemetry) => {
              options.onTelemetry?.(e);
            },
          }
        : {}),
    });

    if (!validated.ok) {
      row.validateOk = false;
      row.failureClass = validated.failureClass;
      row.detail = validated.message;
      failures.push(`${pack}: validatePack failed: ${validated.message}`);
      emit(options.onTelemetry, {
        op: "validate",
        outcome: "error",
        subjectId,
        deviceId,
        pack,
        failureClass: validated.failureClass,
        detail: validated.message,
      });
    } else {
      row.validateOk = true;
      row.packId = validated.value.manifest.packId;
      row.passageCount = validated.value.passageCount;
      emit(options.onTelemetry, {
        op: "validate",
        outcome: "ok",
        subjectId,
        deviceId,
        pack,
        packId: validated.value.manifest.packId,
      });
    }

    const fresh = checkFlagshipPackFreshness(spec, {
      repoRoot,
      packRoot,
      subjectId: `${subjectId}.${pack}.fresh`,
      deviceId,
      ...(options.onTelemetry !== undefined
        ? {
            onTelemetry: (e: PackBuildTelemetry) => {
              options.onTelemetry?.(e);
            },
          }
        : {}),
    });

    if (!fresh.ok) {
      row.freshnessOk = false;
      row.failureClass = row.failureClass ?? fresh.failureClass;
      row.detail = row.detail ?? fresh.message;
      failures.push(`${pack}: freshness failed: ${fresh.message}`);
      emit(options.onTelemetry, {
        op: "freshness",
        outcome: "error",
        subjectId,
        deviceId,
        pack,
        failureClass: fresh.failureClass,
        detail: fresh.message,
      });
    } else {
      row.freshnessOk = true;
      row.sourceFingerprint = fresh.sourceFingerprint;
      emit(options.onTelemetry, {
        op: "freshness",
        outcome: "ok",
        subjectId,
        deviceId,
        pack,
        detail: fresh.sourceFingerprint,
      });
    }

    rows.push(row);
  }

  const ok = failures.length === 0;
  emit(options.onTelemetry, {
    op: "gate",
    outcome: ok ? "ok" : "error",
    subjectId,
    deviceId,
    detail: ok ? "pass" : (failures[0] ?? "gate_failed"),
  });

  return { ok, subjectId, deviceId, rows, failures };
}

export type ProveFlagshipPacksCiResult = {
  ok: boolean;
  greenOk: boolean;
  staleRedOk: boolean;
  uncitedRedOk: boolean;
  failures: string[];
};

/**
 * Prove gate red→green: committed packs green; stale fingerprint red; uncited red.
 */
export function proveFlagshipPacksCiGate(
  options: FlagshipPacksCiGateOptions = {},
): ProveFlagshipPacksCiResult {
  const subjectId = options.subjectId?.trim() || "subj.pack.ci.prove";
  const deviceId = options.deviceId?.trim() || "dev-pack-ci-prove";
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const nowMs = options.nowMs ?? FLAGSHIP_PACKS_CI_NOW_MS;
  const failures: string[] = [];
  const events: GateTelemetry[] = [];
  const onTelemetry = (e: GateTelemetry) => {
    events.push(e);
    options.onTelemetry?.(e);
  };

  const green = runFlagshipPacksCiGate({
    repoRoot,
    subjectId: `${subjectId}.green`,
    deviceId,
    nowMs,
    onTelemetry,
  });
  const greenOk = green.ok === true;
  if (!greenOk) {
    failures.push(`expected green gate on committed packs: ${green.failures.join("; ")}`);
  }
  emit(onTelemetry, {
    op: "prove",
    outcome: greenOk ? "green" : "error",
    subjectId,
    deviceId,
    detail: greenOk
      ? "committed_packs_ok"
      : (green.failures[0] ?? "green_failed"),
  });

  // Stale fingerprint: copy doctor pack + mutate domains source under a temp repo.
  let staleRedOk = false;
  const tmpStale = mkdtempSync(path.join(tmpdir(), "flagship-ci-stale-"));
  try {
    const spec = FLAGSHIP_PACK_SPECS["doctor-formulary-sketch"];
    const srcRel = spec.sourceRelpath.replace(/\\/g, "/");
    const outRel = spec.outRelpath.replace(/\\/g, "/");
    const srcAbs = path.join(repoRoot, ...srcRel.split("/"));
    const packAbs = path.join(repoRoot, ...outRel.split("/"));
    const tmpSrcDir = path.join(tmpStale, path.dirname(srcRel));
    const tmpPackDir = path.join(tmpStale, outRel);
    mkdirSync(tmpSrcDir, { recursive: true });
    mkdirSync(tmpPackDir, { recursive: true });
    copyFileSync(srcAbs, path.join(tmpStale, ...srcRel.split("/")));
    for (const name of ["manifest.json", "provenance.json"]) {
      copyFileSync(
        path.join(packAbs, name),
        path.join(tmpPackDir, name),
      );
    }
    mkdirSync(path.join(tmpPackDir, "content"), { recursive: true });
    copyFileSync(
      path.join(packAbs, "content", "shard-formulary.json"),
      path.join(tmpPackDir, "content", "shard-formulary.json"),
    );

    // Mutate domain source so fingerprint drifts without rebuilding provenance.
    const tmpSrc = path.join(tmpStale, ...srcRel.split("/"));
    writeFileSync(
      tmpSrc,
      `${readFileSync(tmpSrc, "utf8")}\n<!-- ci-prove-stale -->\n`,
      "utf8",
    );

    const stale = runFlagshipPacksCiGate({
      repoRoot: tmpStale,
      subjectId: `${subjectId}.stale`,
      deviceId,
      nowMs,
      packIds: ["doctor-formulary-sketch"],
      onTelemetry,
    });
    staleRedOk = stale.ok === false &&
      stale.failures.some((f) => /freshness|fingerprint|stale/i.test(f));
    if (!staleRedOk) {
      failures.push(
        `expected stale fingerprint to fail gate, got ok=${stale.ok} failures=${JSON.stringify(stale.failures)}`,
      );
    }
    emit(onTelemetry, {
      op: "prove",
      outcome: staleRedOk ? "red" : "error",
      subjectId,
      deviceId,
      pack: "doctor-formulary-sketch",
      detail: staleRedOk ? "stale_fingerprint_red" : "stale_prove_miss",
    });
  } finally {
    rmSync(tmpStale, { recursive: true, force: true });
  }

  // Uncited: copy teacher pack and break a citation sourceId.
  let uncitedRedOk = false;
  const tmpUncited = mkdtempSync(path.join(tmpdir(), "flagship-ci-uncited-"));
  try {
    const spec = FLAGSHIP_PACK_SPECS["teacher-cbse-slice"];
    const srcRel = spec.sourceRelpath.replace(/\\/g, "/");
    const outRel = spec.outRelpath.replace(/\\/g, "/");
    const packAbs = path.join(repoRoot, ...outRel.split("/"));
    const tmpSrcDir = path.join(tmpUncited, path.dirname(srcRel));
    const tmpPackDir = path.join(tmpUncited, outRel);
    mkdirSync(tmpSrcDir, { recursive: true });
    mkdirSync(path.join(tmpPackDir, "content"), { recursive: true });
    copyFileSync(
      path.join(repoRoot, ...srcRel.split("/")),
      path.join(tmpUncited, ...srcRel.split("/")),
    );
    for (const name of ["manifest.json", "provenance.json"]) {
      copyFileSync(path.join(packAbs, name), path.join(tmpPackDir, name));
    }
    const shardName = "shard-ratios.json";
    const shard = JSON.parse(
      readFileSync(path.join(packAbs, "content", shardName), "utf8"),
    );
    if (Array.isArray(shard.passages) && shard.passages[0]?.citation) {
      shard.passages[0].citation.sourceId = "src.missing.uncited";
    }
    writeFileSync(
      path.join(tmpPackDir, "content", shardName),
      `${JSON.stringify(shard, null, 2)}\n`,
      "utf8",
    );

    const uncited = runFlagshipPacksCiGate({
      repoRoot: tmpUncited,
      subjectId: `${subjectId}.uncited`,
      deviceId,
      nowMs,
      packIds: ["teacher-cbse-slice"],
      onTelemetry,
    });
    uncitedRedOk =
      uncited.ok === false &&
      uncited.failures.some((f) => /validatePack|citation|sourceId/i.test(f));
    if (!uncitedRedOk) {
      failures.push(
        `expected uncited pack to fail validate, got ok=${uncited.ok} failures=${JSON.stringify(uncited.failures)}`,
      );
    }
    emit(onTelemetry, {
      op: "prove",
      outcome: uncitedRedOk ? "red" : "error",
      subjectId,
      deviceId,
      pack: "teacher-cbse-slice",
      detail: uncitedRedOk ? "uncited_red" : "uncited_prove_miss",
    });
  } finally {
    rmSync(tmpUncited, { recursive: true, force: true });
  }

  // Telemetry must not leak pack passage bodies.
  const blob = JSON.stringify(events);
  if (
    blob.includes("Paracetamol") ||
    blob.includes("warfarin") ||
    blob.includes("3:4 and 6:8")
  ) {
    failures.push("telemetry leaked passage content");
  }

  const ok = greenOk && staleRedOk && uncitedRedOk && failures.length === 0;
  emit(onTelemetry, {
    op: "prove",
    outcome: ok ? "green" : "error",
    subjectId,
    deviceId,
    detail: ok ? "red_green_pass" : (failures[0] ?? "prove_failed"),
  });

  return { ok, greenOk, staleRedOk, uncitedRedOk, failures };
}

export type FlagshipPacksCiIo = {
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};

/**
 * CI entry: exit 0 when all flagship packs validate and are fresh.
 */
export function runFlagshipPacksCiGateCli(
  argv: readonly string[],
  io: FlagshipPacksCiIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    io.stdout.write(
      `Usage: ci-flagship-packs [--prove]\n\n` +
        `Validate knowledge-packs flagship trees and check domains/ fingerprints.\n`,
    );
    return 0;
  }

  const prove = argv.includes("--prove");
  const subjectId = "subj.pack.ci.cli";
  const deviceId = "dev-pack-ci-cli";

  if (prove) {
    const result = proveFlagshipPacksCiGate({ subjectId, deviceId });
    const line = JSON.stringify({
      event: "bindings_knowledge.flagship_packs_ci",
      op: "prove",
      outcome: result.ok ? "ok" : "error",
      greenOk: result.greenOk,
      staleRedOk: result.staleRedOk,
      uncitedRedOk: result.uncitedRedOk,
      failures: result.failures,
      subjectId,
      deviceId,
    });
    if (result.ok) {
      io.stdout.write(`${line}\n`);
      return 0;
    }
    io.stderr.write(`${line}\n`);
    return 1;
  }

  const result = runFlagshipPacksCiGate({ subjectId, deviceId });
  const line = JSON.stringify({
    event: "bindings_knowledge.flagship_packs_ci",
    op: "gate",
    outcome: result.ok ? "ok" : "error",
    rows: result.rows.map((r) => ({
      pack: r.pack,
      validateOk: r.validateOk,
      freshnessOk: r.freshnessOk,
      packId: r.packId,
      passageCount: r.passageCount,
    })),
    failures: result.failures,
    subjectId,
    deviceId,
  });
  if (result.ok) {
    io.stdout.write(`${line}\n`);
    return 0;
  }
  io.stderr.write(`${line}\n`);
  return 1;
}

/** Soft assert helpers used by tests (pack trees must exist). */
export function assertFlagshipPackTreesPresent(
  repoRoot: string = resolveRepoRoot(),
): void {
  for (const id of FLAGSHIP_PACK_IDS) {
    const root = path.resolve(repoRoot, FLAGSHIP_PACK_SPECS[id].outRelpath);
    if (!existsSync(path.join(root, "manifest.json"))) {
      throw new Error(`missing flagship pack manifest: ${root}`);
    }
    if (!existsSync(path.join(root, "provenance.json"))) {
      throw new Error(`missing flagship pack provenance: ${root}`);
    }
  }
}
