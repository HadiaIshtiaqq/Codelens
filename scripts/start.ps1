# Start CodeLens. Serves the built UI and the API on http://127.0.0.1:8000
#   .\scripts\start.ps1            -> Docker sandbox if the daemon and image are available, else dev subprocess sandbox
#   .\scripts\start.ps1 -Dev       -> also start the Vite dev server with hot reload on http://localhost:5173
param([switch]$Dev, [ValidateSet("auto", "docker", "subprocess")][string]$Sandbox = "auto")
$root = Split-Path -Parent $PSScriptRoot

if ($Sandbox -eq "auto") {
    $Sandbox = "subprocess"
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        docker image inspect codelens-worker:latest *> $null
        if ($LASTEXITCODE -eq 0) { $Sandbox = "docker" }
    }
}
if ($Sandbox -eq "subprocess") {
    Write-Host "WARNING: subprocess sandbox has NO container isolation. Use it for local development only." -ForegroundColor Yellow
}
$env:CODELENS_SANDBOX = $Sandbox

if ($Dev) {
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\frontend'; npm run dev"
    Write-Host "UI (hot reload): http://localhost:5173" -ForegroundColor Green
}
Write-Host "API + UI: http://127.0.0.1:8000   (API docs: /docs)" -ForegroundColor Green
Set-Location "$root\backend"
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
