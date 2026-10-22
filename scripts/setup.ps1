# One-time setup: Python venv + backend deps, frontend deps + build, REA toolchain.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "==> Backend (Python venv)" -ForegroundColor Cyan
Push-Location "$root\backend"
if (-not (Test-Path .venv)) { python -m venv .venv }
.\.venv\Scripts\python -m pip install -q --upgrade pip
.\.venv\Scripts\python -m pip install -q -r requirements-dev.txt
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "    created backend\.env (edit it to add NEBIUS_API_KEY)" }
Pop-Location

Write-Host "==> REA toolchain (rea-agents)" -ForegroundColor Cyan
Push-Location "$root\rea"; npm install --no-audit --no-fund; Pop-Location

Write-Host "==> Frontend" -ForegroundColor Cyan
Push-Location "$root\frontend"; npm install --no-audit --no-fund; npm run build; Pop-Location

Write-Host "==> Docker sandbox image (optional)" -ForegroundColor Cyan
if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { docker build -t codelens-worker:latest "$root\backend\worker" }
    else { Write-Host "    Docker is installed but not running; start it and run: docker build -t codelens-worker:latest backend\worker" -ForegroundColor Yellow }
} else {
    Write-Host "    Docker not found; use CODELENS_SANDBOX=subprocess for local development." -ForegroundColor Yellow
}
Write-Host "Done. Start with: .\scripts\start.ps1" -ForegroundColor Green
