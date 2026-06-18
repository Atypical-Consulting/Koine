@echo off
REM Launch Koine Studio — the Tauri desktop IDE for .koi files — in dev mode.
REM Delegates to run-ide.ps1 so the run logic lives in one place.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-ide.ps1" %* || exit /b 1
