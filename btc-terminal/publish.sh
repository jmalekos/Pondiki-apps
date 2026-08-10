#!/usr/bin/env bash
# §4 Self-publish — runs ON the Pi, pushes snapshot.json to gh-pages.
# No inbound SSH. Pi pushes outbound to GitHub.
# Privilege: scoped deploy token with push rights to gh-pages only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${SCRIPT_DIR}/../.."  # btc-terminal/ -> repo root
SNAPSHOT="${SCRIPT_DIR}/snapshot.json"

cd "${SCRIPT_DIR}"

# Generate snapshot from the pipeline
echo "[publish] Running pipeline..."
python -m pipeline.main --emit "${SNAPSHOT}" || {
    echo "[publish] ERROR: pipeline failed"
    exit 1
}

cd "${REPO_DIR}"

# Ensure we're on gh-pages
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
if [[ "${BRANCH}" != "gh-pages" ]]; then
    echo "[publish] Switching to gh-pages branch..."
    git fetch origin gh-pages 2>/dev/null || true
    if git show-ref --verify --quiet refs/heads/gh-pages; then
        git checkout gh-pages
    elif git show-ref --verify --quiet refs/remotes/origin/gh-pages; then
        git checkout -b gh-pages origin/gh-pages
    else
        echo "[publish] Creating gh-pages branch..."
        git checkout --orphan gh-pages
        git rm -rf --cached . 2>/dev/null || true
        git commit --allow-empty -m "init: gh-pages branch"
    fi
fi

# Stage the snapshot
git add btc-terminal/snapshot.json

# No change? Skip commit
if git diff --cached --quiet; then
    echo "[publish] No change in snapshot — skipping commit"
    exit 0
fi

git commit -m "snapshot: $(date -u +%FT%TZ)"
git push origin gh-pages

echo "[publish] ✓ Snapshot published"
