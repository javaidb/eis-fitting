@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem Free port 8000 if a stale instance is still holding it
set "killed=0"
for /f "tokens=2,5" %%A in ('netstat -ano ^| findstr LISTENING') do (
    set "addr=%%A"
    if "!addr:~-5!"==":8000" (
        echo Port 8000 is in use by PID %%B - killing it...
        taskkill /F /PID %%B >nul 2>&1
        set "killed=1"
    )
)
if "!killed!"=="1" timeout /t 1 /nobreak >nul

call .venv\Scripts\activate
start http://localhost:8000
uvicorn app:app --reload
