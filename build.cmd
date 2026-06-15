@echo off
REM Build and test Koine.
dotnet build %* || exit /b 1
dotnet test || exit /b 1
