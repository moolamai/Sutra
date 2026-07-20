"""Python microbenches for cloud-orchestrator hot paths.

Output matches ``benchmarks/_shared/bench.mjs`` (p50/p95/p99 lines + JSON
``benchmarks.sample`` events) so MISSBENC-004 can feed check.mjs.
"""

from .harness import (
    BENCH_DEVICE_ID,
    BENCH_SUBJECT_ID,
    bench,
    format_bench_line,
    max_p95,
    percentile,
    run_capture,
)

__all__ = [
    "BENCH_DEVICE_ID",
    "BENCH_SUBJECT_ID",
    "bench",
    "format_bench_line",
    "max_p95",
    "percentile",
    "run_capture",
]
