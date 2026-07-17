# Foolproof launcher for the EIS fitting dashboard.
# Guarantees that http://localhost:8000 serves THIS checkout, THIS launch:
#   1. Kills whatever holds port 8000 — the whole process tree, including the
#      uvicorn --reload supervisor that would otherwise respawn a stale worker.
#   2. Sweeps stray uvicorn supervisors (e.g. from an old copy of the repo)
#      that aren't currently bound but would resurrect an old server later.
#   3. Verifies the port is genuinely free before starting; aborts loudly if not.
#   4. Starts uvicorn tagged with a unique boot id, and only opens the browser
#      after /api/health echoes that exact id back.

$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot
$Port = 8000

function Get-ListenerPids {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conns) { @($conns | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 }) } else { @() }
}

function Get-RootServerPid([int]$LeafPid) {
    # uvicorn --reload binds the port in a WORKER process; killing only that PID
    # leaves the supervisor alive to respawn it. Climb to the topmost
    # python/uvicorn ancestor so taskkill /T removes the whole family.
    $current = $LeafPid
    for ($i = 0; $i -lt 10; $i++) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
        if (-not $proc -or -not $proc.ParentProcessId) { break }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)" -ErrorAction SilentlyContinue
        if ($parent -and $parent.Name -match 'python|uvicorn') { $current = $parent.ProcessId } else { break }
    }
    return $current
}

Write-Host "== EIS dashboard launcher ==" -ForegroundColor Cyan

# --- 1. Free port 8000, killing full process trees --------------------------
foreach ($ownerPid in Get-ListenerPids) {
    $root = Get-RootServerPid $ownerPid
    Write-Host "Port $Port held by PID $ownerPid - killing process tree rooted at PID $root"
    taskkill /F /T /PID $root 2>$null | Out-Null
}

# --- 2. Sweep stray uvicorn supervisors from any checkout -------------------
$stray = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'uvicorn' -and $_.CommandLine -match 'app:app' }
foreach ($p in $stray) {
    Write-Host "Killing stray uvicorn PID $($p.ProcessId): $($p.CommandLine)"
    taskkill /F /T /PID $p.ProcessId 2>$null | Out-Null
}

# --- 3. Confirm the port is actually free (never launch into a conflict) ----
$tries = 0
while ((Get-ListenerPids).Count -gt 0) {
    $tries++
    if ($tries -gt 40) {
        Write-Host "ERROR: port $Port is still in use and could not be freed." -ForegroundColor Red
        Write-Host "Inspect with: netstat -ano | findstr :$Port" -ForegroundColor Red
        exit 1
    }
    Start-Sleep -Milliseconds 250
}

# --- 4. Start uvicorn from THIS checkout's venv, tagged with a boot id ------
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    Write-Host "ERROR: $python not found - create the venv first." -ForegroundColor Red
    exit 1
}
$bootId = [guid]::NewGuid().ToString()
$env:EIS_BOOT_ID = $bootId
$server = Start-Process -FilePath $python `
    -ArgumentList '-m', 'uvicorn', 'app:app', '--reload', '--port', "$Port" `
    -NoNewWindow -PassThru

# --- 5. Open the browser only after THIS instance answers -------------------
$healthUrl = "http://127.0.0.1:$Port/api/health"
$deadline = (Get-Date).AddSeconds(30)
$verified = $false
while ((Get-Date) -lt $deadline) {
    if ($server.HasExited) {
        Write-Host "ERROR: uvicorn exited during startup - see log above. Browser NOT opened." -ForegroundColor Red
        exit 1
    }
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        if ($health.boot_id -eq $bootId) {
            $verified = $true
            break
        }
        Write-Host "ERROR: a DIFFERENT server answered on port $Port" -ForegroundColor Red
        Write-Host "       (serving '$($health.app_dir)', pid $($health.pid), boot '$($health.boot_id)')." -ForegroundColor Red
        Write-Host "       Kill it manually, then re-run. Browser NOT opened." -ForegroundColor Red
        taskkill /F /T /PID $server.Id 2>$null | Out-Null
        exit 1
    } catch {
        Start-Sleep -Milliseconds 300
    }
}
if (-not $verified) {
    Write-Host "ERROR: server did not become healthy within 30 s. Browser NOT opened." -ForegroundColor Red
    taskkill /F /T /PID $server.Id 2>$null | Out-Null
    exit 1
}

$commit = ''
try { $commit = (& git rev-parse --short HEAD) 2>$null } catch {}
$label = "$PSScriptRoot"
if ($commit) { $label += " @ $commit" }
Write-Host ""
Write-Host "Verified: $label is live on http://localhost:$Port" -ForegroundColor Green
Write-Host ""
Start-Process "http://localhost:$Port"

# Keep the console attached to the server; Ctrl+C / closing the window stops it.
Wait-Process -Id $server.Id
