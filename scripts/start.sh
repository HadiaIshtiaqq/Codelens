#!/usr/bin/env sh
# Start CodeLens on Linux/macOS: API + built UI on http://127.0.0.1:8000
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "$CODELENS_SANDBOX" ]; then
  if docker image inspect codelens-worker:latest >/dev/null 2>&1; then export CODELENS_SANDBOX=docker
  else export CODELENS_SANDBOX=subprocess; echo "WARNING: subprocess sandbox has NO container isolation (dev only)"; fi
fi
cd "$ROOT/backend"
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
