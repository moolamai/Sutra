#!/usr/bin/env node
/**
 * Deterministic corpus builder CLI.
 * Usage: build-corpus --manifest <path> --out <dir>
 */
import { runBuildCorpusCli } from "../dist/build.js";

const code = runBuildCorpusCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
