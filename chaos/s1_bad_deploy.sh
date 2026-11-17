#!/usr/bin/env bash
# S1: Bad Deploy Chaos Trigger
set -euo pipefail

TARGET_HOST="${TARGET_HOST:-http://localhost:8080}"
echo "[Alexia Chaos] Triggering Scenario S1: Bad Deploy (Division by zero)..."
curl -s -X POST "${TARGET_HOST}/scenarios/s1/run"
echo ""
