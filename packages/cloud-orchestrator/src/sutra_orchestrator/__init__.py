"""Sutra cloud engine — reference Cognitive State Machine implementation.

FastAPI + LangGraph + pgvector implementation of the Hybrid Cognitive
Sync Protocol's cloud side. Any engine that honors the wire contract
(defined canonically in ``@moolam/sync-protocol``) may replace this one.

Runtime components (all domain-agnostic):
    agent_runtime  — composes router, state store, and memory into turns
    task_router    — cyclical prerequisite-graph routing (LangGraph)
    planner        — goal decomposition and cyclic plan revision
    memory_graph   — pgvector-backed long-term subject memory (MCE)
    sync_service   — CRDT reconciliation over master state documents
    contract_models— Pydantic mirrors of the TypeScript wire contract
    crdt_merge     — the join-semilattice merge (Python twin of the TS engine)
"""

__version__ = "1.1.0"

PROTOCOL_VERSION = "1.0.0"
