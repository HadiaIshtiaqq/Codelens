# Put CodeLens on a public HTTPS address for judges and Alexa+, from this computer.
#
#   .\scripts\go-public.ps1                 -> new access code, free Cloudflare quick tunnel
#   .\scripts\go-public.ps1 -AccessCode xyz -> use your own code
#   .\scripts\go-public.ps1 -Provider localhostrun -> skip Cloudflare
#
# It starts a free tunnel with no account needed: a Cloudflare quick tunnel (cloudflared is downloaded
# on first use), or localhost.run over SSH if Cloudflare can't be reached. It locks the app with an
# access code, lets /mcp answer on the tunnel's host name, then runs the app. Press Ctrl+C to stop
# both. The address changes every time it is started.
param([string]$AccessCode = "", [ValidateSet("auto", "cloudflare", "localhostrun")][string]$Provider = "auto")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root "tools"
New-Item -ItemType Directory -Force $tools | Out-Null

$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) {
    $cloudflared = Join-Path $tools "cloudflared.exe"
    if (-not (Test-Path $cloudflared)) {
        Write-Host "Downloading cloudflared (Cloudflare's tunnel client)..." -ForegroundColor Cyan
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -UseBasicParsing -OutFile $cloudflared `
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    }
}

# Strangers will run code here, so only the locked-down Docker sandbox is allowed.
docker image inspect codelens-worker:latest *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Going public needs the Docker sandbox: start Docker Desktop, then run .\scripts\setup.ps1 (or: docker build -t codelens-worker:latest backend/worker)."
}

if (-not $AccessCode) { $AccessCode = [guid]::NewGuid().ToString("N").Substring(0, 12) }

$log = Join-Path $tools "tunnel.log"
$url = $null
$tunnel = $null

function Wait-ForUrl($pattern, $failPattern, $seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Test-Path $log)) { continue }
        $match = Select-String -Path $log -Pattern $pattern | Select-Object -First 1
        if ($match) { return $match.Matches[0].Value }
        if ($failPattern -and (Select-String -Path $log -Pattern $failPattern -Quiet)) { return $null }
    }
    return $null
}

# 1) Cloudflare quick tunnel. Its sign-up service sometimes times out, so try twice.
if ($Provider -in "auto", "cloudflare") {
    for ($attempt = 1; $attempt -le 2 -and -not $url; $attempt++) {
        Remove-Item $log -ErrorAction SilentlyContinue
        Write-Host "Opening a Cloudflare tunnel (attempt $attempt)..." -ForegroundColor Cyan
        $tunnel = Start-Process $cloudflared -ArgumentList "tunnel", "--url", "http://127.0.0.1:8000", "--no-autoupdate" `
            -RedirectStandardError $log -WindowStyle Hidden -PassThru
        # The tunnel's own address, not Cloudflare's api.trycloudflare.com that also appears in the log.
        $url = Wait-ForUrl "https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com" "failed to request quick Tunnel" 45
        if (-not $url) { Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue }
    }
}

# 2) localhost.run over SSH (built into Windows 10 and later): no download, no account.
if (-not $url -and $Provider -in "auto", "localhostrun") {
    Remove-Item $log -ErrorAction SilentlyContinue
    Write-Host "Opening a localhost.run tunnel..." -ForegroundColor Cyan
    $tunnel = Start-Process ssh -ArgumentList "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30", `
        "-o", "ExitOnForwardFailure=yes", "-R", "80:127.0.0.1:8000", "nokey@localhost.run" `
        -RedirectStandardOutput $log -RedirectStandardError (Join-Path $tools "tunnel-ssh.log") -WindowStyle Hidden -PassThru
    $url = Wait-ForUrl "https://[a-z0-9]+\.lhr\.life" $null 40
    if (-not $url) { Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue }
}
if (-not $url) { throw "No tunnel could be opened (network?). Details: $log" }

$env:CODELENS_ACCESS_CODE = "judges:$AccessCode"
$env:CODELENS_MCP_PUBLIC_HOSTS = ([uri]$url).Host

Write-Host ""
Write-Host "  CodeLens is public:" -ForegroundColor Green
Write-Host "    Link for judges (code included): $url/#access=$AccessCode" -ForegroundColor Green
Write-Host "    Plain address:                   $url   (access code: $AccessCode)"
Write-Host "    Alexa+ / MCP endpoint:           $url/mcp" -ForegroundColor Green
Write-Host "      header  Authorization: Bearer $AccessCode"
Write-Host "  Press Ctrl+C to stop." -ForegroundColor Yellow
Write-Host ""

try {
    & (Join-Path $PSScriptRoot "start.ps1") -Sandbox docker
} finally {
    Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
}
