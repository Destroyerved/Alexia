#!/usr/bin/env bash
# S8: Remote Approval Demonstration
set -euo pipefail

TARGET_HOST="${TARGET_HOST:-http://localhost:8080}"
echo "[Alexia Chaos] Triggering Scenario S8: Mobile Remote Step-Up Approval..."
curl -s -X POST "${TARGET_HOST}/scenarios/s8/run"
echo ""
