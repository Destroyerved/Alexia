#!/usr/bin/env bash
# S2: Crash Chaos Trigger
set -euo pipefail

TARGET_HOST="${TARGET_HOST:-http://localhost:8080}"
echo "[Alexia Chaos] Triggering Scenario S2: Container Crash..."
curl -s -X POST "${TARGET_HOST}/scenarios/s2/run"
echo ""
