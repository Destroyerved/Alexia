#!/usr/bin/env bash
# Reset chaos environment and clear blocks
set -euo pipefail

TARGET_HOST="${TARGET_HOST:-http://localhost:8080}"
echo "[Alexia Chaos] Resetting demo environment on ${TARGET_HOST}..."

curl -s -X POST "${TARGET_HOST}/scenarios/reset" | grep -q "success" && echo "✓ Reset successful: Autonomy active, IP blocklist cleared." || echo "Notice: Server response recorded."
