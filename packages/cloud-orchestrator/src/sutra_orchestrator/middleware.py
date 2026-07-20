"""Cloud ingress middleware ( / 002 / 003 + ).

Pure ASGI middleware that:

* assigns a UUID ``X-Request-Id`` (honors a well-formed inbound header),
* binds the id into a ContextVar for structured logs,
* records wall-clock latency per route template (bounded in-memory histogram),
* attaches ``sutra.request_id`` to the active OpenTelemetry span when available,
* always echoes ``X-Request-Id`` on the response (including ``/v1/health``),
* Increments ``sutra.http.errors`` with distinct ``error_class`` labels,
* Records NFR-04 agent-turn routing overhead (excludes LLM generation),
* Exposes Prometheus / OpenMetrics text from the meter registry,
* Readiness matrix for Postgres / Redis / orchestrator .

Compose integration
``tests/test_compose_metrics_readiness.py`` (see also
``scripts/verify_operator_surfaces_compose.sh``).

``/v1/health`` and ``/v1/metrics`` still receive a request id but skip the
latency histogram, error-taxonomy counters, and verbose request-complete logging.

Streaming responses: time-to-first-byte is recorded as the request latency
sample; total stream duration is tracked separately on the recorder.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections import defaultdict, deque
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Callable, Deque, Mapping, MutableMapping, Sequence

from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger("sutra.orchestrator.middleware")

REQUEST_ID_HEADER = "X-Request-Id"
REQUEST_ID_HEADER_LOWER = "x-request-id"

LATENCY_SAMPLE_LIMIT = 1024
LATENCY_ROUTE_LIMIT = 64
ERROR_ROUTE_LIMIT = 64
ROUTING_SAMPLE_LIMIT = 1024
TURN_STAGE_SAMPLE_LIMIT = 1024

# Metric name for operators / future Prometheus export .
SUTRA_HTTP_ERRORS_METRIC = "sutra.http.errors"

# NFR-04 — routing overhead excluding LLM generation ( / PRD_MATRIX).
SUTRA_ROUTING_OVERHEAD_METRIC = "sutra.agent_turn.routing_overhead_ms"
NFR04_ID = "NFR-04"
NFR04_BUDGET_P95_MS = 50.0
# Recorded local headroom reference; CI also allows relative tolerance.
NFR04_BASELINE_P95_MS = 25.0
NFR04_REGRESSION_TOLERANCE = 0.50  # measured may be up to 1.5× baseline
AGENT_TURN_ROUTE = "/v1/agent/turn"

# Prometheus / OpenMetrics exposition (no subject labels).
SUTRA_HTTP_DURATION_METRIC = "sutra_http_request_duration_ms"
SUTRA_HTTP_ERRORS_PROM = "sutra_http_errors_total"
SUTRA_ROUTING_OVERHEAD_PROM = "sutra_agent_turn_routing_overhead_ms"
SUTRA_SYNC_OUTCOME_PROM = "sutra_sync_outcome_total"
SUTRA_TURN_STAGE_DURATION_PROM = "sutra_turn_stage_duration_ms"
PROM_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"
OPENMETRICS_CONTENT_TYPE = "application/openmetrics-text; version=1.0.0; charset=utf-8"

# Fixed histogram buckets (ms) — bounded cardinality, read-only scrape.
HISTOGRAM_BUCKETS_MS: tuple[float, ...] = (
    1.0,
    5.0,
    10.0,
    25.0,
    50.0,
    100.0,
    250.0,
    500.0,
    1000.0,
    5000.0,
)

SYNC_OUTCOME_LABELS = frozenset(
    {"converged", "quarantined", "exhausted", "skipped-offline"}
)
TURN_STAGE_LABELS = frozenset(
    {"perceive", "recall", "retrieve", "reason", "respond", "reflect"}
)

# Typed error_class labels — never a single generic "error" bucket.
ERROR_CLASS_AUTH = "auth"
ERROR_CLASS_VALIDATION = "validation"
ERROR_CLASS_TIMEOUT = "timeout"
ERROR_CLASS_CLIENT = "client"  # other 4xx
ERROR_CLASS_SERVER = "server"  # 5xx + unhandled

ERROR_CLASSES = frozenset(
    {
        ERROR_CLASS_AUTH,
        ERROR_CLASS_VALIDATION,
        ERROR_CLASS_TIMEOUT,
        ERROR_CLASS_CLIENT,
        ERROR_CLASS_SERVER,
    }
)

_request_id_var: ContextVar[str | None] = ContextVar("sutra_request_id", default=None)

__all__ = [
    "REQUEST_ID_HEADER",
    "LATENCY_SAMPLE_LIMIT",
    "SUTRA_HTTP_ERRORS_METRIC",
    "SUTRA_ROUTING_OVERHEAD_METRIC",
    "SUTRA_HTTP_DURATION_METRIC",
    "SUTRA_SYNC_OUTCOME_PROM",
    "SUTRA_TURN_STAGE_DURATION_PROM",
    "PROM_CONTENT_TYPE",
    "OPENMETRICS_CONTENT_TYPE",
    "NFR04_ID",
    "NFR04_BUDGET_P95_MS",
    "NFR04_BASELINE_P95_MS",
    "NFR04_REGRESSION_TOLERANCE",
    "AGENT_TURN_ROUTE",
    "ERROR_CLASS_AUTH",
    "ERROR_CLASS_VALIDATION",
    "ERROR_CLASS_TIMEOUT",
    "ERROR_CLASS_CLIENT",
    "ERROR_CLASS_SERVER",
    "ERROR_CLASSES",
    "SYNC_OUTCOME_LABELS",
    "TURN_STAGE_LABELS",
    "RequestIdLatencyMiddleware",
    "LatencyRecorder",
    "LatencySample",
    "HttpErrorCounter",
    "RoutingOverheadRecorder",
    "SyncOutcomeCounter",
    "TurnStageDurationRecorder",
    "Nfr04GateResult",
    "classify_http_error",
    "percentile_ms",
    "current_request_id",
    "get_latency_recorder",
    "get_http_error_counter",
    "get_routing_overhead_recorder",
    "get_sync_outcome_counter",
    "get_turn_stage_duration_recorder",
    "reset_latency_recorder_for_tests",
    "reset_http_error_counter_for_tests",
    "reset_routing_overhead_recorder_for_tests",
    "reset_sync_outcome_counter_for_tests",
    "reset_turn_stage_duration_recorder_for_tests",
    "begin_agent_turn_routing",
    "mark_llm_generation_start",
    "finish_agent_turn_routing",
    "cancel_agent_turn_routing",
    "record_sync_outcome",
    "record_turn_stage_duration",
    "evaluate_nfr04_gate",
    "format_nfr04_gate_report",
    "check_nfr04_cli",
    "metrics_snapshot",
    "render_prometheus_exposition",
    "resolve_metrics_content_type",
    "build_readiness_report",
    "probe_postgres_health",
    "probe_redis_health",
    "resolve_request_id",
    "route_template_for_scope",
    "install_request_id_log_filter",
]


@dataclass(frozen=True, slots=True)
class LatencySample:
    """One latency observation (metadata only — never request bodies)."""

    request_id: str
    method: str
    route: str
    status_code: int
    latency_ms: float
    kind: str = "wall"  # wall | first_byte | stream


class LatencyRecorder:
    """Bounded in-memory latency store for per-route observations."""

    def __init__(
        self,
        *,
        sample_limit: int = LATENCY_SAMPLE_LIMIT,
        route_limit: int = LATENCY_ROUTE_LIMIT,
    ) -> None:
        self._sample_limit = max(1, sample_limit)
        self._route_limit = max(1, route_limit)
        self._samples: Deque[LatencySample] = deque(maxlen=self._sample_limit)
        self._by_route: dict[str, Deque[float]] = {}
        self._stream_durations: Deque[float] = deque(maxlen=self._sample_limit)

    def record(self, sample: LatencySample) -> None:
        self._samples.append(sample)
        if sample.kind == "stream":
            self._stream_durations.append(sample.latency_ms)
            return
        if sample.route not in self._by_route:
            if len(self._by_route) >= self._route_limit:
                oldest = next(iter(self._by_route))
                del self._by_route[oldest]
            self._by_route[sample.route] = deque(maxlen=self._sample_limit)
        self._by_route[sample.route].append(sample.latency_ms)

    def samples(self) -> list[LatencySample]:
        return list(self._samples)

    def latencies_for_route(self, route: str) -> list[float]:
        return list(self._by_route.get(route, ()))

    def routes(self) -> dict[str, list[float]]:
        """Per-route wall samples for Prometheus histograms (bounded)."""
        return {route: list(vals) for route, vals in self._by_route.items()}

    def stream_durations_ms(self) -> list[float]:
        return list(self._stream_durations)

    def clear(self) -> None:
        self._samples.clear()
        self._by_route.clear()
        self._stream_durations.clear()


def classify_http_error(status_code: int) -> str | None:
    """Map HTTP status → typed ``error_class`` (None when not an error).

    Distinct classes: ``auth``, ``validation``, ``timeout``, ``client``, ``server``.
    Never returns a generic ``error`` label.
    """
    if status_code < 400:
        return None
    if status_code in (401, 403):
        return ERROR_CLASS_AUTH
    if status_code == 422:
        return ERROR_CLASS_VALIDATION
    if status_code in (408, 504):
        return ERROR_CLASS_TIMEOUT
    if 400 <= status_code < 500:
        return ERROR_CLASS_CLIENT
    return ERROR_CLASS_SERVER


class HttpErrorCounter:
    """Bounded ``sutra.http.errors`` counter keyed by (error_class, route)."""

    def __init__(self, *, route_limit: int = ERROR_ROUTE_LIMIT) -> None:
        self._route_limit = max(1, route_limit)
        self._counts: dict[tuple[str, str], int] = defaultdict(int)
        self._routes_seen: Deque[str] = deque()

    def incr(self, error_class: str, route: str) -> None:
        if error_class not in ERROR_CLASSES:
            # Refuse opaque/generic buckets — fold unknown to server.
            error_class = ERROR_CLASS_SERVER
        route_key = (route or "/")[:128]
        if route_key not in self._routes_seen:
            if len(self._routes_seen) >= self._route_limit:
                evicted = self._routes_seen.popleft()
                for key in list(self._counts):
                    if key[1] == evicted:
                        del self._counts[key]
            self._routes_seen.append(route_key)
        self._counts[(error_class, route_key)] += 1

    def count(self, error_class: str, route: str) -> int:
        return int(self._counts.get((error_class, route[:128]), 0))

    def total(self, error_class: str | None = None) -> int:
        if error_class is None:
            return sum(self._counts.values())
        return sum(v for (cls, _), v in self._counts.items() if cls == error_class)

    def snapshot(self) -> dict[tuple[str, str], int]:
        return dict(self._counts)

    def clear(self) -> None:
        self._counts.clear()
        self._routes_seen.clear()


def percentile_ms(samples: Sequence[float], pct: float) -> float | None:
    """Nearest-rank percentile; ``pct`` in ``[0, 100]``."""
    if not samples:
        return None
    ordered = sorted(float(x) for x in samples)
    if pct <= 0:
        return ordered[0]
    if pct >= 100:
        return ordered[-1]
    idx = min(len(ordered) - 1, max(0, int((pct / 100.0) * len(ordered))))
    return ordered[idx]


class RoutingOverheadRecorder:
    """Bounded histogram of pre-LLM agent-turn orchestrator work (NFR-04)."""

    def __init__(self, *, sample_limit: int = ROUTING_SAMPLE_LIMIT) -> None:
        self._sample_limit = max(1, sample_limit)
        self._samples: Deque[float] = deque(maxlen=self._sample_limit)

    def record(self, latency_ms: float) -> None:
        self._samples.append(max(0.0, float(latency_ms)))

    def samples(self) -> list[float]:
        return list(self._samples)

    def clear(self) -> None:
        self._samples.clear()

    def percentiles(self) -> dict[str, float | None]:
        vals = self.samples()
        return {
            "p50_ms": percentile_ms(vals, 50),
            "p95_ms": percentile_ms(vals, 95),
            "p99_ms": percentile_ms(vals, 99),
        }


class SyncOutcomeCounter:
    """``sutra_sync_outcome_total`` — aggregate by terminal outcome only."""

    def __init__(self) -> None:
        self._counts: dict[str, int] = defaultdict(int)

    def incr(self, outcome: str) -> None:
        if outcome not in SYNC_OUTCOME_LABELS:
            outcome = "exhausted"
        self._counts[outcome] += 1

    def count(self, outcome: str) -> int:
        return int(self._counts.get(outcome, 0))

    def snapshot(self) -> dict[str, int]:
        return {k: int(v) for k, v in self._counts.items()}

    def clear(self) -> None:
        self._counts.clear()


class TurnStageDurationRecorder:
    """``sutra_turn_stage_duration_ms`` — stage label only, never subjectId."""

    def __init__(self, *, sample_limit: int = TURN_STAGE_SAMPLE_LIMIT) -> None:
        self._sample_limit = max(1, sample_limit)
        self._by_stage: dict[str, Deque[float]] = {
            stage: deque(maxlen=self._sample_limit) for stage in sorted(TURN_STAGE_LABELS)
        }

    def record(self, stage: str, duration_ms: float) -> None:
        if stage not in TURN_STAGE_LABELS:
            stage = "respond"
        self._by_stage[stage].append(max(0.0, float(duration_ms)))

    def samples_for_stage(self, stage: str) -> list[float]:
        return list(self._by_stage.get(stage, ()))

    def stages(self) -> dict[str, list[float]]:
        return {s: list(v) for s, v in self._by_stage.items() if v}

    def clear(self) -> None:
        for q in self._by_stage.values():
            q.clear()


@dataclass(frozen=True, slots=True)
class Nfr04GateResult:
    """Outcome of the NFR-04 routing-overhead gate (always printable)."""

    outcome: str  # pass | fail | insufficient_samples
    sample_count: int
    p95_ms: float | None
    budget_p95_ms: float
    baseline_p95_ms: float
    tolerance: float
    headroom_pct: float | None
    reason: str


@dataclass(slots=True)
class _RoutingSession:
    t0: float
    closed_ms: float | None = None
    llm_started: bool = False
    cancelled: bool = False

    def mark_llm(self, now: float) -> None:
        if self.closed_ms is None:
            self.closed_ms = max(0.0, (now - self.t0) * 1000.0)
            self.llm_started = True

    def finish(self, now: float) -> float | None:
        if self.cancelled:
            return None
        if self.closed_ms is None:
            self.closed_ms = max(0.0, (now - self.t0) * 1000.0)
        return self.closed_ms


_recorder = LatencyRecorder()
_error_counter = HttpErrorCounter()
_routing_overhead = RoutingOverheadRecorder()
_sync_outcomes = SyncOutcomeCounter()
_turn_stages = TurnStageDurationRecorder()
_routing_session_var: ContextVar[_RoutingSession | None] = ContextVar(
    "sutra_routing_session", default=None
)


def get_latency_recorder() -> LatencyRecorder:
    return _recorder


def get_http_error_counter() -> HttpErrorCounter:
    return _error_counter


def get_routing_overhead_recorder() -> RoutingOverheadRecorder:
    return _routing_overhead


def get_sync_outcome_counter() -> SyncOutcomeCounter:
    return _sync_outcomes


def get_turn_stage_duration_recorder() -> TurnStageDurationRecorder:
    return _turn_stages


def reset_latency_recorder_for_tests() -> None:
    _recorder.clear()


def reset_http_error_counter_for_tests() -> None:
    _error_counter.clear()


def reset_routing_overhead_recorder_for_tests() -> None:
    _routing_overhead.clear()
    _routing_session_var.set(None)


def reset_sync_outcome_counter_for_tests() -> None:
    _sync_outcomes.clear()


def reset_turn_stage_duration_recorder_for_tests() -> None:
    _turn_stages.clear()


def record_sync_outcome(outcome: str) -> None:
    """Increment sync terminal counter + soft-publish to OTel Meter if available."""
    _sync_outcomes.incr(outcome)
    _otel_sync_outcome_add(outcome)


def record_turn_stage_duration(stage: str, duration_ms: float) -> None:
    """Record turn-stage duration (stage label only) + soft OTel histogram."""
    _turn_stages.record(stage, duration_ms)
    _otel_turn_stage_record(stage, duration_ms)


def current_request_id() -> str | None:
    return _request_id_var.get()


def _otel_sync_outcome_add(outcome: str) -> None:
    """Soft-bind to the global OTel MeterProvider when the SDK is installed."""
    try:
        from opentelemetry import metrics  # type: ignore[import-not-found]

        meter = metrics.get_meter("sutra.orchestrator")
        counter = meter.create_counter(SUTRA_SYNC_OUTCOME_PROM.replace("_", "."))
        counter.add(1, {"outcome": outcome})
    except Exception:
        return


def _otel_turn_stage_record(stage: str, duration_ms: float) -> None:
    try:
        from opentelemetry import metrics  # type: ignore[import-not-found]

        meter = metrics.get_meter("sutra.orchestrator")
        hist = meter.create_histogram("sutra.turn.stage.duration_ms")
        hist.record(float(duration_ms), {"stage": stage})
    except Exception:
        return


def begin_agent_turn_routing(
    *, now: Callable[[], float] | None = None
) -> _RoutingSession:
    """Start the NFR-04 clock for orchestrator work before first LLM token."""
    clock = now or time.perf_counter
    session = _RoutingSession(t0=clock())
    _routing_session_var.set(session)
    return session


def mark_llm_generation_start(*, now: Callable[[], float] | None = None) -> None:
    """Stop the routing clock — subsequent model latency is excluded from NFR-04."""
    session = _routing_session_var.get()
    if session is None:
        return
    clock = now or time.perf_counter
    session.mark_llm(clock())


def finish_agent_turn_routing(*, now: Callable[[], float] | None = None) -> float | None:
    """Close the session and record one routing-overhead sample when not cancelled."""
    session = _routing_session_var.get()
    _routing_session_var.set(None)
    if session is None:
        return None
    clock = now or time.perf_counter
    ms = session.finish(clock())
    if ms is None:
        return None
    _routing_overhead.record(ms)
    logger.info(
        "http.routing_overhead metric=%s route=%s latency_ms=%.3f "
        "llm_excluded=%s request_id=%s outcome=ok",
        SUTRA_ROUTING_OVERHEAD_METRIC,
        AGENT_TURN_ROUTE,
        ms,
        session.llm_started,
        current_request_id() or "-",
    )
    return ms


def cancel_agent_turn_routing() -> None:
    """Drop the session without recording (e.g. auth/scope/404 before routing)."""
    session = _routing_session_var.get()
    if session is not None:
        session.cancelled = True
    _routing_session_var.set(None)


def evaluate_nfr04_gate(
    samples: Sequence[float] | None = None,
    *,
    budget_p95_ms: float = NFR04_BUDGET_P95_MS,
    baseline_p95_ms: float = NFR04_BASELINE_P95_MS,
    tolerance: float = NFR04_REGRESSION_TOLERANCE,
    min_samples: int = 1,
) -> Nfr04GateResult:
    """Compare measured p95 to absolute budget and relative baseline (NFR-04)."""
    vals = list(samples) if samples is not None else _routing_overhead.samples()
    count = len(vals)
    if count < min_samples:
        return Nfr04GateResult(
            outcome="insufficient_samples",
            sample_count=count,
            p95_ms=None,
            budget_p95_ms=budget_p95_ms,
            baseline_p95_ms=baseline_p95_ms,
            tolerance=tolerance,
            headroom_pct=None,
            reason=f"need>={min_samples} samples, have={count}",
        )
    p95 = percentile_ms(vals, 95)
    assert p95 is not None
    headroom = ((budget_p95_ms - p95) / budget_p95_ms) * 100.0
    rel_ceiling = baseline_p95_ms * (1.0 + max(0.0, tolerance))
    if p95 > budget_p95_ms:
        return Nfr04GateResult(
            outcome="fail",
            sample_count=count,
            p95_ms=p95,
            budget_p95_ms=budget_p95_ms,
            baseline_p95_ms=baseline_p95_ms,
            tolerance=tolerance,
            headroom_pct=headroom,
            reason=(
                f"p95={p95:.3f}ms exceeds absolute budget {budget_p95_ms:.3f}ms "
                f"(NFR-04)"
            ),
        )
    if p95 > rel_ceiling:
        return Nfr04GateResult(
            outcome="fail",
            sample_count=count,
            p95_ms=p95,
            budget_p95_ms=budget_p95_ms,
            baseline_p95_ms=baseline_p95_ms,
            tolerance=tolerance,
            headroom_pct=headroom,
            reason=(
                f"p95={p95:.3f}ms exceeds baseline {baseline_p95_ms:.3f}ms "
                f"× (1+{tolerance:.2f}) = {rel_ceiling:.3f}ms"
            ),
        )
    return Nfr04GateResult(
        outcome="pass",
        sample_count=count,
        p95_ms=p95,
        budget_p95_ms=budget_p95_ms,
        baseline_p95_ms=baseline_p95_ms,
        tolerance=tolerance,
        headroom_pct=headroom,
        reason="within absolute budget and relative baseline tolerance",
    )


def format_nfr04_gate_report(result: Nfr04GateResult) -> str:
    """Human-readable gate line — always includes measured vs budget when present."""
    measured = "n/a" if result.p95_ms is None else f"{result.p95_ms:.3f}"
    headroom = "n/a" if result.headroom_pct is None else f"{result.headroom_pct:.1f}"
    return (
        f"{NFR04_ID} metric={SUTRA_ROUTING_OVERHEAD_METRIC} "
        f"p95_measured_ms={measured} budget_p95_ms={result.budget_p95_ms:.3f} "
        f"baseline_p95_ms={result.baseline_p95_ms:.3f} tolerance={result.tolerance:.2f} "
        f"headroom_pct={headroom} samples={result.sample_count} "
        f"gate={result.outcome} reason={result.reason}"
    )


def check_nfr04_cli(
    samples: Sequence[float] | None = None,
    *,
    budget_p95_ms: float = NFR04_BUDGET_P95_MS,
    baseline_p95_ms: float = NFR04_BASELINE_P95_MS,
    tolerance: float = NFR04_REGRESSION_TOLERANCE,
) -> int:
    """Checker entry: print measured vs budget; return 0 pass / 1 breach."""
    result = evaluate_nfr04_gate(
        samples,
        budget_p95_ms=budget_p95_ms,
        baseline_p95_ms=baseline_p95_ms,
        tolerance=tolerance,
    )
    line = format_nfr04_gate_report(result)
    print(line)
    return 0 if result.outcome == "pass" else 1


def metrics_snapshot() -> dict[str, object]:
    """JSON summary for ``GET /v1/metrics`` (Accept: application/json).

    Metadata only — never request bodies / subject ids.
    """
    routing = _routing_overhead.percentiles()
    gate = evaluate_nfr04_gate()
    return {
        "nfr04": {
            "id": NFR04_ID,
            "metric": SUTRA_ROUTING_OVERHEAD_METRIC,
            "route": AGENT_TURN_ROUTE,
            "budget_p95_ms": NFR04_BUDGET_P95_MS,
            "baseline_p95_ms": NFR04_BASELINE_P95_MS,
            "regression_tolerance": NFR04_REGRESSION_TOLERANCE,
            "sample_count": len(_routing_overhead.samples()),
            "p50_ms": routing["p50_ms"],
            "p95_ms": routing["p95_ms"],
            "p99_ms": routing["p99_ms"],
            "headroom_pct": gate.headroom_pct,
            "gate": gate.outcome,
            "gate_reason": gate.reason,
        },
        "http_errors_total": get_http_error_counter().total(),
        "sync_outcomes": get_sync_outcome_counter().snapshot(),
        "turn_stages": {
            stage: {
                "sample_count": len(vals),
                "p95_ms": percentile_ms(vals, 95),
            }
            for stage, vals in get_turn_stage_duration_recorder().stages().items()
        },
        "exposition": "prometheus",
    }


def _prom_escape(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("\n", "\\n")
        .replace('"', '\\"')
    )


def _prom_labels(**labels: str) -> str:
    if not labels:
        return ""
    parts = [f'{k}="{_prom_escape(v)}"' for k, v in sorted(labels.items())]
    return "{" + ",".join(parts) + "}"


def _histogram_lines(
    name: str,
    help_text: str,
    series: Mapping[str, Sequence[float]] | Mapping[tuple[str, ...], Sequence[float]],
    *,
    label_names: Sequence[str],
) -> list[str]:
    """Emit Prometheus histogram lines for pre-aggregated sample lists."""
    lines = [
        f"# HELP {name} {help_text}",
        f"# TYPE {name} histogram",
    ]
    for key, samples in sorted(series.items(), key=lambda kv: str(kv[0])):
        if isinstance(key, tuple):
            label_map = {
                label_names[i]: str(key[i]) for i in range(len(label_names))
            }
        else:
            label_map = {label_names[0]: str(key)}
        vals = [max(0.0, float(x)) for x in samples]
        count = len(vals)
        total = float(sum(vals))
        for le in HISTOGRAM_BUCKETS_MS:
            bucket = sum(1 for v in vals if v <= le)
            labels = {**label_map, "le": _format_le(le)}
            lines.append(
                f"{name}_bucket{_prom_labels(**labels)} {bucket}"
            )
        labels_inf = {**label_map, "le": "+Inf"}
        lines.append(f"{name}_bucket{_prom_labels(**labels_inf)} {count}")
        lines.append(f"{name}_sum{_prom_labels(**label_map)} {_format_num(total)}")
        lines.append(f"{name}_count{_prom_labels(**label_map)} {count}")
    return lines


def _format_le(le: float) -> str:
    if le == int(le):
        return str(int(le))
    return repr(le)


def _format_num(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return f"{value:.6f}".rstrip("0").rstrip(".")


def render_prometheus_exposition(*, openmetrics: bool = False) -> str:
    """Prometheus text / OpenMetrics from the meter registry.

    Read-only scrape of bounded in-process meters (and dual-written OTel when
    present). Labels are route / outcome / stage / error_class only — never
    subjectId or other high-cardinality identifiers.
    """
    lines: list[str] = []

    # HTTP wall latency per route template.
    routes = get_latency_recorder().routes()
    if routes:
        lines.extend(
            _histogram_lines(
                SUTRA_HTTP_DURATION_METRIC,
                "HTTP request wall latency in milliseconds (route template only).",
                routes,
                label_names=("route",),
            )
        )
    else:
        lines.append(f"# HELP {SUTRA_HTTP_DURATION_METRIC} HTTP request wall latency in milliseconds (route template only).")
        lines.append(f"# TYPE {SUTRA_HTTP_DURATION_METRIC} histogram")

    # HTTP error taxonomy counters.
    lines.append(
        f"# HELP {SUTRA_HTTP_ERRORS_PROM} HTTP errors by error_class and route template."
    )
    lines.append(f"# TYPE {SUTRA_HTTP_ERRORS_PROM} counter")
    for (error_class, route), count in sorted(get_http_error_counter().snapshot().items()):
        lines.append(
            f"{SUTRA_HTTP_ERRORS_PROM}"
            f'{_prom_labels(error_class=error_class, route=route)} {int(count)}'
        )

    # NFR-04 routing overhead (single series — agent-turn route only).
    routing_samples = get_routing_overhead_recorder().samples()
    lines.extend(
        _histogram_lines(
            SUTRA_ROUTING_OVERHEAD_PROM,
            "Agent-turn routing overhead in milliseconds excluding LLM generation (NFR-04).",
            {AGENT_TURN_ROUTE: routing_samples},
            label_names=("route",),
        )
    )

    # Sync terminal outcomes.
    lines.append(
        f"# HELP {SUTRA_SYNC_OUTCOME_PROM} Sync reconcile terminal outcomes (aggregate)."
    )
    lines.append(f"# TYPE {SUTRA_SYNC_OUTCOME_PROM} counter")
    for outcome, count in sorted(get_sync_outcome_counter().snapshot().items()):
        lines.append(
            f"{SUTRA_SYNC_OUTCOME_PROM}{_prom_labels(outcome=outcome)} {int(count)}"
        )

    # Turn stage durations.
    stages = get_turn_stage_duration_recorder().stages()
    if stages:
        lines.extend(
            _histogram_lines(
                SUTRA_TURN_STAGE_DURATION_PROM,
                "Turn stage duration in milliseconds (stage label only).",
                stages,
                label_names=("stage",),
            )
        )
    else:
        lines.append(
            f"# HELP {SUTRA_TURN_STAGE_DURATION_PROM} Turn stage duration in milliseconds (stage label only)."
        )
        lines.append(f"# TYPE {SUTRA_TURN_STAGE_DURATION_PROM} histogram")

    if openmetrics:
        lines.append("# EOF")
    else:
        # Prometheus text format ends with a trailing newline.
        pass
    return "\n".join(lines) + "\n"


def resolve_metrics_content_type(accept: str | None) -> str:
    """Pick Prometheus vs OpenMetrics content type from Accept (default Prom)."""
    raw = (accept or "").lower()
    if "application/openmetrics-text" in raw:
        return OPENMETRICS_CONTENT_TYPE
    return PROM_CONTENT_TYPE


# ── : readiness / per-dependency health matrix ───────────────

READINESS_COMPONENT_STATUSES = frozenset({"ok", "degraded", "down", "absent"})
READINESS_OVERALL_STATUSES = frozenset({"ok", "degraded", "down"})


def probe_postgres_health(store: object | None) -> dict[str, str]:
    """Probe master-state Postgres (or report absent for in-memory).

    Never returns DSNs / credentials — status + backend name only.
    """
    if store is None:
        return {"status": "down", "backend": "none"}
    backend = str(getattr(store, "backend_name", "unknown"))[:32]
    if backend == "memory":
        return {"status": "absent", "backend": "memory"}
    if backend != "postgres":
        return {"status": "down", "backend": backend}
    pool = getattr(store, "_pool", None)
    if pool is None:
        return {"status": "down", "backend": "postgres"}
    try:
        with pool.connection() as conn:
            conn.execute("SELECT 1")
        return {"status": "ok", "backend": "postgres"}
    except Exception as err:
        logger.warning(
            "readiness postgres outcome=down err_type=%s",
            type(err).__name__,
        )
        return {"status": "down", "backend": "postgres"}


def probe_redis_health(
    redis_url: str | None,
    *,
    checkpointer_backend: str | None = None,
) -> dict[str, str]:
    """Probe optional Redis checkpointer.

    Unset URL → ``absent`` (degrades overall readiness, never down).
    Configured but unreachable → ``degraded`` (Epic: Redis absent/disabled ≠ down).
    """
    if not redis_url or not str(redis_url).strip():
        return {"status": "absent", "backend": "none"}
    try:
        import redis as redis_lib

        client = redis_lib.Redis.from_url(
            redis_url,
            socket_connect_timeout=1.0,
            socket_timeout=1.0,
            decode_responses=False,
        )
        client.ping()
        return {"status": "ok", "backend": "redis"}
    except Exception as err:
        logger.warning(
            "readiness redis outcome=degraded err_type=%s checkpointer=%s",
            type(err).__name__,
            (checkpointer_backend or "unknown")[:32],
        )
        backend = "memory" if checkpointer_backend == "memory" else "redis"
        return {"status": "degraded", "backend": backend}


def build_readiness_report(
    *,
    store: object | None,
    runtime_ready: bool,
    redis_url: str | None,
    checkpointer_backend: str | None,
    protocol: str,
    engine: str,
    auth_backend: str | None = None,
) -> tuple[int, dict[str, object]]:
    """Compose readiness JSON + HTTP status .

    - 503 only when the process cannot serve any protected /v1 route
      (orchestrator not wired, or Postgres configured and unreachable).
    - Redis absent / unreachable → HTTP 200 with ``status: degraded``.
    - Never includes subject ids, DSNs, or Redis passwords.
    """
    orchestrator = (
        {"status": "ok"}
        if runtime_ready and store is not None
        else {"status": "down"}
    )
    postgres = probe_postgres_health(store)
    redis = probe_redis_health(
        redis_url, checkpointer_backend=checkpointer_backend
    )
    master_backend = str(getattr(store, "backend_name", "none"))[:32] if store else "none"
    master_state = {
        "status": "ok" if store is not None and postgres["status"] != "down" else "down",
        "backend": master_backend,
    }
    cp_backend = (checkpointer_backend or "memory")[:32]
    # Checkpointer: redis ping failure while using memory fallback → degraded.
    if redis["status"] == "degraded":
        checkpointer: dict[str, str] = {"status": "degraded", "backend": cp_backend}
    else:
        checkpointer = {"status": "ok", "backend": cp_backend}

    components: dict[str, object] = {
        "orchestrator": orchestrator,
        "postgres": postgres,
        "redis": redis,
        "master_state": master_state,
        "checkpointer": checkpointer,
    }

    overall = "ok"
    http_status = 200
    if (
        orchestrator["status"] == "down"
        or postgres["status"] == "down"
        or master_state["status"] == "down"
    ):
        overall = "down"
        http_status = 503
    elif redis["status"] in {"absent", "degraded"}:
        # Optional Redis: absent/unreachable is degraded, never 503.
        overall = "degraded"
        http_status = 200

    body: dict[str, object] = {
        "status": overall,
        "protocol": protocol,
        "engine": engine,
        "master_state_backend": master_backend,
        "components": components,
    }
    if auth_backend:
        body["auth_backend"] = auth_backend

    logger.info(
        "readiness status=%s http=%s postgres=%s redis=%s checkpointer=%s outcome=%s",
        overall,
        http_status,
        postgres["status"],
        redis["status"],
        checkpointer["status"],
        "ok" if http_status == 200 else "not_ready",
    )
    return http_status, body


def resolve_request_id(headers: Mapping[str, str] | None) -> str:
    """Return a UUID request id; reuse inbound ``X-Request-Id`` when well-formed."""
    if headers:
        raw = headers.get(REQUEST_ID_HEADER) or headers.get(REQUEST_ID_HEADER_LOWER)
        if isinstance(raw, str):
            candidate = raw.strip()
            try:
                return str(uuid.UUID(candidate))
            except ValueError:
                pass
    return str(uuid.uuid4())


def _headers_to_map(headers: list[tuple[bytes, bytes]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in headers:
        out[key.decode("latin-1")] = value.decode("latin-1")
    return out


def route_template_for_scope(scope: Scope) -> str:
    """Prefer the FastAPI/Starlette route template (bounded cardinality)."""
    route = scope.get("route")
    path = getattr(route, "path", None)
    if isinstance(path, str) and path.startswith("/"):
        return path
    raw = scope.get("path") or "/"
    if not isinstance(raw, str):
        raw = "/"
    if raw.startswith("/v1/subjects/") and raw.endswith("/state"):
        return "/v1/subjects/{subject_id}/state"
    if raw.startswith("/v1/subjects/") and "/sync-audit" in raw:
        return "/v1/subjects/{subject_id}/sync-audit"
    return raw[:128]


def _is_light_route(route: str, path: str) -> bool:
    """Health + metrics: request-id only — no latency / error-taxonomy noise."""
    normalized = path.rstrip("/") or "/"
    return (
        route in {"/v1/health", "/v1/metrics"}
        or normalized in {"/v1/health", "/v1/metrics"}
    )


def _attach_request_id_to_span(request_id: str, route: str) -> None:
    """Soft-attach to active OTel span when the API is installed (optional)."""
    try:
        from opentelemetry import trace  # type: ignore[import-not-found]
    except Exception:
        return
    span = trace.get_current_span()
    if span is None:
        return
    try:
        if not span.is_recording():
            return
        span.set_attribute("sutra.request_id", request_id)
        span.set_attribute("sutra.http.route", route)
    except Exception:
        return


def _set_request_state(scope: Scope, request_id: str) -> None:
    state = scope.get("state")
    if isinstance(state, MutableMapping):
        state["request_id"] = request_id
        return
    if state is not None:
        try:
            setattr(state, "request_id", request_id)
        except Exception:
            pass


def _is_timeout_exc(exc: BaseException) -> bool:
    name = type(exc).__name__
    if isinstance(exc, TimeoutError):
        return True
    if name in {"TimeoutException", "ReadTimeout", "ConnectTimeout", "Timeout"}:
        return True
    return False


class RequestIdLatencyMiddleware:
    """Pure ASGI middleware — request id, latency, and error taxonomy."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        recorder: LatencyRecorder | None = None,
        error_counter: HttpErrorCounter | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        self.app = app
        self._recorder = recorder or _recorder
        self._errors = error_counter or _error_counter
        self._now = now or time.perf_counter

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers_map = _headers_to_map(list(scope.get("headers") or []))
        request_id = resolve_request_id(headers_map)
        _set_request_state(scope, request_id)
        token = _request_id_var.set(request_id)
        t0 = self._now()
        method = str(scope.get("method") or "GET").upper()
        path = str(scope.get("path") or "/")
        status_code = 500
        started = False
        body_started = False
        is_streaming = False
        wall_recorded = False
        error_recorded = False

        async def send_wrapper(message: Message) -> None:
            nonlocal status_code, started, body_started, is_streaming
            nonlocal wall_recorded, error_recorded
            if message["type"] == "http.response.start":
                started = True
                status_code = int(message.get("status") or 500)
                raw_headers = list(message.get("headers") or [])
                filtered = [
                    (k, v)
                    for k, v in raw_headers
                    if k.decode("latin-1").lower() != REQUEST_ID_HEADER_LOWER
                ]
                filtered.append(
                    (
                        REQUEST_ID_HEADER.lower().encode("latin-1"),
                        request_id.encode("latin-1"),
                    )
                )
                message = {**message, "headers": filtered}
                has_cl = any(
                    k.decode("latin-1").lower() == "content-length" for k, _ in filtered
                )
                is_streaming = not has_cl
                route = route_template_for_scope(scope)
                _attach_request_id_to_span(request_id, route)
                light = _is_light_route(route, path)
                if not light and not error_recorded:
                    err_class = classify_http_error(status_code)
                    if err_class is not None:
                        self._errors.incr(err_class, route)
                        error_recorded = True
                        # Structured signal — never credentials / body content.
                        logger.info(
                            "http.error metric=%s error_class=%s route=%s "
                            "status=%s request_id=%s outcome=error",
                            SUTRA_HTTP_ERRORS_METRIC,
                            err_class,
                            route,
                            status_code,
                            request_id,
                        )
            elif message["type"] == "http.response.body":
                route = route_template_for_scope(scope)
                light = _is_light_route(route, path)
                more = bool(message.get("more_body"))
                if not light:
                    now_ms = max(0.0, (self._now() - t0) * 1000.0)
                    if is_streaming:
                        if not body_started:
                            body_started = True
                            self._recorder.record(
                                LatencySample(
                                    request_id=request_id,
                                    method=method,
                                    route=route,
                                    status_code=status_code,
                                    latency_ms=now_ms,
                                    kind="first_byte",
                                )
                            )
                        if not more:
                            self._recorder.record(
                                LatencySample(
                                    request_id=request_id,
                                    method=method,
                                    route=route,
                                    status_code=status_code,
                                    latency_ms=now_ms,
                                    kind="stream",
                                )
                            )
                    elif not more and not wall_recorded:
                        wall_recorded = True
                        self._recorder.record(
                            LatencySample(
                                request_id=request_id,
                                method=method,
                                route=route,
                                status_code=status_code,
                                latency_ms=now_ms,
                                kind="wall",
                            )
                        )
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
            route = route_template_for_scope(scope)
            light = _is_light_route(route, path)
            if light:
                logger.debug(
                    "http.light_path route=%s request_id=%s outcome=ok",
                    route,
                    request_id,
                )
            else:
                logger.info(
                    "http.request_complete request_id=%s method=%s route=%s "
                    "status=%s outcome=%s",
                    request_id,
                    method,
                    route,
                    status_code if started else 500,
                    "ok" if (started and status_code < 400) else "error",
                )
        except Exception as exc:
            route = route_template_for_scope(scope)
            light = _is_light_route(route, path)
            if not light and not error_recorded:
                # Unhandled → server (or timeout); never dump body / secrets.
                err_class = (
                    ERROR_CLASS_TIMEOUT if _is_timeout_exc(exc) else ERROR_CLASS_SERVER
                )
                self._errors.incr(err_class, route)
                error_recorded = True
                logger.info(
                    "http.error metric=%s error_class=%s route=%s "
                    "status=unhandled request_id=%s exc_type=%s outcome=error",
                    SUTRA_HTTP_ERRORS_METRIC,
                    err_class,
                    route,
                    request_id,
                    type(exc).__name__,
                )
            logger.info(
                "http.request_failed request_id=%s method=%s path=%s outcome=error",
                request_id,
                method,
                path[:128],
            )
            raise
        finally:
            _request_id_var.reset(token)


def install_request_id_log_filter(root: logging.Logger | None = None) -> None:
    """Ensure log records expose ``request_id`` from the ContextVar."""

    class _RequestIdFilter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            rid = _request_id_var.get()
            record.request_id = rid if rid else "-"  # type: ignore[attr-defined]
            return True

    target = root or logging.getLogger("sutra.orchestrator")
    if not any(type(f).__name__ == "_RequestIdFilter" for f in target.filters):
        target.addFilter(_RequestIdFilter())
