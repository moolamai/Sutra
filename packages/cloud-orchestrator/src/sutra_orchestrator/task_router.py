"""Adaptive task router — the cyclical Cognitive State Machine.

A LangGraph ``StateGraph`` whose *cyclical* topology is the architectural
thesis of the platform: friction does not advance a linear script, it
routes the subject BACKWARDS through the prerequisite subgraph until
foundations hold, then forward again. Linear workflows cannot express
this; a state machine with cycles can. The same topology serves any
domain whose work decomposes into a prerequisite graph: skill tracks,
case preparation, differential workups, design reviews.

Graph topology::

                       ┌────────────────────┐
                       │  assess_friction   │◄─────────────┐
                       └─────────┬──────────┘              │
                                 │                         │
                    ┌────────────┴───────────┐             │
                    ▼                        ▼             │
          ┌──────────────────┐    ┌─────────────────────┐  │
          │  advance_concept │    │ remediate_prereq    │  │
          │  (mastery ≥ τ_a) │    │ (mastery < τ_r)     │──┘   ← THE CYCLE
          └────────┬─────────┘    └─────────────────────┘
                   │                        ▲
                   ▼                        │
          ┌──────────────────┐             │
          │ generate_guidance│─────────────┘  (mid-task friction spike
          └────────┬─────────┘                 re-enters remediation)
                   ▼
                  END (turn emitted; session state checkpointed)

Thresholds τ_a (advance) and τ_r (remediate) are hysteretic (τ_r < τ_a) so
the router does not oscillate on noisy mastery estimates.

Checkpoint serialization for Redis-backed resume lives in
``checkpointer.RouterCheckpointPayload`` ; wiring the LangGraph
Checkpointer is .
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Literal, TypedDict

from langgraph.graph import END, StateGraph

from .contract_models import ConceptMastery, FrictionSample, GuidanceMode

logger = logging.getLogger(__name__)

ADVANCE_THRESHOLD = 0.85
REMEDIATE_THRESHOLD = 0.40
HESITATION_SPIKE_MS = 15_000

# CAST-05.1 — advance blocked until every task-graph root has an assessed
# posterior seed (≥ this many mastery evidence units = Σα+Σβ).
CAST_05_1_OBLIGATION_ID = "CAST-05.1"
CAST_05_MIN_ROOT_FRICTION_SAMPLES = 3
COLD_START_ROOT_SCAN_LIMIT = 64


@dataclass(frozen=True)
class ConceptNode:
    """A node in the prerequisite knowledge graph (the domain's task DAG)."""

    concept_id: str
    title: str
    prerequisites: tuple[str, ...] = ()
    age_floor: Literal["child", "adolescent", "adult"] = "child"


@dataclass
class TaskGraph:
    """In-memory prerequisite DAG. Production loads this from a pack file
    or Postgres row via ``domain_graph_loader``; tests may use the bundled
    demo pack. Thresholds travel with the graph (pack is sole source).
    """

    nodes: dict[str, ConceptNode] = field(default_factory=dict)
    advance_threshold: float = ADVANCE_THRESHOLD
    remediate_threshold: float = REMEDIATE_THRESHOLD

    def prerequisites_of(self, concept_id: str) -> tuple[ConceptNode, ...]:
        node = self.nodes.get(concept_id)
        if node is None:
            return ()
        return tuple(self.nodes[p] for p in node.prerequisites if p in self.nodes)

    def weakest_prerequisite(
        self, concept_id: str, mastery: dict[str, ConceptMastery]
    ) -> ConceptNode | None:
        """The prerequisite with the lowest posterior mastery mean, if any
        falls below the remediation threshold."""
        candidates = [
            (mastery[p.concept_id].mastery_mean if p.concept_id in mastery else 0.0, p)
            for p in self.prerequisites_of(concept_id)
        ]
        below = [(m, p) for m, p in candidates if m < self.remediate_threshold]
        if not below:
            return None
        return min(below, key=lambda pair: pair[0])[1]

    def root_concept_ids(self) -> tuple[str, ...]:
        """Task-graph entry nodes (empty prerequisites), bounded scan."""
        roots = [
            n.concept_id
            for n in self.nodes.values()
            if not n.prerequisites
        ]
        return tuple(roots[:COLD_START_ROOT_SCAN_LIMIT])


def list_unassessed_roots(
    root_concept_ids: tuple[str, ...] | list[str],
    friction_sample_counts: dict[str, int],
    *,
    min_samples: int = CAST_05_MIN_ROOT_FRICTION_SAMPLES,
) -> tuple[str, ...]:
    """Roots still below the CAST-05 assessed-sample threshold."""
    unassessed: list[str] = []
    for concept_id in list(root_concept_ids)[:COLD_START_ROOT_SCAN_LIMIT]:
        if friction_sample_counts.get(concept_id, 0) < min_samples:
            unassessed.append(concept_id)
    return tuple(unassessed)


def cold_start_blocks_advance(
    root_concept_ids: tuple[str, ...] | list[str],
    friction_sample_counts: dict[str, int],
    *,
    min_samples: int = CAST_05_MIN_ROOT_FRICTION_SAMPLES,
) -> bool:
    """True while CAST-05.1 quarantines `advance` for this subject/pack."""
    return bool(
        list_unassessed_roots(
            root_concept_ids,
            friction_sample_counts,
            min_samples=min_samples,
        )
    )


def mastery_evidence_counts(
    mastery: dict[str, ConceptMastery],
) -> dict[str, int]:
    """Per-concept evidence units from mastery G-Counters (Σα + Σβ).

    Matches playground ``evidenceCount`` / edge cold-start seam — not a
    second counting scheme.
    """
    counts: dict[str, int] = {}
    for concept_id, m in list(mastery.items())[:COLD_START_ROOT_SCAN_LIMIT * 4]:
        counts[concept_id] = int(sum(m.alpha.values()) + sum(m.beta.values()))
    return counts


class RouterState(TypedDict):
    """Mutable state threaded through the LangGraph nodes for one turn."""

    subject_id: str
    active_concept_id: str
    mode: GuidanceMode
    friction: FrictionSample
    mastery: dict[str, ConceptMastery]
    # Outputs accumulated by nodes:
    next_concept_id: str
    routing_rationale: str
    guidance_directive: str
    remediation_depth: int


class TaskRouter:
    """Compiles and executes the cyclical Cognitive State Machine.

    One instance is process-global; per-turn state flows through
    ``route_turn`` and is checkpointed by a LangGraph checkpointer selected
    via ``SUTRA_REDIS_URL`` (Redis when reachable; in-memory otherwise).
    """

    MAX_REMEDIATION_DEPTH = 4  # circuit breaker against pathological DAGs

    def __init__(
        self,
        graph: TaskGraph,
        *,
        redis_url: str | None = None,
        checkpointer: object | None = None,
    ) -> None:
        from .checkpointer import select_langgraph_checkpointer

        self.graph = graph
        if checkpointer is not None:
            self._checkpointer = checkpointer
        else:
            self._checkpointer = select_langgraph_checkpointer(redis_url)
        self.checkpoint_backend = getattr(self._checkpointer, "backend_name", "memory")
        self._compiled = self._compile()

    # ── graph construction ──────────────────────────────────────────────

    def _compile(self):
        g: StateGraph = StateGraph(RouterState)

        g.add_node("assess_friction", self._assess_friction)
        g.add_node("remediate_prereq", self._remediate_prereq)
        g.add_node("advance_concept", self._advance_concept)
        g.add_node("generate_guidance", self._generate_guidance)

        g.set_entry_point("assess_friction")

        g.add_conditional_edges(
            "assess_friction",
            self._route_after_assessment,
            {
                "remediate": "remediate_prereq",
                "advance": "advance_concept",
                "continue": "generate_guidance",
            },
        )
        # THE CYCLE: remediation re-enters assessment so a weak prerequisite's
        # own weak prerequisites are discovered recursively, bounded by the
        # remediation-depth circuit breaker.
        g.add_conditional_edges(
            "remediate_prereq",
            self._route_after_remediation,
            {"reassess": "assess_friction", "guide": "generate_guidance"},
        )
        g.add_edge("advance_concept", "generate_guidance")
        g.add_edge("generate_guidance", END)

        return g.compile(checkpointer=self._checkpointer)  # type: ignore[arg-type]

    # ── nodes ───────────────────────────────────────────────────────────

    def _assess_friction(self, state: RouterState) -> dict:
        """Assessment ingress: normalize the turn's friction into routing signals."""
        f = state["friction"]
        spiking = (
            f.hesitationMs > HESITATION_SPIKE_MS
            or f.assistanceRequested
            or f.outcome == "incorrect"
        )
        rationale = (
            f"friction(hesitation={f.hesitationMs}ms, revisions={f.revisionCount}, "
            f"outcome={f.outcome}, assisted={f.assistanceRequested}) → "
            f"{'SPIKE' if spiking else 'nominal'}"
        )
        return {"routing_rationale": rationale}

    def _unassessed_roots(self, state: RouterState) -> tuple[str, ...]:
        counts = mastery_evidence_counts(state["mastery"])
        return list_unassessed_roots(self.graph.root_concept_ids(), counts)

    def _route_after_assessment(
        self, state: RouterState
    ) -> Literal["remediate", "advance", "continue"]:
        concept_id = state["active_concept_id"]
        mastery = state["mastery"]
        mean = mastery[concept_id].mastery_mean if concept_id in mastery else 0.5

        weak_prereq = self.graph.weakest_prerequisite(concept_id, mastery)
        friction_spike = "SPIKE" in state["routing_rationale"]

        if friction_spike and weak_prereq is not None:
            if state.get("remediation_depth", 0) >= self.MAX_REMEDIATION_DEPTH:
                logger.warning(
                    "remediation depth limit hit for subject=%s concept=%s; "
                    "pinning to guided mode instead of recursing",
                    state["subject_id"],
                    concept_id,
                )
                return "continue"
            return "remediate"
        if mean >= self.graph.advance_threshold and not friction_spike:
            unassessed = self._unassessed_roots(state)
            if unassessed:
                logger.info(
                    "coldstart.gate subject_id=%s outcome=block_advance "
                    "obligation=%s unassessed_root_count=%s",
                    state["subject_id"],
                    CAST_05_1_OBLIGATION_ID,
                    len(unassessed),
                )
                return "continue"
            return "advance"
        return "continue"

    def _remediate_prereq(self, state: RouterState) -> dict:
        """Loop-back node: retarget the session at the weakest prerequisite."""
        weak = self.graph.weakest_prerequisite(state["active_concept_id"], state["mastery"])
        assert weak is not None  # guarded by _route_after_assessment
        depth = state.get("remediation_depth", 0) + 1
        return {
            "active_concept_id": weak.concept_id,
            "next_concept_id": weak.concept_id,
            "mode": "prerequisite-remediation",
            "remediation_depth": depth,
            "routing_rationale": (
                state["routing_rationale"]
                + f" | looped back to prerequisite '{weak.concept_id}' (depth {depth})"
            ),
        }

    def _route_after_remediation(self, state: RouterState) -> Literal["reassess", "guide"]:
        """Recurse into the prerequisite's own prerequisites when they are
        also weak; otherwise start guiding on the remediation target."""
        deeper = self.graph.weakest_prerequisite(state["active_concept_id"], state["mastery"])
        if deeper is not None and state["remediation_depth"] < self.MAX_REMEDIATION_DEPTH:
            return "reassess"
        return "guide"

    def _advance_concept(self, state: RouterState) -> dict:
        """Mastery is consolidated; advance to a successor concept."""
        current = state["active_concept_id"]
        successors = [
            n for n in self.graph.nodes.values() if current in n.prerequisites
        ]
        target = successors[0].concept_id if successors else current
        return {
            "next_concept_id": target,
            "mode": "exploratory",
            "routing_rationale": state["routing_rationale"]
            + (
                f" | mastery ≥ {self.graph.advance_threshold}; "
                f"advancing to '{target}'"
            ),
        }

    def _generate_guidance(self, state: RouterState) -> dict:
        """Terminal node: emit the guidance directive consumed by the LLM
        prompt assembler (see ``agent_runtime.py``). The directive is a
        structured instruction, not prose, so any model — cloud LLM or edge
        SLM — can execute it.

        CAST-05.1: while roots lack assessed posterior seeds, force
        ``diagnostic`` mode, probe the first unassessed root, and append an
        advisory to ``routing_rationale`` (never raw learner content).
        """
        rationale = state["routing_rationale"]
        mode: GuidanceMode = state["mode"]
        target = state.get("next_concept_id") or state["active_concept_id"]
        unassessed = self._unassessed_roots(state)
        active = state["active_concept_id"]
        active_in_pack = active in self.graph.nodes

        if (
            unassessed
            and mode != "prerequisite-remediation"
            and active_in_pack
        ):
            probe = unassessed[0]
            target = probe
            mode = "diagnostic"
            rationale = (
                rationale
                + f" | {CAST_05_1_OBLIGATION_ID} cold-start: unassessed_roots="
                + ",".join(unassessed)
                + f"; advance quarantined; diagnostic probe '{probe}'"
            )
            logger.info(
                "coldstart.gate subject_id=%s outcome=block_advance "
                "obligation=%s probe=%s unassessed_root_count=%s",
                state["subject_id"],
                CAST_05_1_OBLIGATION_ID,
                probe,
                len(unassessed),
            )
        elif unassessed and not active_in_pack:
            # Unknown-concept quarantine: keep active target; still surface advisory.
            mode = "diagnostic"
            rationale = (
                rationale
                + f" | {CAST_05_1_OBLIGATION_ID} cold-start: unassessed_roots="
                + ",".join(unassessed)
                + "; advance quarantined (unknown concept held)"
            )
            logger.info(
                "coldstart.gate subject_id=%s outcome=block_advance "
                "obligation=%s unassessed_root_count=%s failureClass=unknown_concept",
                state["subject_id"],
                CAST_05_1_OBLIGATION_ID,
                len(unassessed),
            )
        elif not unassessed:
            logger.info(
                "coldstart.gate subject_id=%s outcome=allow_advance "
                "obligation=%s unassessed_root_count=0",
                state["subject_id"],
                CAST_05_1_OBLIGATION_ID,
            )

        node = self.graph.nodes.get(target)
        title = node.title if node else target
        return {
            "next_concept_id": target,
            "mode": mode,
            "routing_rationale": rationale,
            "guidance_directive": (
                f"GUIDE concept='{title}' mode={mode} "
                f"remediation_depth={state.get('remediation_depth', 0)}"
            ),
        }

    # ── public API ──────────────────────────────────────────────────────

    def route_turn(
        self,
        subject_id: str,
        active_concept_id: str,
        mode: GuidanceMode,
        friction: FrictionSample,
        mastery: dict[str, ConceptMastery],
        *,
        session_id: str | None = None,
    ) -> RouterState:
        """Execute one full pass of the Cognitive State Machine.

        Returns the terminal ``RouterState`` containing the next concept,
        the (possibly changed) guidance mode, the guidance directive, and
        a human-readable routing rationale for the Playground.

        Thread id is derived from ``subject_id`` (and optional ``session_id``)
        so Redis checkpoints cannot bleed across subjects.
        """
        from .checkpointer import checkpoint_thread_id

        thread_id = checkpoint_thread_id(subject_id, session_id=session_id)
        initial: RouterState = {
            "subject_id": subject_id,
            "active_concept_id": active_concept_id,
            "mode": mode,
            "friction": friction,
            "mastery": mastery,
            "next_concept_id": active_concept_id,
            "routing_rationale": "",
            "guidance_directive": "",
            "remediation_depth": 0,
        }
        config = {
            "configurable": {
                "thread_id": thread_id,
                "checkpoint_ns": "",
                "sutra_subject_id": subject_id,
            }
        }
        logger.info(
            "router_turn subject_id=%s thread_id=%s checkpoint_backend=%s outcome=invoke",
            subject_id,
            thread_id,
            self.checkpoint_backend,
        )
        return self._compiled.invoke(initial, config)  # type: ignore[return-value]


def demo_task_graph() -> TaskGraph:
    """Test helper — loads the bundled demo pack (not a second hard-coded graph).

    Production boot uses ``resolve_production_task_graph`` / ``TASK_GRAPH_PACK``.
    """
    from .domain_graph_loader import bundled_demo_pack_path, load_task_graph

    return load_task_graph(
        bundled_demo_pack_path(),
        subject_id="demo-task-graph",
        device_id="test",
        emit_events=False,
    ).graph


def load_task_graph(path: str, **kwargs: object):
    """File-backed pack load path.

    Delegates to ``domain_graph_loader.load_task_graph`` so TS and Python
    consumers share the same fixture-byte semantics.
    """
    from .domain_graph_loader import load_task_graph as _load_task_graph

    return _load_task_graph(path, **kwargs)  # type: ignore[arg-type]
