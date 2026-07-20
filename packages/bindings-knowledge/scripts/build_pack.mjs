#!/usr/bin/env node
/**
 * Build flagship knowledge packs from domains/ markdown (filesystem only).
 * --pack teacher-cbse-slice | doctor-formulary-sketch
 */
import { runBuildPackCli } from "../dist/pack_build.js";

const code = runBuildPackCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
