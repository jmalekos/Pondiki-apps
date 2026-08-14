#!/usr/bin/env bash
# Self-publish — runs ON the Pi, pushes snapshot.json to GitHub Pages.
# GitHub Pages serves from `main` branch, path `/`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${SCRIPT_DIR}/.."   # btc-terminal/ -> repo root (Pondiki-apps)
SNAPSHOT="${SCRIPT_DIR}/snapshot.json"

# 1. Sync repo to origin/main first (clean base for the commit)
echo "[publish] Syncing repo to origin/main..."
cd "${REPO_DIR}"
git fetch origin main
git checkout main
git reset --hard origin/main

# 2. Generate fresh snapshot (run from btc-terminal/ so `pipeline` pkg resolves)
echo "[publish] Running pipeline..."
cd "${SCRIPT_DIR}"
python -m pipeline.main --emit "${SNAPSHOT}" || {
    echo "[publish] ERROR: pipeline failed"
    exit 1
}

# 3. Commit + push snapshot.json to main
cd "${REPO_DIR}"
git add btc-terminal/snapshot.json

if git diff --cached --quiet; then
    echo "[publish] No change in snapshot — skipping commit"
    exit 0
fi

git commit -m "snapshot: $(date -u +%FT%TZ)"
git push origin main

echo "[publish] ✓ Snapshot published"
