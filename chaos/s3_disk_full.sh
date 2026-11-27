#!/usr/bin/env bash
# S3: Disk Full Simulation Scenario (PRD §9.3 allowlist-guarded)
set -euo pipefail

TARGET_HOST="${TARGET_HOST:-http://localhost:8080}"
HOST_ONLY="${TARGET_HOST#*://}"
HOST_ONLY="${HOST_ONLY%%/*}"
HOST_ONLY="${HOST_ONLY%%:*}"
case "${HOST_ONLY}" in
  localhost|127.0.0.1|"[::1]"|shoplite-api|alexia|alexia_sandbox) ;;
  *) echo "ABORT: TARGET_HOST '${TARGET_HOST}' is not on the local/sandbox allowlist (PRD §9.3)." >&2; exit 1 ;;
esac

echo "[Alexia Chaos] Triggering Scenario S3: Disk Volume 95% Capacity..."
curl -fsS -X POST "${TARGET_HOST}/scenarios/s3/run"
echo ""
