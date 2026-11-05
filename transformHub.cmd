@echo off
rem Double-click to open Transform Workstation. The first run installs dependencies and may show a console for a minute.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-transformHub.ps1" %*
