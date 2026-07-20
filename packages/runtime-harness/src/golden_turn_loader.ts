/**
 * Load imported A P6 golden-turn fixture bytes for B4 parser replay / CI.
 *
 * Fixtures live under `fixtures/golden-turns/` (synced from sync-protocol).
 * Expected outputs are the committed A P6 bytes — never hand-edited here.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeGoldenTurn,
  goldenTurnCorpusManifestSchema,
  goldenTurnFixtureSchema,
  validateGoldenTurnCorpus,
  type GoldenTurnCorpusManifest,
  type GoldenTurnFixture,
} from "@moolam/sync-protocol";

/** Package-relative path of imported A P6 golden-turn fixtures. */
export const A_P6_GOLDEN_TURNS_FIXTURE_RELPATH = "fixtures/golden-turns" as const;

export type GoldenTurnLoadFailureClass =
  | "missing_corpus"
  | "missing_manifest"
  | "missing_fixture"
  | "schema_violation"
  | "canonical_drift"
  | "upstream_drift"
  | "missing_subject"
  | "cross_subject";

export type GoldenTurnLoadTelemetryEvent = {
  event: "runtime.harness.golden_load";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  turnCount?: number;
  failureClass?: GoldenTurnLoadFailureClass;
};

export type GoldenTurnCorpusLoaded = {
  ok: true;
  manifest: GoldenTurnCorpusManifest;
  fixtures: GoldenTurnFixture[];
  /** Raw on-disk file text (LF-normalized) keyed by turn id. */
  rawById: Record<string, string>;
  fixtureDir: string;
  subjectIds: string[];
};

export type GoldenTurnCorpusLoadRejected = {
  ok: false;
  failureClass: GoldenTurnLoadFailureClass;
  issuePath: string;
  detail: string;
  subjectId: string | null;
};

export type GoldenTurnCorpusLoadResult =
  | GoldenTurnCorpusLoaded
  | GoldenTurnCorpusLoadRejected;

export type LoadGoldenTurnCorpusOptions = {
  /**
   * Absolute path to imported fixtures. Defaults to this package's
   * `fixtures/golden-turns`.
   */
  fixtureDir?: string;
  /**
   * Absolute path to upstream A P6 goldens for parity check.
   * Defaults to sibling `sync-protocol/fixtures/golden-turns`.
   */
  upstreamDir?: string;
  /** When true (default), fail if A P6 has turns not present locally. */
  requireUpstreamParity?: boolean;
  deviceId?: string;
  onTelemetry?: (event: GoldenTurnLoadTelemetryEvent) => void;
};

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveGoldenTurnFixtureDir(override?: string): string {
  if (typeof override === "string" && override.trim()) return override.trim();
  return join(packageRoot(), A_P6_GOLDEN_TURNS_FIXTURE_RELPATH);
}

export function resolveUpstreamGoldenTurnDir(override?: string): string {
  if (typeof override === "string" && override.trim()) return override.trim();
  return join(
    packageRoot(),
    "..",
    "sync-protocol",
    "fixtures",
    "golden-turns",
  );
}

function reject(
  failureClass: GoldenTurnLoadFailureClass,
  issuePath: string,
  detail: string,
  subjectId: string | null,
  opts?: LoadGoldenTurnCorpusOptions,
): GoldenTurnCorpusLoadRejected {
  opts?.onTelemetry?.({
    event: "runtime.harness.golden_load",
    outcome: "rejected",
    subjectId,
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    failureClass,
  });
  return { ok: false, failureClass, issuePath, detail, subjectId };
}

/**
 * Load the imported A P6 golden-turn corpus. Shared by parser tests and CI.
 * Validates schema, canonical on-disk form, subject scope, and upstream parity.
 */
