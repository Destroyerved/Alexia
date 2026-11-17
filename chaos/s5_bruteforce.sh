#!/usr/bin/env bash
# S5: Brute Force Authentication Simulation
set -euo pipefail

TARGET_HOST="${TARGET_HOST:-http://localhost:8080}"
echo "[Alexia Chaos] Triggering Scenario S5: Brute Force Credential Attack..."
curl -s -X POST "${TARGET_HOST}/scenarios/s5/run"
echo ""
