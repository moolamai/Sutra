#!/usr/bin/env node
/**
 * Prove speech cert gate: baseline green → seeded red → restore green.
 */
import { runSpeechCertCli } from "../dist/speech_certification.js";

const code = await runSpeechCertCli(["--prove"], {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
