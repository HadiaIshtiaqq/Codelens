#!/usr/bin/env sh
# One-time setup on Linux/macOS: Python venv + backend deps, frontend deps + build, sandbox image.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Backend (Python venv)"
cd "$ROOT/backend"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -r requirements-dev.txt
[ -f .env ] || { cp .env.example .env; echo "    created backend/.env (add NEBIUS_API_KEY there)"; }

echo "==> Frontend"
cd "$ROOT/frontend"
npm install --no-audit --no-fund
npm run build

echo "==> Docker sandbox image"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker build -t codelens-worker:latest "$ROOT/backend/worker"
else
  echo "    Docker not available: the app will use the dev sandbox (no container isolation)."
fi
echo "Done. Start with: ./scripts/start.sh"
