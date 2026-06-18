@echo off
REM Install the Koine MCP server and register it with Claude Desktop.
REM Delegates to install-mcp.ps1 to avoid reimplementing JSON merging in batch.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-mcp.ps1" %* || exit /b 1
