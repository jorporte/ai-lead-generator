# Ubuntu deployment with GitHub Actions

This deploys the existing scheduled scraper at `/root/ai-lead-generator`. It does
not add a quote website, run a scan, or publish to social media. The server's
`.env`, `auth/`, `data/` and logs stay on the server. Nothing uploads them to GitHub.

## One-time server setup

Merge the deployment PR, then SSH into the server and run:

```bash
cd /root/ai-lead-generator
git status --short
git pull --ff-only origin main
node --version
mkdir -p /root/ai-lead-generator/logs /root/.cache
command -v flock
```

Resolve any tracked local changes before deployment. Node 22 or later, npm, Git,
OpenSSH and `flock` must be available in the non-interactive SSH PATH. The workflow
checks the app on Node 22; the server also runs its own TypeScript check. Existing
Chromium system libraries must already be installed (as expected for this running
scraper). If browser libraries are missing, install them during server setup with
`./node_modules/.bin/playwright install --with-deps chromium`.

Use `crontab -e` to **replace**, not append to, the two existing entries:

```cron
0 8 * * * /bin/bash /root/ai-lead-generator/scripts/run-cron.sh >> /root/ai-lead-generator/logs/cron.log 2>&1
0 16 * * * /bin/bash /root/ai-lead-generator/scripts/run-cron.sh >> /root/ai-lead-generator/logs/cron.log 2>&1
```

Keep other cron entries unchanged. These times use the server's existing timezone;
they are not automatically converted to Newfoundland time. Wait for any scan
started by the old cron entry to finish, then mark the lock migration complete:

```bash
touch /root/.cache/rebel-dealhunter-cron-lock-ready
```

Both cron and deployment now use `/root/.cache/rebel-dealhunter.lock`. Manual scans
must also use `bash scripts/run-cron.sh`; direct `npm start` bypasses the lock.
Scans wait up to 30 minutes for the lock; deployments wait up to 20 minutes. A lock
timeout fails that run instead of overlapping work.

## SSH access for Actions

Create a dedicated deployment key on your own computer, not in this repository:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/rwt-actions-deploy -C rwt-actions-deploy
```

For unattended Actions use a key without a passphrase. Add its public key to
`/root/.ssh/authorized_keys` on the server. Prefix that authorized-key line with
`restrict ` to disable forwarding, agent forwarding and PTY access. This still
allows shell commands as root, matching the existing root-owned installation;
treat the key as full server access. A future migration to a non-root deployment
user would require moving or granting access to the installation under `/root`.
Do not paste the private key into chat or commit it.

Create a GitHub environment called `production`, limited to the `main` branch,
and add these environment secrets:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | Server public IP or DNS hostname (not the display name unless it resolves); SSH port 22 |
| `DEPLOY_SSH_KEY` | Dedicated private key, including BEGIN/END lines |
| `DEPLOY_KNOWN_HOSTS` | Verified OpenSSH known_hosts line for that exact IP/hostname |

Use the trusted SSH connection or hosting console to verify the server host-key
fingerprint before saving the known_hosts entry. Do not disable host-key checking.
The server continues fetching GitHub through its existing origin credentials;
Actions does not forward its GitHub token to the server.

## Approved deployments only

After setup, choose **Actions → Check and deploy → Run workflow**, on `main`.
Review the result. Deployment does not call `npm start`, preventing an extra
Instagram/Facebook post. The next scheduled scan uses the updated version.

Pushes and merges run checks only. Deployment is exclusively a manual workflow
dispatch on `main`; there is no automatic deployment switch or recurring deploy
schedule. Pull requests run checks without deployment secrets.

Working agreement: prepare and test changes, show the exact version and deployment
plan, obtain Jordan's approval, then deploy at the agreed time. A merge is not
deployment approval. The current workflow runs immediately when dispatched; it
does not itself queue a future deployment. A future timed trigger must pin the
approved commit, preserve that approval, and have authenticated dispatch access
verified before claiming that a deployment has been scheduled. Until that path is
configured, manually dispatch the workflow at the agreed time. Reconfirm if the
version to be deployed changes. Consider required reviewers on the `production`
environment for a further GitHub approval gate where available.

Deployment accepts only a checked commit present in `origin/main` and a clean,
non-divergent main checkout. It uses a fast-forward update and preserves untracked
runtime files. If dependency installation, checking or Chromium installation fails,
it attempts to restore the prior tracked commit and dependencies under the same
lock. This is an in-place deployment, not an atomic release system: rollback also
depends on npm/browser downloads succeeding. If rollback fails, inspect and repair
the server before the next cron scan. Interrupted/lost SSH sessions can also need
manual inspection. Never use `git clean` to repair this installation: it contains
runtime data and secrets.

## References

- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- https://playwright.dev/docs/browsers
