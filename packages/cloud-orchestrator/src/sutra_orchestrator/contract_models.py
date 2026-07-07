"""Pydantic mirrors of the wire contract.

The canonical contract lives in ``packages/sync-protocol/src/contract.ts``.
These models MUST stay field-for-field identical to the TypeScript source;
CI drift checks compare the generated JSON Schemas of both sides.

All timestamps are Hybrid Logical Clock strings of the form
``"<physical:15d>:<logical:6d>:<deviceId>"`` whose lexicographic order is
the total order used by every CRDT register.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from . import PROTOCOL_VERSION

HLC_PATTERN = re.compile(r"^\d{15}:\d{6}:[A-Za-z0-9_-]{4,64}$")

GuidanceMode = Literal[
    "exploratory",
    "guided",
    "reinforcement",
    "prerequisite-remediation",
    "diagnostic",
]

Outcome = Literal["correct", "partial", "incorrect", "ungraded"]


def _validate_hlc(value: str) -> str:
    if not HLC_PATTERN.match(value):
        raise ValueError(f"malformed HLC timestamp: {value!r}")
    return value


class FrictionSample(BaseModel):
    """Instantaneous cognitive-friction measurement (the unit of evidence)."""

    conceptId: str = Field(min_length=1)
    hesitationMs: int = Field(ge=0)
    inputVelocity: float = Field(ge=0)
    revisionCount: int = Field(ge=0)
    assistanceRequested: bool
    outcome: Outcome
    capturedAt: str

    _hlc = field_validator("capturedAt")(_validate_hlc)


class ConceptMastery(BaseModel):
    """Beta-posterior mastery pseudo-counts, sharded per device (G-Counters)."""

    conceptId: str = Field(min_length=1)
    alpha: dict[str, float]
    beta: dict[str, float]
    lastExercisedAt: str

    _hlc = field_validator("lastExercisedAt")(_validate_hlc)

    @property
    def mastery_mean(self) -> float:
        """Posterior mean of the Beta distribution with a weak (1,1) prior."""
        a = sum(self.alpha.values()) + 1.0
        b = sum(self.beta.values()) + 1.0
        return a / (a + b)


class SubjectProfile(BaseModel):
    ageBand: Literal["child", "adolescent", "adult"]
    track: str = Field(min_length=1)
    language: str = Field(min_length=2)
    updatedAt: str

    _hlc = field_validator("updatedAt")(_validate_hlc)


class CognitiveState(BaseModel):
    """THE canonical subject document — identical shape on edge, wire, cloud."""

    protocolVersion: Literal["1.0.0"] = PROTOCOL_VERSION  # type: ignore[assignment]
    subjectId: str = Field(min_length=1)
    deviceIds: list[str]
    activeConceptId: str | None
    mode: GuidanceMode
    mastery: dict[str, ConceptMastery]
    frictionLog: list[FrictionSample]
    profile: SubjectProfile
    stateVector: dict[str, str]


class SyncAdvisory(BaseModel):
    code: Literal[
        "CLOCK_SKEW_CLAMPED",
        "DUPLICATE_SAMPLE_DROPPED",
        "UNKNOWN_CONCEPT_QUARANTINED",
        "STATE_VECTOR_REGRESSION",
    ]
    detail: str


class SyncRequest(BaseModel):
    protocolVersion: Literal["1.0.0"] = PROTOCOL_VERSION  # type: ignore[assignment]
    deviceId: str = Field(min_length=4)
    edgeState: CognitiveState
    lastKnownCloudVector: dict[str, str]
    syncAttemptId: str = Field(min_length=8)


class SyncResponse(BaseModel):
    protocolVersion: Literal["1.0.0"] = PROTOCOL_VERSION  # type: ignore[assignment]
    mergedState: CognitiveState
    compactedSampleTimestamps: list[str]
    advisories: list[SyncAdvisory]


class AgentTurnRequest(BaseModel):
    protocolVersion: Literal["1.0.0"] = PROTOCOL_VERSION  # type: ignore[assignment]
    subjectId: str = Field(min_length=1)
    sessionId: str = Field(min_length=1)
    utterance: str
    friction: FrictionSample


class AgentTurnResponse(BaseModel):
    protocolVersion: Literal["1.0.0"] = PROTOCOL_VERSION  # type: ignore[assignment]
    reply: str
    nextConceptId: str
    mode: GuidanceMode
    routingRationale: str
    masteryEstimate: float = Field(ge=0, le=1)
