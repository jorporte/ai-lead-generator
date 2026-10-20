#!/usr/bin/env bash
set -euo pipefail

target_commit=${1:?Pass the checked Git commit SHA}
[[ "$target_commit" =~ ^[0-9a-f]{40}$ ]] || exit 1
cd /root/ai-lead-generator
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export GIT_TERMINAL_PROMPT=0

mkdir -p /root/.cache
exec 9>/root/.cache/rebel-dealhunter.lock
flock -w 1200 9 || { echo 'Timed out waiting for the scraper lock.' >&2; exit 1; }

# Explicit bootstrap marker: set only after both old cron lines are replaced.
test -f /root/.cache/rebel-dealhunter-cron-lock-ready || {
  echo 'Install the locked cron entries before enabling deployment.' >&2
  exit 1
}
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain --untracked-files=no)" || {
  echo 'Tracked server files have local changes; deployment stopped.' >&2
  exit 1
}
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
test -f .env || { echo 'Existing server .env is missing.' >&2; exit 1; }
mkdir -p auth data logs

git fetch origin main
git cat-file -e "$target_commit^{commit}"
git merge-base --is-ancestor "$target_commit" origin/main
previous_commit=$(git rev-parse HEAD)
# Do not rewind a newer deployment or overwrite divergent server commits.
git merge-base --is-ancestor "$previous_commit" "$target_commit"

rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    echo 'Deployment failed; attempting to restore previous code and dependencies.' >&2
    if git reset --keep "$previous_commit" && npm ci && npm run check && ./node_modules/.bin/playwright install chromium; then
      echo 'Previous version restored.' >&2
    else
      echo 'ROLLBACK FAILED: inspect the server before the next scheduled scan.' >&2
    fi
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

git merge --ff-only "$target_commit"
npm ci
npm run check
# Refresh the browser matching the installed Playwright version, without running a scan.
./node_modules/.bin/playwright install chromium
echo "Deployed $target_commit. The next cron run will use this version."
