#!/usr/bin/env node
/**
 * `conformance` bin — wraps {@link runConformanceCli}.
 */
import { runConformanceCli } from "../dist/cli.js";

const code = await runConformanceCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exitCode = code;
