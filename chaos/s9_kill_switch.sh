#!/usr/bin/env bash
# S9: Autonomy Kill Switch Demonstration
set -euo pipefail

TARGET_HOST="${TARGET_HOST:-http://localhost:8080}"
echo "[Alexia Chaos] Triggering Scenario S9: Pause Autonomy Kill Switch..."
curl -s -X POST "${TARGET_HOST}/scenarios/s9/run"
echo ""
