#!/usr/bin/env bash
# Publish web/ to the gh-pages branch (GitHub Pages serves it). Commit your changes on main first.
# Usage: scripts/deploy_web.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git diff --quiet HEAD -- web; then
  echo "web/ has uncommitted changes; commit them on main first." >&2
  exit 1
fi
rev=$(git subtree split --prefix web HEAD)
git push origin "$rev:refs/heads/gh-pages"
echo "Pushed web/ ($rev) to gh-pages. GitHub Pages redeploys in a minute or two."
