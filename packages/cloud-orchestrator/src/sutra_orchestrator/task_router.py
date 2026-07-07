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


@dataclass(frozen=True)
class ConceptNode:
    """A node in the prerequisite knowledge graph (the domain's task DAG)."""

    concept_id: str
    title: str
    prerequisites: tuple[str, ...] = ()
    age_floor: Literal["child", "adolescent", "adult"] = "child"


@dataclass
class TaskGraph:
    """In-memory prerequisite DAG. Production loads this from Postgres;

    the structure is deliberately trivial so domain teams can author
    tracks as flat rows without graph-database expertise.
    """

    nodes: dict[str, ConceptNode] = field(default_factory=dict)

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
        below = [(m, p) for m, p in candidates if m < REMEDIATE_THRESHOLD]
        if not below:
            return None
        return min(below, key=lambda pair: pair[0])[1]


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
    ``route_turn`` and is checkpointed by LangGraph's Redis-backed saver in
    production (in-memory during tests).
    """

    MAX_REMEDIATION_DEPTH = 4  # circuit breaker against pathological DAGs

    def __init__(self, graph: TaskGraph) -> None:
        self.graph = graph
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

        return g.compile()

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
        if mean >= ADVANCE_THRESHOLD and not friction_spike:
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
            + f" | mastery ≥ {ADVANCE_THRESHOLD}; advancing to '{target}'",
        }

    def _generate_guidance(self, state: RouterState) -> dict:
        """Terminal node: emit the guidance directive consumed by the LLM
        prompt assembler (see ``agent_runtime.py``). The directive is a
        structured instruction, not prose, so any model — cloud LLM or edge
        SLM — can execute it."""
        target = state.get("next_concept_id") or state["active_concept_id"]
        node = self.graph.nodes.get(target)
        title = node.title if node else target
        return {
            "next_concept_id": target,
            "guidance_directive": (
                f"GUIDE concept='{title}' mode={state['mode']} "
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
    ) -> RouterState:
        """Execute one full pass of the Cognitive State Machine.

        Returns the terminal ``RouterState`` containing the next concept,
        the (possibly changed) guidance mode, the guidance directive, and
        a human-readable routing rationale for the Playground.
        """
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
        return self._compiled.invoke(initial)  # type: ignore[return-value]


def demo_task_graph() -> TaskGraph:
    """Tiny task graph spanning two very different domain tracks, used by
    tests and the Playground's simulator."""
    nodes = [
        ConceptNode("math.fractions", "Fractions", ()),
        ConceptNode("math.ratios", "Ratios & Proportion", ("math.fractions",)),
        ConceptNode("math.percentages", "Percentages", ("math.ratios",)),
        ConceptNode("sd.networking", "Networking Basics", (), "adult"),
        ConceptNode("sd.load-balancing", "Load Balancing", ("sd.networking",), "adult"),
        ConceptNode(
            "sd.consistent-hashing", "Consistent Hashing", ("sd.load-balancing",), "adult"
        ),
    ]
    return TaskGraph(nodes={n.concept_id: n for n in nodes})
