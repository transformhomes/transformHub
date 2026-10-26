@echo off
rem Double-click to open transformHub. The first run installs dependencies and may show a console for a minute.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-transformHub.ps1" %*
