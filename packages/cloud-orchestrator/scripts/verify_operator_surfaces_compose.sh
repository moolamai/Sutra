#!/usr/bin/env bash
# Operator-surface + runbook verification against compose.
# HEALMETREN-003 + OPERRUNB-004
# Usage (from repo root):
#   bash packages/cloud-orchestrator/scripts/verify_operator_surfaces_compose.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/packages/cloud-orchestrator"
python -m pytest -q --tb=short -m compose \
  tests/test_compose_metrics_readiness.py \
  tests/test_compose_runbook_verification.py
