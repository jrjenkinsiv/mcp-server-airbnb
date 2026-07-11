#!/usr/bin/env bash
set -euo pipefail

# Fetch and compare only. This script never merges or pushes upstream code.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

upstream_url="https://github.com/openbnb-org/mcp-server-airbnb.git"
upstream_branch="main"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$upstream_url"
fi

git fetch --no-tags upstream "$upstream_branch"
upstream_ref="upstream/$upstream_branch"
upstream_sha="$(git rev-parse "$upstream_ref")"

echo "Fork HEAD:     $(git rev-parse --short HEAD)"
echo "Upstream HEAD: ${upstream_sha:0:12}"

if git merge-base --is-ancestor "$upstream_ref" HEAD; then
  echo "Up to date with upstream."
  exit 0
fi

echo
echo "Upstream changes are available; nothing has been applied."
git log --oneline --decorate HEAD.."$upstream_ref"
echo
if git verify-commit "$upstream_sha" >/dev/null 2>&1; then
  echo "Upstream HEAD has a valid commit signature."
else
  echo "WARNING: Upstream HEAD is not verifiably signed in this clone. Review before merging."
fi
echo
echo "To prepare a reviewed update:"
echo "  git switch -c chore/sync-openbnb-$(date +%Y%m%d)"
echo "  git merge --no-ff $upstream_ref"
echo "  npm ci --ignore-scripts && npm run build && npm audit --omit=dev && node test-extension.js"
