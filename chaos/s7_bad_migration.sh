#!/usr/bin/env bash
# S7: Destructive Database Migration Scenario
set -euo pipefail

TARGET_HOST="${TARGET_HOST:-http://localhost:8080}"
echo "[Alexia Chaos] Triggering Scenario S7: Destructive Drop Column Migration..."
curl -s -X POST "${TARGET_HOST}/scenarios/s7/run"
echo ""
