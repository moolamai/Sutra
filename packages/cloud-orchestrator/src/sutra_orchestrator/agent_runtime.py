"""Agent runtime — composes router, state store, and memory into turns.

The cloud-side execution engine, isolated from HTTP concerns. One turn:

    1. Load the subject's master cognitive state.
    2. Route through the cyclical task router (assess friction, loop back
       through weak prerequisites, or advance).
    3. Emit the guidance directive for the bound model to execute.

The reference engine returns the directive itself as the reply so the
full routing loop is testable with zero model dependencies; a production
deployment invokes its LLM where the directive is assembled.
"""

from __future__ import annotations

import logging

from .contract_models import AgentTurnRequest, AgentTurnResponse, CognitiveState
from .sync_service import MasterStateStore
from .task_router import TaskRouter

logger = logging.getLogger(__name__)


class UnknownSubjectError(Exception):
    """No cognitive state exists for the subject; the edge must sync first."""


class AgentRuntime:
    """Per-deployment execution engine. Stateless per turn: all subject
    state lives in the master store, all routing state in the router pass."""

    def __init__(self, router: TaskRouter, store: MasterStateStore) -> None:
        self._router = router
        self._store = store

    def get_state(self, subject_id: str) -> CognitiveState | None:
        return self._store.get(subject_id)

    def run_turn(self, request: AgentTurnRequest) -> AgentTurnResponse:
        state = self._store.get(request.subjectId)
        if state is None:
            raise UnknownSubjectError(
                f"no cognitive state for subject '{request.subjectId}'; sync first"
            )

        active = state.activeConceptId or request.friction.conceptId
        result = self._router.route_turn(
            subject_id=request.subjectId,
            active_concept_id=active,
            mode=state.mode,
            friction=request.friction,
            mastery=state.mastery,
        )

        mastery_entry = state.mastery.get(result["next_concept_id"])
        estimate = mastery_entry.mastery_mean if mastery_entry else 0.5

        # The guidance directive is where a production deployment invokes
        # its model. The reference engine returns the directive itself.
        return AgentTurnResponse(
            reply=f"[directive] {result['guidance_directive']}",
            nextConceptId=result["next_concept_id"],
            mode=result["mode"],
            routingRationale=result["routing_rationale"],
            masteryEstimate=round(estimate, 4),
        )
