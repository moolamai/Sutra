#!/usr/bin/env node
/**
 * CI entry: speech certification with argv forwarded (e.g. --report-out).
 */
import { runSpeechCertCli } from "../dist/speech_certification.js";

const code = await runSpeechCertCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
