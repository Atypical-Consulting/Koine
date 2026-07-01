#!/usr/bin/env pwsh
# Install the Koine MCP server and register it with Claude Desktop.
# Packs src/Koine.Mcp from this checkout, installs it as a global .NET tool
# (koine-mcp), then merges a `koine` entry into claude_desktop_config.json.
$ErrorActionPreference = "Stop"
# This script lives in scripts/install-mcp/; run from the repo root so the
# relative paths below (Directory.Build.props, src/Koine.Mcp) resolve. Push/Pop
# (in a finally) so the caller's working directory is restored on exit — a bare
# Set-Location would leak into the caller's session.
Push-Location (Join-Path $PSScriptRoot "../..")
try {

# Version to pin, read straight from Directory.Build.props so the install
# resolves the package we just packed rather than something off nuget.org.
$props = Get-Content "Directory.Build.props" -Raw
$version = [regex]::Match($props, "<Version>(.*?)</Version>").Groups[1].Value
if (-not $version) { throw "could not read <Version> from Directory.Build.props" }

# Claude Desktop does not inherit your shell PATH, so it cannot find a bare
# `koine-mcp` on it. We register the absolute path to the tool shim instead.
$toolsDir = Join-Path $HOME ".dotnet/tools"
$bin = Join-Path $toolsDir "koine-mcp"
if ($IsWindows) { $bin += ".exe" }

# Pick the Claude Desktop config path for this OS.
if ($IsWindows) {
    $configDir = Join-Path $env:APPDATA "Claude"
} elseif ($IsMacOS) {
    $configDir = Join-Path $HOME "Library/Application Support/Claude"
} else {
    $configDir = Join-Path $HOME ".config/Claude"
}
$config = Join-Path $configDir "claude_desktop_config.json"

Write-Host "==> Packing Koine.Mcp $version"
$nupkgDir = Join-Path ([System.IO.Path]::GetTempPath()) ("koine-mcp-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $nupkgDir -Force | Out-Null
try {
    dotnet pack src/Koine.Mcp -c Release -o $nupkgDir
    if ($LASTEXITCODE -ne 0) { throw "dotnet pack failed" }

    Write-Host "==> Installing the koine-mcp global tool"
    # `update` installs when absent and upgrades when present — idempotent.
    dotnet tool update --global Koine.Mcp --add-source $nupkgDir --version $version
    if ($LASTEXITCODE -ne 0) { throw "dotnet tool update failed" }
} finally {
    Remove-Item -Recurse -Force $nupkgDir -ErrorAction SilentlyContinue
}

Write-Host "==> Registering koine in $config"
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
if (Test-Path $config) {
    $json = Get-Content $config -Raw | ConvertFrom-Json -AsHashtable
    if ($null -eq $json) { $json = @{} }
} else {
    $json = @{}
}
if (-not $json.ContainsKey("mcpServers") -or $null -eq $json["mcpServers"]) {
    $json["mcpServers"] = @{}
}
$json["mcpServers"]["koine"] = @{ command = $bin }
$json | ConvertTo-Json -Depth 10 | Set-Content $config

Write-Host ""
Write-Host "Done. koine-mcp $version installed and registered."
Write-Host "Quit Claude Desktop completely and reopen it to load the server."
Write-Host "Config: $config"

} finally {
    Pop-Location
}
