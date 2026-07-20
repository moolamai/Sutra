#!/usr/bin/env node
/**
 * create-sutra CLI — scaffold a companion project with binding choices.
 *
 * Usage:
 *   node tools/create-sutra/bin/create-sutra.mjs
 *   node tools/create-sutra/bin/create-sutra.mjs --name my-companion --domain teacher --storage memory --transport offline --out ./my-companion --yes
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOMAIN_PACKS,
  STORAGE_DRIVERS,
  TRANSPORTS,
  listDomainPackIds,
  listStorageDriverIds,
  listTransportIds,
} from "../lib/choices.mjs";
import { runCreateSutraScaffold } from "../lib/scaffold.mjs";

function parseArgs(argv) {
  const opts = {
    yes: false,
    overwrite: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") {
      opts.yes = true;
      continue;
    }
    if (arg === "--overwrite") {
      opts.overwrite = true;
      continue;
    }
    if (arg === "--name") {
      opts.projectName = argv[++i];
      continue;
    }
    if (arg === "--domain") {
      opts.domainPack = argv[++i];
      continue;
    }
    if (arg === "--storage") {
      opts.storageDriver = argv[++i];
      continue;
    }
    if (arg === "--transport") {
      opts.transport = argv[++i];
      continue;
    }
    if (arg === "--out") {
      opts.outDir = argv[++i];
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function printHelp() {
  output.write(
    [
      "create-sutra — scaffold a Sutra companion project",
      "",
      "Interactive:",
      "  node tools/create-sutra/bin/create-sutra.mjs",
      "",
      "Non-interactive:",
      "  node tools/create-sutra/bin/create-sutra.mjs \\",
      "    --name my-companion --domain teacher --storage memory --transport offline --out ./my-companion --yes",
      "",
      "Options:",
      "  --name       Project name (lowercase kebab-case)",
      "  --domain     Domain pack: teacher | doctor | lawyer | custom",
      "  --storage    Storage driver: memory | sqlite | expo-sqlite",
      "  --transport  Transport: http | offline",
      "  --out        Output directory (default: ./<name>)",
      "  --overwrite  Replace existing output directory contents",
      "  --yes        Skip confirmation prompt",
      "",
    ].join("\n"),
  );
}

async function promptChoice(rl, label, choices) {
  const ids = Object.keys(choices);
  output.write(`\n${label}\n`);
  for (const id of ids) {
    output.write(`  - ${id}: ${choices[id].label}\n`);
  }
  const answer = (await rl.question(`Choose [${ids.join("|")}]: `)).trim();
  return answer;
}

async function promptInteractive(partial = {}) {
  const rl = createInterface({ input, output });
  try {
    const projectName =
      partial.projectName ??
      (await rl.question("Project name (kebab-case): ")).trim();
    const domainPack =
      partial.domainPack ?? (await promptChoice(rl, "Domain pack", DOMAIN_PACKS));
    const storageDriver =
      partial.storageDriver ??
      (await promptChoice(rl, "Storage driver", STORAGE_DRIVERS));
    const transport =
      partial.transport ?? (await promptChoice(rl, "Sync transport", TRANSPORTS));
    const outDir =
      partial.outDir ??
      ((await rl.question(`Output directory [./${projectName}]: `)).trim() ||
        path.join(process.cwd(), projectName));

    return {
      projectName,
      domainPack,
      storageDriver,
      transport,
      outDir,
    };
  } finally {
    rl.close();
  }
}

function assertChoiceLists() {
  if (listDomainPackIds().length < 2) {
    throw new Error("domain pack catalog must list at least two choices");
  }
  if (listStorageDriverIds().length < 2) {
    throw new Error("storage driver catalog must list at least two choices");
  }
  if (listTransportIds().length < 2) {
    throw new Error("transport catalog must list at least two choices");
  }
}

async function main() {
  assertChoiceLists();
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const interactive = !args.yes || !args.projectName || !args.domainPack;
  const choices = interactive
    ? await promptInteractive(args)
    : {
        projectName: args.projectName,
        domainPack: args.domainPack,
        storageDriver: args.storageDriver ?? "memory",
        transport: args.transport ?? "offline",
        outDir: args.outDir ?? path.join(process.cwd(), args.projectName),
      };

  const result = runCreateSutraScaffold({
    ...choices,
    overwrite: args.overwrite,
    subjectId: "create-sutra-operator",
    deviceId: "cli",
  });

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
  main().catch((err) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
