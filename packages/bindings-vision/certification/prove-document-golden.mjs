#!/usr/bin/env node
/**
 * Prove document golden gate: baseline green → seeded red → restore green.
 */
import { runDocumentGoldenCli } from "../dist/document_golden.js";

const code = await runDocumentGoldenCli(["--prove"], {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);

