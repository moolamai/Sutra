#!/usr/bin/env node
/**
 * Certify teacher/doctor document golden fixtures + vision conformance + rubric.
 */
import { runDocumentGoldenCli } from "../dist/document_golden.js";

const code = await runDocumentGoldenCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);

