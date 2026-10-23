#!/usr/bin/env bash
# Put CodeLens on a public HTTPS address for judges and Alexa+, from this computer.
#   ./scripts/go-public.sh            -> new access code, free Cloudflare quick tunnel
#   ./scripts/go-public.sh my-code    -> use your own code
# Needs cloudflared (macOS: brew install cloudflared; Linux: see Cloudflare's downloads).
# Press Ctrl+C to stop. The address changes every time it is started.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
command -v cloudflared >/dev/null || { echo "Install cloudflared first (macOS: brew install cloudflared)."; exit 1; }
# Strangers will run code here, so only the locked-down Docker sandbox is allowed.
docker image inspect codelens-worker:latest >/dev/null 2>&1 || {
  echo "Going public needs the Docker sandbox: start Docker, then ./scripts/setup.sh (or: docker build -t codelens-worker:latest backend/worker)."; exit 1; }
export CODELENS_SANDBOX=docker
code="${1:-$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-12)}"
mkdir -p "$root/tools"
log="$root/tools/tunnel.log"
url=""
tunnel=""
trap '[ -n "$tunnel" ] && kill $tunnel 2>/dev/null || true' EXIT
# Cloudflare's quick-tunnel service sometimes times out; try a few times.
for attempt in 1 2 3; do
  rm -f "$log"
  echo "Opening the tunnel (attempt $attempt)..."
  cloudflared tunnel --url http://127.0.0.1:8000 --no-autoupdate 2>"$log" &
  tunnel=$!
  for _ in $(seq 45); do
    sleep 1
    # The tunnel's own address, not Cloudflare's api.trycloudflare.com that also appears in the log.
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | grep -v '^https://api\.' | head -1 || true)"
    [ -n "$url" ] && break
    grep -q "failed to request quick Tunnel" "$log" && break
  done
  [ -n "$url" ] && break
  kill $tunnel 2>/dev/null || true
done
[ -n "$url" ] || { echo "Cloudflare didn't open a tunnel after 3 tries (network?). Details: $log"; exit 1; }
export CODELENS_ACCESS_CODE="judges:$code"
export CODELENS_MCP_PUBLIC_HOSTS="${url#https://}"
echo
echo "  CodeLens is public:"
echo "    Link for judges (code included): $url/#access=$code"
echo "    Plain address:                   $url   (access code: $code)"
echo "    Alexa+ / MCP endpoint:           $url/mcp"
echo "      header  Authorization: Bearer $code"
echo "  Press Ctrl+C to stop."
echo
"$root/scripts/start.sh"
