"""Graph planner — goal decomposition over a prerequisite DAG.

The Python twin of the planning contract in ``@moolam/contracts``
(``planning.ts``): compose a plan from goals, revise it under new
evidence, expose the next actionable step. Plans are cyclic-capable by
contract: a revision may route BACK to earlier goals when evidence shows
a foundation is weak.

This reference planner is deliberately simple (topological order over the
goal DAG). Deployments bind richer planners (HTN, LLM-composed, domain
rule engines) behind the same shape.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field, replace
from typing import Literal

logger = logging.getLogger(__name__)

StepStatus = Literal["pending", "active", "done", "blocked", "abandoned"]
RevisionSeverity = Literal["informational", "blocking", "invalidating"]


@dataclass(frozen=True)
class Goal:
    goal_id: str
    description: str
    prerequisites: tuple[str, ...] = ()
    success_criterion: str = ""


@dataclass(frozen=True)
class PlanStep:
    step_id: str
    goal_id: str
    action: str
    depends_on: tuple[str, ...] = ()
    status: StepStatus = "pending"


@dataclass(frozen=True)
class Plan:
    plan_id: str
    steps: tuple[PlanStep, ...]
    rationale: str


@dataclass(frozen=True)
class PlanRevisionEvent:
    observation: str
    step_id: str | None = None
    severity: RevisionSeverity = "informational"


@dataclass
class GraphPlanner:
    """Composes plans by topologically ordering the goal DAG.

    Contract obligations honored:
      1. cyclic-capable: an ``invalidating`` revision reactivates the
         earliest prerequisite step of the affected goal (loop-back).
      2. every revision rewrites ``rationale``; plans never mutate silently.
    """

    _sequence: int = field(default=0)

    def compose(self, goals: list[Goal], context: str) -> Plan:
        ordered = self._topological(goals)
        steps = tuple(
            PlanStep(
                step_id=f"s{i + 1}",
                goal_id=g.goal_id,
                action=f"Work toward: {g.description}",
                depends_on=(f"s{i}",) if i > 0 else (),
                status="active" if i == 0 else "pending",
            )
            for i, g in enumerate(ordered)
        )
        self._sequence += 1
        return Plan(
            plan_id=f"plan-{self._sequence}",
            steps=steps,
            rationale=f"Topological order over {len(goals)} goal(s) for context: {context}",
        )

    def revise(self, plan: Plan, event: PlanRevisionEvent) -> Plan:
        if event.severity == "informational":
            return replace(plan, rationale=f"{plan.rationale} | noted: {event.observation}")

        if event.severity == "blocking" and event.step_id:
            steps = tuple(
                replace(s, status="blocked") if s.step_id == event.step_id else s
                for s in plan.steps
            )
            return replace(
                plan,
                steps=steps,
                rationale=f"{plan.rationale} | blocked {event.step_id}: {event.observation}",
            )

        # Invalidating: loop back. Reactivate the earliest not-done step and
        # reset everything after it, because its foundations are in doubt.
        first_open = next((i for i, s in enumerate(plan.steps) if s.status != "done"), 0)
        loop_to = max(0, first_open - 1)
        steps = tuple(
            replace(s, status="active" if i == loop_to else ("done" if i < loop_to else "pending"))
            for i, s in enumerate(plan.steps)
        )
        return replace(
            plan,
            steps=steps,
            rationale=f"{plan.rationale} | invalidated, looped back to {steps[loop_to].step_id}: {event.observation}",
        )

    def next_step(self, plan: Plan) -> PlanStep | None:
        return next((s for s in plan.steps if s.status == "active"), None)

    @staticmethod
    def _topological(goals: list[Goal]) -> list[Goal]:
        by_id = {g.goal_id: g for g in goals}
        visited: dict[str, bool] = {}
        ordered: list[Goal] = []

        def visit(goal: Goal) -> None:
            state = visited.get(goal.goal_id)
            if state is True:
                return
            if state is False:
                raise ValueError(f"goal cycle detected at '{goal.goal_id}'")
            visited[goal.goal_id] = False
            for pre in goal.prerequisites:
                if pre in by_id:
                    visit(by_id[pre])
            visited[goal.goal_id] = True
            ordered.append(goal)

        for goal in goals:
            visit(goal)
        return ordered
