"""Run Python sync-merge + agent-runtime benches (bench.mjs-compatible output)."""

from __future__ import annotations

import json
import sys

from . import agent_runtime_bench, sync_merge_bench
from .harness import begin_capture, end_capture, max_p95


def main() -> int:
    begin_capture()
    try:
        sync_merge_bench.run()
        agent_runtime_bench.run()
    except Exception as exc:  # noqa: BLE001 — surface typed failure to CLI
        end_capture()
        sys.stderr.write(
            json.dumps(
                {
                    "event": "benchmarks.sample",
                    "outcome": "rejected",
                    "failureClass": "bench_failed",
                    "subjectId": None,
                    "deviceId": "bench-harness-python",
                    "detail": str(exc)[:240],
                }
            )
            + "\n"
        )
        return 1
    samples = end_capture()
    summary = {
        "event": "benchmarks.python.capture",
        "outcome": "ok",
        "subjectId": None,
        "deviceId": "bench-harness-python",
        "sampleCount": len(samples),
        "measuredP95Max": max_p95(samples),
        "names": [s["name"] for s in samples],
    }
    sys.stdout.write(json.dumps(summary, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
