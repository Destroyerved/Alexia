#!/usr/bin/env bash
# S6: SQL Injection Chaos Trigger (Headline Loop)
set -euo pipefail

TARGET_HOST="${TARGET_HOST:-http://localhost:8080}"
echo "[Alexia Chaos] Triggering Scenario S6: SQL Injection & Data Exposure..."
curl -s -X POST "${TARGET_HOST}/scenarios/s6/run"
echo ""
