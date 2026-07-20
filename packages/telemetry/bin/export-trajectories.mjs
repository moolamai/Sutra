#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  TRAINING_EXPORT_CONSENT_SCOPE,
  TRAINING_EXPORT_DEFAULT_LIMIT,
  TRAINING_EXPORT_DEFAULT_TIMEOUT_MS,
  TRAINING_EXPORT_MAX_LIMIT,
  TrainingExportContractError,
  exportTrajectories,
} from "../dist/export_pipeline.js";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const ID_LIMIT = 128;

export async function runExportTrajectoriesCli(argv) {
  const args = parseArguments(argv);
  const storePath = resolve(args.storePath);
  const consentPath = resolve(args.consentPath);
  const outputPath = resolve(args.outputPath);
  if (outputPath === storePath || outputPath === consentPath) {
    throw contractError("validation", "out", "output path must differ from input paths");
  }

  let trajectories;
  let consents;
  try {
    [trajectories, consents] = await Promise.all([
      readJsonl(storePath, args.limit),
      readConsentLedger(consentPath),
    ]);
  } catch (error) {
    if (error instanceof TrainingExportContractError) throw error;
    throw contractError(
      "read_failed",
      undefined,
      error instanceof Error ? error.message : "failed to read sovereign inputs",
    );
  }
  const subjectConsents = consents
    .filter((consent) => consent.subjectId === args.subjectId)
    .sort((left, right) =>
      left.consentRecordId.localeCompare(right.consentRecordId),
    );

  return exportTrajectories({
    subjectId: args.subjectId,
    limit: args.limit,
    timeoutMs: args.timeoutMs,
    readTrajectories: (subjectId, limit) =>
      trajectories
        .filter(
          (value) =>
            isObject(value) &&
            value.subjectId === subjectId,
        )
        .slice(0, limit),
    resolveConsent: () =>
      subjectConsents.find(
        (consent) =>
          consent.scope === TRAINING_EXPORT_CONSENT_SCOPE &&
          consent.optedIn &&
          consent.active,
      ),
    writeJsonl: (jsonl, signal) => writeAtomically(outputPath, jsonl, signal),
    onTelemetry: (event) => console.error(JSON.stringify(event)),
  });
}

function parseArguments(argv) {
  const allowed = new Set([
    "--store",
    "--consent",
    "--subject",
    "--out",
    "--limit",
    "--timeout-ms",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith("--")) {
      throw usageError();
    }
    if (values.has(flag)) {
      throw contractError("validation", "argv", `duplicate argument ${flag}`);
    }
    values.set(flag, value);
  }
  const storePath = values.get("--store");
  const consentPath = values.get("--consent");
  const subjectId = values.get("--subject");
  const outputPath = values.get("--out");
  if (!storePath || !consentPath || !subjectId || !outputPath) {
    throw usageError();
  }
  return {
    storePath,
    consentPath,
    subjectId,
    outputPath,
    limit: numericOption(
      values.get("--limit"),
      TRAINING_EXPORT_DEFAULT_LIMIT,
      "--limit",
    ),
    timeoutMs: numericOption(
      values.get("--timeout-ms"),
      TRAINING_EXPORT_DEFAULT_TIMEOUT_MS,
      "--timeout-ms",
    ),
  };
}

function numericOption(value, fallback, flag) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw contractError("validation", "argv", `${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw contractError("validation", "argv", `${flag} is outside the safe range`);
  }
  if (flag === "--limit" && parsed > TRAINING_EXPORT_MAX_LIMIT) {
    throw contractError(
      "limit",
      "argv",
      `${flag} must not exceed ${TRAINING_EXPORT_MAX_LIMIT}`,
    );
  }
  return parsed;
}

function usageError() {
  return contractError(
    "validation",
    "argv",
    "usage: --store PATH --consent PATH --subject ID --out PATH [--limit N] [--timeout-ms N]",
  );
}

function contractError(failureClass, issuePath, message) {
  return new TrainingExportContractError(failureClass, issuePath, message);
}

async function readBounded(path) {
  const metadata = await stat(path);
  if (metadata.size > MAX_INPUT_BYTES) {
    throw contractError(
      "limit",
      undefined,
      `input exceeds ${MAX_INPUT_BYTES} bytes`,
    );
  }
  return readFile(path, "utf8");
}

async function readJsonl(path, limit) {
  const lines = (await readBounded(path))
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "");
  if (lines.length > limit || lines.length > TRAINING_EXPORT_MAX_LIMIT) {
    throw contractError(
      "limit",
      undefined,
      `store contains more than requested ${limit} records`,
    );
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw contractError(
        "validation",
        `line[${index}]`,
        `store line ${index + 1} is not valid JSON`,
      );
    }
  });
}

async function readConsentLedger(path) {
  let value;
  try {
    value = JSON.parse(await readBounded(path));
  } catch (error) {
    if (error instanceof TrainingExportContractError) throw error;
    throw contractError("validation", "consent", "consent ledger is not valid JSON");
  }
  if (!Array.isArray(value) || value.length > TRAINING_EXPORT_MAX_LIMIT) {
    throw contractError("limit", "consent", "consent ledger must be a bounded array");
  }
  return value.map((item, index) => {
    if (
      !isObject(item) ||
      !boundedId(item.consentRecordId) ||
      !boundedId(item.subjectId) ||
      typeof item.scope !== "string" ||
      typeof item.optedIn !== "boolean" ||
      typeof item.active !== "boolean"
    ) {
      throw contractError(
        "validation",
        `consent[${index}]`,
        `consent record ${index} is invalid`,
      );
    }
    return {
      consentRecordId: item.consentRecordId,
      subjectId: item.subjectId,
      scope: item.scope,
      optedIn: item.optedIn,
      active: item.active,
    };
  });
}

function boundedId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= ID_LIMIT;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeAtomically(path, jsonl, signal) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, jsonl, {
      encoding: "utf8",
      flag: "wx",
      signal,
    });
    if (signal.aborted) {
      throw contractError("timeout", undefined, "training export deadline exceeded");
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  runExportTrajectoriesCli(process.argv.slice(2))
    .then((result) => {
      console.log(
        JSON.stringify({
          operation: "export_trajectories",
          outcome: "completed",
          ...result,
        }),
      );
    })
    .catch((error) => {
      const typed =
        error instanceof TrainingExportContractError
          ? error
          : contractError(
              "read_failed",
              undefined,
              error instanceof Error ? error.message : "training export failed",
            );
      console.error(
        JSON.stringify({
          event: "telemetry.training_export",
          operation: "export_trajectories",
          outcome: "rejected",
          failureClass: typed.failureClass,
          obligationId: typed.obligationId,
          ...(typed.issuePath === undefined ? {} : { issuePath: typed.issuePath }),
        }),
      );
      process.exitCode = 1;
    });
}
