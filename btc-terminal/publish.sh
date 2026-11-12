#!/usr/bin/env bash
# Self-publish - runs ON the Pi, emits snapshot.json and deploys to Vercel.
# Weekly timer + on-demand. No GitHub Pages, no git-push churn.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNAPSHOT="${SCRIPT_DIR}/snapshot.json"

# 1. Generate fresh snapshot
echo "[publish] Running pipeline..."
cd "${SCRIPT_DIR}"
python -m pipeline.main --emit "${SNAPSHOT}" || {
    echo "[publish] ERROR: pipeline failed"
    exit 1
}

# 2. Deploy static site to Vercel (index.html + snapshot.json)
echo "[publish] Deploying to Vercel..."
cd "${SCRIPT_DIR}"
vercel --prod --yes

echo "[publish] OK Snapshot deployed to Vercel"
