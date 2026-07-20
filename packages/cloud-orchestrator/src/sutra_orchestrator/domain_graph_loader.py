"""Load task-graph JSON packs into ``TaskGraph`` / ``ConceptNode``.

Mirrors ``packages/domain-loader/src/load_graph.ts`` semantics for the same
pack bytes (parity fingerprint). Packs are loaded from filesystem paths only
— never via ``domains/`` imports.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .task_router import (
    ADVANCE_THRESHOLD,
    REMEDIATE_THRESHOLD,
    ConceptNode,
    TaskGraph,
)

logger = logging.getLogger(__name__)

AgeFloor = Literal["child", "adolescent", "adult"]


@dataclass(frozen=True)
class LoadedTaskGraphMeta:
    """Pack metadata alongside the in-memory ``TaskGraph``."""

    pack_id: str
    domain_id: str
    version: str
    version_stamp: str
    schema_version: str
    advance_threshold: float
    remediate_threshold: float
    source_path: str
    source_mtime_ms: float
    graph: TaskGraph


class TaskGraphLoadError(Exception):
    """Typed load failure — obligation named, never silent."""

    def __init__(
        self,
        message: str,
        *,
        obligation: str,
        failure_class: str | None = None,
        cycle_path: list[str] | None = None,
        subject_id: str = "domain-loader-load",
        device_id: str = "ci",
    ) -> None:
        super().__init__(message)
        self.obligation = obligation
        self.failure_class = failure_class
        self.cycle_path = cycle_path
        self.subject_id = subject_id
        self.device_id = device_id


def resolve_thresholds(raw: dict[str, Any] | None) -> tuple[float, float]:
    """Pack thresholds when present and positive; else router defaults.

    Never silently uses 0/0 (Postgres row missing thresholds).
    """
    adv: float | None = None
    rem: float | None = None
    if isinstance(raw, dict):
        a = raw.get("advanceThreshold")
        r = raw.get("remediateThreshold")
        if isinstance(a, (int, float)) and float(a) > 0:
            adv = float(a)
        if isinstance(r, (int, float)) and float(r) > 0:
            rem = float(r)
    return (
        adv if adv is not None else ADVANCE_THRESHOLD,
        rem if rem is not None else REMEDIATE_THRESHOLD,
    )


def _emit(
    *,
    subject_id: str,
    device_id: str,
    outcome: str,
    phase: str,
    failure_class: str | None = None,
    pack_id: str | None = None,
    version_stamp: str | None = None,
    concept_count: int | None = None,
    edge_count: int | None = None,
    source_path: str | None = None,
    emit: bool = True,
) -> None:
    if not emit:
        return
    payload: dict[str, Any] = {
        "event": "domain_loader.task_graph.load",
        "outcome": outcome,
        "subjectId": subject_id,
        "deviceId": device_id,
        "phase": phase,
    }
    if failure_class is not None:
        payload["failureClass"] = failure_class
    if pack_id is not None:
        payload["packId"] = pack_id
    if version_stamp is not None:
        payload["versionStamp"] = version_stamp
    if concept_count is not None:
        payload["conceptCount"] = concept_count
    if edge_count is not None:
        payload["edgeCount"] = edge_count
    if source_path is not None:
        payload["sourcePath"] = source_path
    # Structured log — never titles or learner content.
    logger.info("%s", json.dumps(payload, separators=(",", ":")))


def _find_cycle(concept_ids: list[str], edges: list[tuple[str, str]]) -> list[str] | None:
    adj: dict[str, list[str]] = {c: [] for c in concept_ids}
    for frm, to in edges:
        if frm in adj and to in adj:
            if frm == to:
                return [frm, frm]
            adj[frm].append(to)
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {c: WHITE for c in concept_ids}
    stack: list[str] = []

    def dfs(u: str) -> list[str] | None:
        color[u] = GRAY
        stack.append(u)
        for v in adj[u]:
            if color[v] == GRAY:
                idx = stack.index(v)
                return stack[idx:] + [v]
            if color[v] == WHITE:
                hit = dfs(v)
                if hit:
                    return hit
        stack.pop()
        color[u] = BLACK
        return None

    for cid in concept_ids:
        if color[cid] == WHITE:
            hit = dfs(cid)
            if hit:
                return hit
    return None


def _validate_pack_structure(
    data: dict[str, Any],
    *,
    subject_id: str,
    device_id: str,
) -> None:
    concepts = data.get("concepts")
    edges = data.get("edges")
    if not isinstance(concepts, list) or not concepts:
        raise TaskGraphLoadError(
            "pack concepts missing or empty",
            obligation="domain_loader.task_graph.schema_invalid",
            failure_class="schema_invalid",
            subject_id=subject_id,
            device_id=device_id,
        )
    if not isinstance(edges, list):
        raise TaskGraphLoadError(
            "pack edges must be a list",
            obligation="domain_loader.task_graph.schema_invalid",
            failure_class="schema_invalid",
            subject_id=subject_id,
            device_id=device_id,
        )

    ids: set[str] = set()
    for c in concepts:
        if not isinstance(c, dict) or not isinstance(c.get("conceptId"), str):
            raise TaskGraphLoadError(
                "concept missing conceptId",
                obligation="domain_loader.task_graph.schema_invalid",
                failure_class="schema_invalid",
                subject_id=subject_id,
                device_id=device_id,
            )
        cid = c["conceptId"]
        if cid in ids:
            raise TaskGraphLoadError(
                f"duplicate conceptId: {cid}",
                obligation="domain_loader.task_graph.duplicate_concept",
                failure_class="duplicate_concept",
                subject_id=subject_id,
                device_id=device_id,
            )
        ids.add(cid)

    edge_pairs: list[tuple[str, str]] = []
    for e in edges:
        if not isinstance(e, dict):
            continue
        frm = e.get("fromConceptId")
        to = e.get("toConceptId")
        if not isinstance(frm, str) or not isinstance(to, str):
            raise TaskGraphLoadError(
                "edge missing endpoints",
                obligation="domain_loader.task_graph.schema_invalid",
                failure_class="schema_invalid",
                subject_id=subject_id,
                device_id=device_id,
            )
        if frm == to:
            raise TaskGraphLoadError(
                f"self-loop edge on {frm} (length-1 cycle)",
                obligation="domain_loader.task_graph.self_loop",
                failure_class="self_loop",
                cycle_path=[frm, frm],
                subject_id=subject_id,
                device_id=device_id,
            )
        if frm not in ids:
            raise TaskGraphLoadError(
                f"edge.fromConceptId unknown: {frm}",
                obligation="domain_loader.task_graph.missing_edge_endpoint",
                failure_class="missing_edge_endpoint",
                subject_id=subject_id,
                device_id=device_id,
            )
        if to not in ids:
            raise TaskGraphLoadError(
                f"edge.toConceptId unknown: {to}",
                obligation="domain_loader.task_graph.missing_edge_endpoint",
                failure_class="missing_edge_endpoint",
                subject_id=subject_id,
                device_id=device_id,
            )
        edge_pairs.append((frm, to))

    cycle = _find_cycle(sorted(ids), edge_pairs)
    if cycle:
        raise TaskGraphLoadError(
            f"prerequisite cycle: {' -> '.join(cycle)}",
            obligation="domain_loader.task_graph.cycle",
            failure_class="cycle",
            cycle_path=cycle,
            subject_id=subject_id,
            device_id=device_id,
        )


def map_pack_to_graph(data: dict[str, Any], source_path: str, source_mtime_ms: float = 0.0) -> LoadedTaskGraphMeta:
    """Map pack JSON object → TaskGraph + metadata (shared mapping with TS)."""
    advance, remediate = resolve_thresholds(
        data.get("thresholds") if isinstance(data.get("thresholds"), dict) else None
    )
    concepts_raw = data.get("concepts") or []
    edges_raw = data.get("edges") or []
    prereqs: dict[str, list[str]] = {}
    nodes: dict[str, ConceptNode] = {}

    for c in concepts_raw:
        cid = str(c["conceptId"])
        prereqs[cid] = []
    for e in edges_raw:
        frm = str(e["fromConceptId"])
        to = str(e["toConceptId"])
        if frm in prereqs:
            prereqs[frm].append(to)

    for c in concepts_raw:
        cid = str(c["conceptId"])
        title = str(c.get("title") or cid)
        age = c.get("ageFloor") or "child"
        if age not in ("child", "adolescent", "adult"):
            age = "child"
        nodes[cid] = ConceptNode(
            concept_id=cid,
            title=title,
            prerequisites=tuple(sorted(prereqs.get(cid, []))),
            age_floor=age,  # type: ignore[arg-type]
        )

    pack_id = str(data.get("packId") or "unknown")
    version = str(data.get("version") or "0.0.0")
    graph = TaskGraph(
        nodes=nodes,
        advance_threshold=advance,
        remediate_threshold=remediate,
    )
    return LoadedTaskGraphMeta(
        pack_id=pack_id,
        domain_id=str(data.get("domainId") or ""),
        version=version,
        version_stamp=f"{pack_id}@{version}",
        schema_version=str(data.get("schemaVersion") or "task-graph.v1"),
        advance_threshold=advance,
        remediate_threshold=remediate,
        source_path=source_path,
        source_mtime_ms=source_mtime_ms,
        graph=graph,
    )


def graph_semantics_fingerprint(meta: LoadedTaskGraphMeta) -> dict[str, Any]:
    """Canonical fingerprint for TS↔Python parity on the same pack bytes."""
    nodes_out: list[dict[str, Any]] = []
    for cid in sorted(meta.graph.nodes.keys()):
        n = meta.graph.nodes[cid]
        nodes_out.append(
            {
                "conceptId": n.concept_id,
                "title": n.title,
                "prerequisites": list(n.prerequisites),
                "ageFloor": n.age_floor,
            }
        )
    return {
        "packId": meta.pack_id,
        "version": meta.version,
        "versionStamp": meta.version_stamp,
        "advanceThreshold": meta.advance_threshold,
        "remediateThreshold": meta.remediate_threshold,
        "nodes": nodes_out,
    }


def load_task_graph(
    path: str | Path,
    *,
    subject_id: str = "domain-loader-load",
    device_id: str = "ci",
    validate: bool = True,
    emit_events: bool = True,
) -> LoadedTaskGraphMeta:
    """Load pack JSON from ``path`` into ``TaskGraph`` (same fixture bytes as TS)."""
    file_path = Path(path).resolve()
    try:
        text = file_path.read_text(encoding="utf-8")
        mtime_ms = file_path.stat().st_mtime * 1000.0
    except OSError as exc:
        _emit(
            subject_id=subject_id,
            device_id=device_id,
            outcome="fail",
            phase="read",
            failure_class="io_error",
            source_path=str(file_path),
            emit=emit_events,
        )
        raise TaskGraphLoadError(
            f"failed to read task-graph pack: {exc}",
            obligation="domain_loader.task_graph.io_error",
            failure_class="io_error",
            subject_id=subject_id,
            device_id=device_id,
        ) from exc

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        _emit(
            subject_id=subject_id,
            device_id=device_id,
            outcome="fail",
            phase="parse",
            failure_class="schema_invalid",
            source_path=str(file_path),
            emit=emit_events,
        )
        raise TaskGraphLoadError(
            f"invalid JSON in task-graph pack: {exc}",
            obligation="domain_loader.task_graph.schema_invalid",
            failure_class="schema_invalid",
            subject_id=subject_id,
            device_id=device_id,
        ) from exc

    if not isinstance(data, dict):
        raise TaskGraphLoadError(
            "pack root must be an object",
            obligation="domain_loader.task_graph.schema_invalid",
            failure_class="schema_invalid",
            subject_id=subject_id,
            device_id=device_id,
        )

    # Threshold fallback before validation (Postgres partial row).
    thr = data.get("thresholds")
    if not isinstance(thr, dict):
        data = {**data, "thresholds": {}}
    adv, rem = resolve_thresholds(data.get("thresholds") if isinstance(data.get("thresholds"), dict) else None)
    data = {
        **data,
        "thresholds": {"advanceThreshold": adv, "remediateThreshold": rem},
    }

    if validate:
        try:
            _validate_pack_structure(data, subject_id=subject_id, device_id=device_id)
        except TaskGraphLoadError as exc:
            _emit(
                subject_id=subject_id,
                device_id=device_id,
                outcome="fail",
                phase="validate",
                failure_class=exc.failure_class,
                source_path=str(file_path),
                emit=emit_events,
            )
            raise

    meta = map_pack_to_graph(data, str(file_path), mtime_ms)
    _emit(
        subject_id=subject_id,
        device_id=device_id,
        outcome="ok",
        phase="load",
        pack_id=meta.pack_id,
        version_stamp=meta.version_stamp,
        concept_count=len(meta.graph.nodes),
        edge_count=len(data.get("edges") or []),
        source_path=str(file_path),
        emit=emit_events,
    )
    return meta


def load_task_graph_from_object(
    data: dict[str, Any],
    *,
    source_path: str = "<memory>",
    subject_id: str = "domain-loader-load",
    device_id: str = "ci",
    validate: bool = True,
    emit_events: bool = True,
) -> LoadedTaskGraphMeta:
    """In-memory / Postgres-row load path with threshold fallback."""
    payload = dict(data)
    adv, rem = resolve_thresholds(
        payload.get("thresholds") if isinstance(payload.get("thresholds"), dict) else None
    )
    payload["thresholds"] = {"advanceThreshold": adv, "remediateThreshold": rem}
    if validate:
        _validate_pack_structure(payload, subject_id=subject_id, device_id=device_id)
    meta = map_pack_to_graph(payload, source_path, 0.0)
    _emit(
        subject_id=subject_id,
        device_id=device_id,
        outcome="ok",
        phase="load",
        pack_id=meta.pack_id,
        version_stamp=meta.version_stamp,
        concept_count=len(meta.graph.nodes),
        source_path=source_path,
        emit=emit_events,
    )
    return meta


# Compose / production env — path to a task-graph.v1 JSON pack.
ENV_TASK_GRAPH_PACK = "TASK_GRAPH_PACK"


def bundled_demo_pack_path() -> Path:
    """Historical demo pack (math + system-design) for ``demo_task_graph()`` tests."""
    return Path(__file__).resolve().parent / "packs" / "demo-math-sd-slice.json"


def bundled_teacher_pack_path() -> Path:
    """Production teacher CBSE-slice pack — same bytes as domain-loader fixtures."""
    return Path(__file__).resolve().parent / "packs" / "teacher-cbse-slice.json"


def resolve_production_task_graph(
    *,
    env: Mapping[str, str] | None = None,
    pack_path: str | Path | None = None,
    pack_row: dict[str, Any] | None = None,
    subject_id: str = "orchestrator-boot",
    device_id: str = "cloud",
    emit_events: bool = True,
) -> LoadedTaskGraphMeta:
    """Resolve the production TaskGraph: Postgres row → path → env → teacher pack.

    ``demo_task_graph()`` is not used on the production boot path.
    """
    environ = env if env is not None else os.environ

    if pack_row is not None:
        meta = load_task_graph_from_object(
            pack_row,
            source_path="<postgres>",
            subject_id=subject_id,
            device_id=device_id,
            emit_events=emit_events,
        )
        logger.info(
            "task_graph_source=postgres_row pack_id=%s version_stamp=%s outcome=loaded",
            meta.pack_id,
            meta.version_stamp,
        )
        return meta

    resolved: Path
    source_kind: str
    if pack_path is not None:
        resolved = Path(pack_path)
        source_kind = "explicit_path"
    else:
        env_path = environ.get(ENV_TASK_GRAPH_PACK, "").strip()
        if env_path:
            resolved = Path(env_path)
            source_kind = "env_path"
        else:
            resolved = bundled_teacher_pack_path()
            source_kind = "bundled_teacher"

    meta = load_task_graph(
        resolved,
        subject_id=subject_id,
        device_id=device_id,
        emit_events=emit_events,
    )
    logger.info(
        "task_graph_source=%s pack_id=%s version_stamp=%s outcome=loaded",
        source_kind,
        meta.pack_id,
        meta.version_stamp,
    )
    return meta
