#!/usr/bin/env node
/**
 * CLI entry for Indic speech certification (CK-05 STT+TTS + fixtures).
 */
import { runSpeechCertCli } from "../dist/speech_certification.js";

const code = await runSpeechCertCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