export function loadGoldenTurnCorpus(
  opts: LoadGoldenTurnCorpusOptions = {},
): GoldenTurnCorpusLoadResult {
  const fixtureDir = resolveGoldenTurnFixtureDir(opts.fixtureDir);
  const requireUpstreamParity = opts.requireUpstreamParity !== false;

  if (!existsSync(fixtureDir)) {
    return reject(
      "missing_corpus",
      "fixtureDir",
      `golden fixture dir missing: ${fixtureDir}`,
      null,
      opts,
    );
  }

  const manifestPath = join(fixtureDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return reject(
      "missing_manifest",
      "manifest.json",
      "manifest.json required in golden-turns fixtures",
      null,
      opts,
    );
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return reject(
      "schema_violation",
      "manifest.json",
      "manifest.json is not valid JSON",
      null,
      opts,
    );
  }

  const manifestParsed = goldenTurnCorpusManifestSchema.safeParse(manifestRaw);
  if (!manifestParsed.success) {
    return reject(
      "schema_violation",
      "manifest.json",
      manifestParsed.error.issues[0]?.message ?? "invalid manifest",
      null,
      opts,
    );
  }
  const manifest = manifestParsed.data;

  const fixtures: GoldenTurnFixture[] = [];
  const rawById: Record<string, string> = {};
  const rawFiles: Array<{ id: string; raw: string }> = [];

  for (const entry of manifest.turns) {
    const filePath = join(fixtureDir, entry.file);
    if (!existsSync(filePath)) {
      return reject(
        "missing_fixture",
        entry.file,
        `manifest lists missing fixture ${entry.file}`,
        null,
        opts,
      );
    }
    const raw = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return reject(
        "schema_violation",
        entry.file,
        "fixture is not valid JSON",
        null,
        opts,
      );
    }
    const parsed = goldenTurnFixtureSchema.safeParse(json);
    if (!parsed.success) {
      return reject(
        "schema_violation",
        entry.file,
        parsed.error.issues[0]?.message ?? "invalid golden fixture",
        typeof (json as { subjectId?: string })?.subjectId === "string"
          ? (json as { subjectId: string }).subjectId
          : null,
        opts,
      );
    }
    if (parsed.data.id !== entry.id) {
      return reject(
        "schema_violation",
        entry.file,
        `fixture id '${parsed.data.id}' != manifest id '${entry.id}'`,
        parsed.data.subjectId,
        opts,
      );
    }
    // Frames must stay subject-scoped (sovereignty).
    for (const [i, frame] of parsed.data.expectedFrames.entries()) {
      if (frame.subjectId !== parsed.data.subjectId) {
        return reject(
          "cross_subject",
          `${entry.file}.expectedFrames[${i}].subjectId`,
          "frame subjectId must match fixture subjectId",
          parsed.data.subjectId,
          opts,
        );
      }
    }
    fixtures.push(parsed.data);
    rawById[parsed.data.id] = raw;
    rawFiles.push({ id: parsed.data.id, raw });
  }

  const corpus = validateGoldenTurnCorpus(fixtures, {
    ...(fixtures[0]?.subjectId !== undefined
      ? { subjectId: fixtures[0].subjectId }
      : {}),
    rawFiles,
  });
  if (!corpus.ok) {
    return reject(
      corpus.failureClass === "canonical_drift"
        ? "canonical_drift"
        : corpus.failureClass === "missing_subject"
          ? "missing_subject"
          : "schema_violation",
      corpus.issuePath,
      corpus.detail,
      fixtures[0]?.subjectId ?? null,
      opts,
    );
  }

  if (requireUpstreamParity) {
    const upstreamDir = resolveUpstreamGoldenTurnDir(opts.upstreamDir);
    if (!existsSync(upstreamDir)) {
      return reject(
        "upstream_drift",
        "upstreamDir",
        `A P6 upstream golden dir missing: ${upstreamDir}`,
        fixtures[0]?.subjectId ?? null,
        opts,
      );
    }
    const upstreamManifestPath = join(upstreamDir, "manifest.json");
    if (!existsSync(upstreamManifestPath)) {
      return reject(
        "upstream_drift",
        "upstream/manifest.json",
        "A P6 upstream manifest missing",
        fixtures[0]?.subjectId ?? null,
        opts,
      );
    }
    const upstreamManifest = goldenTurnCorpusManifestSchema.safeParse(
      JSON.parse(readFileSync(upstreamManifestPath, "utf8")),
    );
    if (!upstreamManifest.success) {
      return reject(
        "upstream_drift",
        "upstream/manifest.json",
        "A P6 upstream manifest invalid",
        fixtures[0]?.subjectId ?? null,
        opts,
      );
    }
    const localIds = new Set(manifest.turns.map((t) => t.id));
    for (const turn of upstreamManifest.data.turns) {
      if (!localIds.has(turn.id)) {
        return reject(
          "upstream_drift",
          turn.id,
          `A P6 added golden '${turn.id}' — sync into runtime-harness before CI`,
          fixtures[0]?.subjectId ?? null,
          opts,
        );
      }
      const upPath = join(upstreamDir, turn.file);
      const localPath = join(fixtureDir, turn.file);
      if (!existsSync(upPath) || !existsSync(localPath)) {
        return reject(
          "upstream_drift",
          turn.file,
          `missing bytes for golden '${turn.id}'`,
          fixtures[0]?.subjectId ?? null,
          opts,
        );
      }
      const upText = readFileSync(upPath, "utf8").replace(/\r\n/g, "\n");
      const localText = readFileSync(localPath, "utf8").replace(/\r\n/g, "\n");
      if (upText !== localText) {
        return reject(
          "upstream_drift",
          turn.file,
          `local golden '${turn.id}' is not byte-identical to A P6`,
          fixtures[0]?.subjectId ?? null,
          opts,
        );
      }
    }
  }

  const subjectIds = [...new Set(fixtures.map((f) => f.subjectId))];
  opts.onTelemetry?.({
    event: "runtime.harness.golden_load",
    outcome: "ok",
    subjectId: subjectIds[0] ?? null,
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    turnCount: fixtures.length,
  });

  return {
    ok: true,
    manifest,
    fixtures,
    rawById,
    fixtureDir,
    subjectIds,
  };
}

/**
 * Canonical JSON for a loaded fixture (sorted keys) — for shared test/CI diffs.
 */
export function canonicalGoldenTurnBytes(fixture: GoldenTurnFixture): string {
  return canonicalizeGoldenTurn(fixture);
}

/** List JSON turn files under the imported fixture dir (excludes manifest). */
export function listImportedGoldenTurnFiles(fixtureDir?: string): string[] {
  const dir = resolveGoldenTurnFixtureDir(fixtureDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json")
    .sort();
}
