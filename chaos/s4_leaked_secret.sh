#!/usr/bin/env bash
# S4: Leaked Secret Chaos Trigger
set -euo pipefail

TARGET_HOST="${TARGET_HOST:-http://localhost:8080}"
echo "[Alexia Chaos] Triggering Scenario S4: Leaked Secret (Stripe Key)..."
curl -s -X POST "${TARGET_HOST}/scenarios/s4/run"
echo ""
