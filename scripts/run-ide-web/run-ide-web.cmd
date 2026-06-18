@echo off
REM Launch Koine Studio in the browser (WASM compiler, no Tauri).
REM Delegates to run-ide-web.ps1 so the run logic lives in one place.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-ide-web.ps1" %* || exit /b 1
