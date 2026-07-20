#!/usr/bin/env node
/**
 * Byte-identical rebuild regression prove.
 * Golden ×2 must match; intentional nondeterminism fixture must diverge.
 */
import { runProveRebuildCli } from "../dist/build.js";

const code = runProveRebuildCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
