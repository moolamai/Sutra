#!/usr/bin/env node
/**
 * Decontamination CI gate prove.
 * Seeded eval-overlap build must fail; clean sample must pass with proof.
 */
import { runProveDecontamCli } from "../dist/build.js";

const code = runProveDecontamCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
