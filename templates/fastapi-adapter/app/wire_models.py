"""Wire-compatible SyncRequest/SyncResponse models.

Self-contained copies of the Hybrid Cognitive Sync Protocol envelope so this
adapter never imports sutra-orchestrator internals. Replace with the published
`sutra-orchestrator` package when ready for production merge semantics.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

PROTOCOL_VERSION: Literal["0.1.0"] = "0.1.0"


class CognitiveState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocolVersion: Literal["0.1.0"] = PROTOCOL_VERSION
    subjectId: str = Field(min_length=1)
    deviceIds: list[str] = Field(default_factory=list)
    activeConceptId: str | None = None
    mode: str = "exploratory"
    mastery: dict[str, Any] = Field(default_factory=dict)
    frictionLog: list[Any] = Field(default_factory=list)
    profile: dict[str, Any] = Field(default_factory=dict)
    stateVector: dict[str, str] = Field(default_factory=dict)


class SyncWireHeaders(BaseModel):
    model_config = ConfigDict(extra="forbid")

    traceparent: str | None = None
    tracestate: str | None = None


class SyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocolVersion: Literal["0.1.0"] = PROTOCOL_VERSION
    deviceId: str = Field(min_length=1)
    edgeState: CognitiveState
    lastKnownCloudVector: dict[str, str] = Field(default_factory=dict)
    syncAttemptId: str = Field(min_length=1)
    headers: SyncWireHeaders | None = None


class SyncAdvisory(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    subjectId: str
    detail: str = ""


class SyncResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocolVersion: Literal["0.1.0"] = PROTOCOL_VERSION
    mergedState: CognitiveState
    compactedSampleTimestamps: list[str] = Field(default_factory=list)
    advisories: list[SyncAdvisory] = Field(default_factory=list)
