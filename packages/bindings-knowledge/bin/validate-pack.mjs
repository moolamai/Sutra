#!/usr/bin/env node
/**
 * CLI: validate a knowledge pack (citations + optional vector id map).
 */
import { runValidatePackCli } from "../dist/pack_validator.js";

const code = runValidatePackCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);

