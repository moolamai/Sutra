#!/usr/bin/env node
/**
 * Operator-facing one-command certify proof:
 *   llama.cpp (desktop) + ONNX mobile (android-mid)
 * Seeded red violation must fail; green adapters write committable reports.
 */
import { proveOneCommandCertifyFlow } from "../dist/certify.js";

const proof = await proveOneCommandCertifyFlow({
  io: { stdout: process.stdout, stderr: process.stderr },
});
process.exitCode = proof.exitCode;
