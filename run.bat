@echo off
rem Thin wrapper - all launch logic (stale-server cleanup, health-verified
rem browser open) lives in launch.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"
