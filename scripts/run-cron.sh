#!/usr/bin/env bash
set -euo pipefail

cd /root/ai-lead-generator
mkdir -p /root/.cache data logs
exec 9>/root/.cache/rebel-dealhunter.lock
# A scan may wait for a deployment. Never run two scans at the same time.
if ! flock -w 1800 9; then
  echo 'Another scan or deployment still holds the lock; scan skipped.' >&2
  exit 1
fi
exec /usr/bin/npm start
