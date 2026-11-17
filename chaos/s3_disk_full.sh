#!/usr/bin/env bash
# S3: Disk Full Simulation Scenario
set -euo pipefail

TARGET_HOST="${TARGET_HOST:-http://localhost:8080}"
echo "[Alexia Chaos] Triggering Scenario S3: Disk Volume 95% Capacity..."
curl -s -X POST "${TARGET_HOST}/scenarios/s3/run"
echo ""
