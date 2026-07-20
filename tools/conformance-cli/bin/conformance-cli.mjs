#!/usr/bin/env node
/**
 * Thin independence-kit CLI: verify extracted fixtures + checklist.
 * Obligation runs stay on `@moolam/contract-conformance` (`conformance` bin).
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyIndependenceKit } from "../lib/verify-independence-kit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_CONFORMANCE = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "contract-conformance",
  "bin",
  "conformance.mjs",
);

function printHelp(out) {
  out.write(`Usage:
  conformance-cli verify --kit <extracted-kit-dir> [--subject-id <id>] [--device-id <id>] [--json]
  conformance-cli run -- <args forwarded to conformance>

verify  Check MANIFEST, CERTIFICATION-CHECKLIST, wire + sync fixtures.
run     Forward args to the contract-conformance CLI (monorepo bin or PATH).
`);
}

function parseArgs(argv) {
  const args = {
    command: null,
    kit: null,
    subjectId: "kit.verify",
    deviceId: "local",
    json: false,
    rest: [],
  };
  const tokens = [...argv];
  args.command = tokens.shift() ?? null;
  while (tokens.length) {
    const t = tokens.shift();
    if (t === "--kit") args.kit = tokens.shift() ?? null;
    else if (t === "--subject-id") args.subjectId = tokens.shift() ?? args.subjectId;
    else if (t === "--device-id") args.deviceId = tokens.shift() ?? args.deviceId;
    else if (t === "--json") args.json = true;
    else if (t === "--help" || t === "-h") args.command = "help";
    else if (t === "--") {
      args.rest.push(...tokens);
      break;
    } else {
      args.rest.push(t);
    }
  }
  return args;
}

export function main(argv = process.argv.slice(2), io = process) {
  const args = parseArgs(argv);
  if (!args.command || args.command === "help") {
    printHelp(io.stdout);
    return args.command === "help" ? 0 : 1;
  }

  if (args.command === "verify") {
    const result = verifyIndependenceKit(args.kit, {
      subjectId: args.subjectId,
      deviceId: args.deviceId,
      emit: (e) => {
        if (!args.json) {
          io.stderr.write(
            `${e.event} outcome=${e.outcome} subjectId=${e.subjectId} deviceId=${e.deviceId ?? ""} code=${e.code ?? ""}\n`,
          );
        }
      },
    });
    if (args.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.ok) {
      io.stdout.write("independence-kit: OK\n");
    } else {
      io.stderr.write(
        `independence-kit: FAIL\n${result.errors.map((e) => `  - ${e}`).join("\n")}\n`,
      );
    }
    return result.ok ? 0 : 1;
  }

  if (args.command === "run") {
    const forwarded = args.rest;
    if (existsSync(MONOREPO_CONFORMANCE)) {
      const result = spawnSync(process.execPath, [MONOREPO_CONFORMANCE, ...forwarded], {
        stdio: "inherit",
      });
      return result.status ?? 1;
    }
    const viaPath = spawnSync("conformance", forwarded, {
      stdio: "inherit",
      shell: true,
    });
    return viaPath.status ?? 1;
  }

  io.stderr.write(`unknown command: ${args.command}\n`);
  printHelp(io.stderr);
  return 1;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.exitCode = main();
}
