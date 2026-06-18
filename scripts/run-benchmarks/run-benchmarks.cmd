@echo off
REM Run the Koine compiler benchmarks (BenchmarkDotNet, Release is mandatory).
REM Delegates to run-benchmarks.ps1 so the run logic lives in one place.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-benchmarks.ps1" %* || exit /b 1
