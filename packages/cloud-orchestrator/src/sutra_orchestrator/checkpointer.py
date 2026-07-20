"""Router checkpoint serialization schema (ATR / A-G4).

Versioned Pydantic contract for LangGraph router state that must survive
orchestrator restart: remediation depth, guidance mode, hysteresis context,
and side-effect markers for resume-without-duplicate-directives.

Redis I/O is wired in . This module only defines keys, payloads,
and validate-on-load semantics: a corrupt or cross-subject blob yields a
clean start + advisory — never a crash loop.

Sovereignty: checkpoints carry routing structure (concept ids, mode, depth,
thresholds, directive shape). They MUST NOT embed learner utterances or
raw CognitiveState documents.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Literal, Mapping

from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

from .contract_models import GuidanceMode

# Keep in sync with TaskRouter.MAX_REMEDIATION_DEPTH (avoid circular import).
_MAX_REMEDIATION_DEPTH_BOUND = 4
# Threshold defaults mirrored from task_router for schema defaults.
_ADVANCE_THRESHOLD_DEFAULT = 0.85
_REMEDIATE_THRESHOLD_DEFAULT = 0.40

logger = logging.getLogger(__name__)

ROUTER_CHECKPOINT_SCHEMA_VERSION: Literal[1] = 1
CHECKPOINT_KEY_PREFIX = "sutra:v1:router_ckpt"

# Typed advisories for load failures (resume semantics consume these later).
ADVISORY_CORRUPT_RESET = "CHECKPOINT_CORRUPT_RESET"
ADVISORY_VERSION_UNSUPPORTED = "CHECKPOINT_VERSION_UNSUPPORTED"
ADVISORY_SUBJECT_MISMATCH = "CHECKPOINT_SUBJECT_MISMATCH"
ADVISORY_MISSING = "CHECKPOINT_MISSING"


class HysteresisContext(BaseModel):
    """ATR-02 dead-band context: τ_a / τ_r and last friction-spike signal.

    Thresholds are persisted so a resumed turn uses the same dead band that
    wrote the checkpoint (future schema versions may migrate values).
    """

    advance_threshold: float = Field(default=_ADVANCE_THRESHOLD_DEFAULT, ge=0.0, le=1.0)
    remediate_threshold: float = Field(default=_REMEDIATE_THRESHOLD_DEFAULT, ge=0.0, le=1.0)
    last_friction_spiked: bool = False
    # True when mastery sits in (τ_r, τ_a) with no spike — hold position.
    hold_position: bool = False

    @model_validator(mode="after")
    def _hysteresis_band(self) -> HysteresisContext:
        if self.remediate_threshold > self.advance_threshold:
            raise ValueError(
                f"remediate_threshold ({self.remediate_threshold}) must be ≤ "
                f"advance_threshold ({self.advance_threshold})"
            )
        return self


class RouterCheckpointPayload(BaseModel):
    """Checkpointable router graph state — schema_version is mandatory."""

    schema_version: Literal[1] = ROUTER_CHECKPOINT_SCHEMA_VERSION
    subject_id: str = Field(min_length=1)
    thread_id: str = Field(min_length=1)
    active_concept_id: str = Field(min_length=1)
    next_concept_id: str = Field(min_length=1)
    mode: GuidanceMode
    remediation_depth: int = Field(
        default=0, ge=0, le=_MAX_REMEDIATION_DEPTH_BOUND
    )
    # Structured GUIDE directive / rationale — never learner utterance text.
    guidance_directive: str = ""
    routing_rationale: str = ""
    hysteresis: HysteresisContext = Field(default_factory=HysteresisContext)
    # Nodes whose durable side effects already ran (resume must not re-fire).
    effects_committed: tuple[str, ...] = ()
    last_completed_node: str | None = None

    @field_validator("subject_id", "thread_id", "active_concept_id", "next_concept_id")
    @classmethod
    def _no_whitespace_only(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be non-empty")
        return value


@dataclass(frozen=True)
class CheckpointLoadResult:
    """Outcome of validate-on-load. ``payload is None`` means start clean."""

    payload: RouterCheckpointPayload | None
    outcome: Literal["hit", "miss", "corrupt_reset", "version_unsupported", "subject_mismatch"]
    advisory: str | None

    @property
    def start_clean(self) -> bool:
        return self.payload is None


def checkpoint_thread_id(subject_id: str, *, session_id: str | None = None) -> str:
    """Derive the LangGraph thread id; session scopes turns when provided."""
    if not subject_id or not subject_id.strip():
        raise ValueError("subject_id must be non-empty")
    if session_id is not None and session_id.strip():
        return f"session:{session_id.strip()}"
    return f"subject:{subject_id.strip()}"


def checkpoint_redis_key(subject_id: str, thread_id: str) -> str:
    """Redis key namespaced by subjectId — cross-subject keys are a defect."""
    if not subject_id or not subject_id.strip():
        raise ValueError("subject_id must be non-empty")
    if not thread_id or not thread_id.strip():
        raise ValueError("thread_id must be non-empty")
    # subject_id is a path segment; reject separators that could escape the namespace.
    if ":" in subject_id or "/" in subject_id:
        raise ValueError("subject_id must not contain ':' or '/'")
    return f"{CHECKPOINT_KEY_PREFIX}:{subject_id}:{thread_id}"


def parse_checkpoint_key_subject(key: str) -> str | None:
    """Extract subject_id from a well-formed checkpoint key, else None."""
    parts = key.split(":", 4)
    # sutra : v1 : router_ckpt : {subject} : {thread...}
    if len(parts) < 5:
        return None
    if parts[0] != "sutra" or parts[1] != "v1" or parts[2] != "router_ckpt":
        return None
    return parts[3] or None


def dumps_router_checkpoint(payload: RouterCheckpointPayload) -> bytes:
    """Serialize to canonical JSON bytes (UTF-8)."""
    data = payload.model_dump(mode="json")
    # Compact separators keep Redis values bounded (NFR).
    import json

    raw = json.dumps(data, separators=(",", ":"), sort_keys=True).encode("utf-8")
    logger.info(
        "router_checkpoint_dump subject_id=%s thread_id=%s outcome=ok "
        "schema_version=%s remediation_depth=%s bytes=%d",
        payload.subject_id,
        payload.thread_id,
        payload.schema_version,
        payload.remediation_depth,
        len(raw),
    )
    return raw


def loads_router_checkpoint(
    blob: bytes | str | None,
    *,
    expected_subject_id: str,
    expected_thread_id: str | None = None,
) -> CheckpointLoadResult:
    """Validate a checkpoint blob. Corrupt / mismatched → clean start + advisory."""
    if blob is None or blob == b"" or blob == "":
        logger.info(
            "router_checkpoint_load subject_id=%s outcome=miss advisory=%s",
            expected_subject_id,
            ADVISORY_MISSING,
        )
        return CheckpointLoadResult(None, "miss", ADVISORY_MISSING)

    if isinstance(blob, bytes):
        try:
            text = blob.decode("utf-8")
        except UnicodeDecodeError:
            logger.warning(
                "router_checkpoint_load subject_id=%s outcome=corrupt_reset "
                "advisory=%s err_type=UnicodeDecodeError",
                expected_subject_id,
                ADVISORY_CORRUPT_RESET,
            )
            return CheckpointLoadResult(None, "corrupt_reset", ADVISORY_CORRUPT_RESET)
    else:
        text = blob

    import json

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.warning(
            "router_checkpoint_load subject_id=%s outcome=corrupt_reset "
            "advisory=%s err_type=JSONDecodeError",
            expected_subject_id,
            ADVISORY_CORRUPT_RESET,
        )
        return CheckpointLoadResult(None, "corrupt_reset", ADVISORY_CORRUPT_RESET)

    if not isinstance(data, dict):
        logger.warning(
            "router_checkpoint_load subject_id=%s outcome=corrupt_reset "
            "advisory=%s err_type=NotObject",
            expected_subject_id,
            ADVISORY_CORRUPT_RESET,
        )
        return CheckpointLoadResult(None, "corrupt_reset", ADVISORY_CORRUPT_RESET)

    version = data.get("schema_version")
    if version is not None and version != ROUTER_CHECKPOINT_SCHEMA_VERSION:
        logger.warning(
            "router_checkpoint_load subject_id=%s outcome=version_unsupported "
            "advisory=%s schema_version=%s",
            expected_subject_id,
            ADVISORY_VERSION_UNSUPPORTED,
            version,
        )
        return CheckpointLoadResult(None, "version_unsupported", ADVISORY_VERSION_UNSUPPORTED)

    try:
        payload = RouterCheckpointPayload.model_validate(data)
    except ValidationError as err:
        logger.warning(
            "router_checkpoint_load subject_id=%s outcome=corrupt_reset "
            "advisory=%s err_type=ValidationError errors=%d",
            expected_subject_id,
            ADVISORY_CORRUPT_RESET,
            err.error_count(),
        )
        return CheckpointLoadResult(None, "corrupt_reset", ADVISORY_CORRUPT_RESET)

    if payload.subject_id != expected_subject_id:
        logger.warning(
            "router_checkpoint_load subject_id=%s outcome=subject_mismatch "
            "advisory=%s payload_subject_id=%s",
            expected_subject_id,
            ADVISORY_SUBJECT_MISMATCH,
            payload.subject_id,
        )
        return CheckpointLoadResult(None, "subject_mismatch", ADVISORY_SUBJECT_MISMATCH)

    if expected_thread_id is not None and payload.thread_id != expected_thread_id:
        logger.warning(
            "router_checkpoint_load subject_id=%s outcome=corrupt_reset "
            "advisory=%s err_type=ThreadMismatch",
            expected_subject_id,
            ADVISORY_CORRUPT_RESET,
        )
        return CheckpointLoadResult(None, "corrupt_reset", ADVISORY_CORRUPT_RESET)

    logger.info(
        "router_checkpoint_load subject_id=%s thread_id=%s outcome=hit "
        "schema_version=%s remediation_depth=%s",
        payload.subject_id,
        payload.thread_id,
        payload.schema_version,
        payload.remediation_depth,
    )
    return CheckpointLoadResult(payload, "hit", None)


def payload_from_router_state(
    state: Mapping[str, Any],
    *,
    thread_id: str,
    last_friction_spiked: bool | None = None,
    effects_committed: tuple[str, ...] = (),
    last_completed_node: str | None = None,
) -> RouterCheckpointPayload:
    """Build a checkpoint payload from a LangGraph ``RouterState`` mapping."""
    subject_id = str(state["subject_id"])
    rationale = str(state.get("routing_rationale") or "")
    spiked = (
        last_friction_spiked
        if last_friction_spiked is not None
        else ("SPIKE" in rationale)
    )
    active = str(state["active_concept_id"])
    mastery = state.get("mastery") or {}
    mean = 0.5
    if isinstance(mastery, dict) and active in mastery:
        entry = mastery[active]
        mean = float(getattr(entry, "mastery_mean", 0.5))

    hold = (
        _REMEDIATE_THRESHOLD_DEFAULT < mean < _ADVANCE_THRESHOLD_DEFAULT and not spiked
    )

    return RouterCheckpointPayload(
        schema_version=ROUTER_CHECKPOINT_SCHEMA_VERSION,
        subject_id=subject_id,
        thread_id=thread_id,
        active_concept_id=active,
        next_concept_id=str(state.get("next_concept_id") or active),
        mode=state["mode"],  # type: ignore[arg-type]
        remediation_depth=int(state.get("remediation_depth") or 0),
        guidance_directive=str(state.get("guidance_directive") or ""),
        routing_rationale=rationale,
        hysteresis=HysteresisContext(
            advance_threshold=_ADVANCE_THRESHOLD_DEFAULT,
            remediate_threshold=_REMEDIATE_THRESHOLD_DEFAULT,
            last_friction_spiked=spiked,
            hold_position=hold,
        ),
        effects_committed=effects_committed,
        last_completed_node=last_completed_node,
    )


# ── LangGraph checkpointer selection ─────────────────────────

from langgraph.checkpoint.memory import MemorySaver  # noqa: E402


def subject_id_from_run_config(config: Mapping[str, Any]) -> str:
    """Resolve subjectId from LangGraph runnable config (sovereignty gate)."""
    configurable = config.get("configurable") or {}
    explicit = configurable.get("sutra_subject_id")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    thread_id = str(configurable.get("thread_id") or "")
    if thread_id.startswith("subject:"):
        return thread_id[len("subject:") :]
    raise ValueError(
        "sutra_subject_id missing from config; required for session-scoped threads"
    )


class RedisHydratingCheckpointer(MemorySaver):
    """MemorySaver that mirrors each thread's checkpoint blob into Redis.

    Keys are subject-namespaced via :func:`checkpoint_redis_key`. Corrupt Redis
    payloads are deleted and treated as a miss (clean start + advisory) — never
    a crash loop. Subclasses ``MemorySaver`` so LangGraph's isinstance gate
    accepts the saver at compile time.
    """

    backend_name = "redis"

    def __init__(self, redis_client: Any) -> None:
        super().__init__()
        self._redis = redis_client

    def _thread_redis_key(self, config: Mapping[str, Any]) -> str:
        configurable = config.get("configurable") or {}
        thread_id = str(configurable["thread_id"])
        subject_id = subject_id_from_run_config(config)
        return checkpoint_redis_key(subject_id, thread_id)

    def _hydrate_thread(self, config: Mapping[str, Any]) -> None:
        import pickle

        configurable = config.get("configurable") or {}
        thread_id = str(configurable["thread_id"])
        subject_id = subject_id_from_run_config(config)
        # Already warm in this process.
        if thread_id in self.storage and self.storage[thread_id]:
            return

        key = checkpoint_redis_key(subject_id, thread_id)
        try:
            raw = self._redis.get(key)
        except Exception as err:
            logger.warning(
                "router_checkpointer subject_id=%s outcome=redis_read_failed "
                "err_type=%s — starting clean",
                subject_id,
                type(err).__name__,
            )
            return

        if not raw:
            logger.info(
                "router_checkpointer subject_id=%s outcome=miss advisory=%s",
                subject_id,
                ADVISORY_MISSING,
            )
            return

        try:
            blob = pickle.loads(raw)
            if not isinstance(blob, dict):
                raise TypeError("checkpoint blob is not a dict")
            storage = blob.get("storage") or {}
            blobs = blob.get("blobs") or {}
            writes = blob.get("writes") or {}
            # Subject isolation: refuse to hydrate if any foreign thread sneaks in.
            for tid in storage:
                if tid != thread_id:
                    raise ValueError("cross-thread checkpoint blob refused")
            self.storage[thread_id] = storage.get(thread_id, {})
            for bk, bv in blobs.items():
                if isinstance(bk, tuple) and bk and bk[0] == thread_id:
                    self.blobs[bk] = bv
            for wk, wv in writes.items():
                if isinstance(wk, tuple) and wk and wk[0] == thread_id:
                    self.writes[wk] = wv
            logger.info(
                "router_checkpointer subject_id=%s thread_id=%s outcome=hydrated",
                subject_id,
                thread_id,
            )
        except Exception as err:
            logger.warning(
                "router_checkpointer subject_id=%s outcome=corrupt_reset "
                "advisory=%s err_type=%s",
                subject_id,
                ADVISORY_CORRUPT_RESET,
                type(err).__name__,
            )
            try:
                self._redis.delete(key)
            except Exception:
                logger.warning(
                    "router_checkpointer subject_id=%s outcome=corrupt_key_delete_failed",
                    subject_id,
                )

    def _persist_thread(self, config: Mapping[str, Any]) -> None:
        import pickle

        configurable = config.get("configurable") or {}
        thread_id = str(configurable["thread_id"])
        subject_id = subject_id_from_run_config(config)
        key = checkpoint_redis_key(subject_id, thread_id)
        payload = {
            "storage": {thread_id: dict(self.storage.get(thread_id, {}))},
            "blobs": {k: v for k, v in self.blobs.items() if k and k[0] == thread_id},
            "writes": {
                k: dict(v) for k, v in self.writes.items() if k and k[0] == thread_id
            },
        }
        try:
            self._redis.set(key, pickle.dumps(payload))
            logger.info(
                "router_checkpointer subject_id=%s thread_id=%s outcome=persisted",
                subject_id,
                thread_id,
            )
        except Exception as err:
            logger.warning(
                "router_checkpointer subject_id=%s outcome=redis_write_failed "
                "err_type=%s — in-memory checkpoint retained",
                subject_id,
                type(err).__name__,
            )

    def get_tuple(self, config: Any) -> Any:
        self._hydrate_thread(config)
        return super().get_tuple(config)

    def put(
        self,
        config: Any,
        checkpoint: Any,
        metadata: Any,
        new_versions: Any,
    ) -> Any:
        result = super().put(config, checkpoint, metadata, new_versions)
        self._persist_thread(config)
        return result

    def put_writes(
        self,
        config: Any,
        writes: Any,
        task_id: str,
        task_path: str = "",
    ) -> None:
        super().put_writes(config, writes, task_id, task_path)
        self._persist_thread(config)


def select_langgraph_checkpointer(
    redis_url: str | None,
) -> Any:
    """Select Redis-backed checkpointer when URL is set; MemorySaver otherwise.

    Redis unavailable → degrade to in-memory with a logged warning (never hard-fail).
    """
    if not redis_url:
        logger.info("router_checkpointer backend=memory outcome=selected")
        saver: Any = MemorySaver()
        saver.backend_name = "memory"  # type: ignore[attr-defined]
        return saver

    try:
        import redis as redis_lib

        client = redis_lib.Redis.from_url(
            redis_url,
            socket_connect_timeout=2.0,
            socket_timeout=2.0,
            decode_responses=False,
        )
        client.ping()
    except Exception as err:
        logger.warning(
            "router_checkpointer backend=memory outcome=degraded "
            "redis_unavailable err_type=%s",
            type(err).__name__,
        )
        saver = MemorySaver()
        saver.backend_name = "memory"  # type: ignore[attr-defined]
        return saver

    logger.info("router_checkpointer backend=redis outcome=selected")
    return RedisHydratingCheckpointer(client)
