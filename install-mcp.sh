#!/usr/bin/env bash
# Install the Koine MCP server and register it with Claude Desktop.
# Packs src/Koine.Mcp from this checkout, installs it as a global .NET tool
# (koine-mcp), then merges a `koine` entry into claude_desktop_config.json.
set -euo pipefail
cd "$(dirname "$0")"

# Version to pin, read straight from Directory.Build.props so the install
# resolves the package we just packed rather than something off nuget.org.
version="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' Directory.Build.props | head -n1)"
if [[ -z "$version" ]]; then
  echo "error: could not read <Version> from Directory.Build.props" >&2
  exit 1
fi

# Claude Desktop does not inherit your shell PATH, so it cannot find a bare
# `koine-mcp` on it. We register the absolute path to the tool shim instead.
tools_dir="${DOTNET_TOOLS_DIR:-$HOME/.dotnet/tools}"
bin="$tools_dir/koine-mcp"

# Pick the Claude Desktop config path for this OS.
case "${OSTYPE:-$(uname -s)}" in
  darwin*|Darwin*) config_dir="$HOME/Library/Application Support/Claude" ;;
  *)               config_dir="$HOME/.config/Claude" ;;
esac
config="$config_dir/claude_desktop_config.json"

echo "==> Packing Koine.Mcp $version"
nupkg_dir="$(mktemp -d)"
trap 'rm -rf "$nupkg_dir"' EXIT
dotnet pack src/Koine.Mcp -c Release -o "$nupkg_dir"

echo "==> Installing the koine-mcp global tool"
# `update` installs when absent and upgrades when present — idempotent.
dotnet tool update --global Koine.Mcp --add-source "$nupkg_dir" --version "$version"

echo "==> Registering koine in $config"
mkdir -p "$config_dir"
if command -v jq >/dev/null 2>&1; then
  tmp="$(mktemp)"
  if [[ -f "$config" ]]; then
    jq --arg cmd "$bin" '.mcpServers.koine = {command: $cmd}' "$config" > "$tmp"
  else
    echo '{}' | jq --arg cmd "$bin" '.mcpServers.koine = {command: $cmd}' > "$tmp"
  fi
  mv "$tmp" "$config"
elif [[ ! -f "$config" ]]; then
  # No jq, but no existing config to preserve — write a fresh one safely.
  cat > "$config" <<EOF
{
  "mcpServers": {
    "koine": {
      "command": "$bin"
    }
  }
}
EOF
else
  # No jq and a config already exists — don't risk corrupting it. Print the
  # snippet and let the user merge it by hand.
  echo "warning: jq not found and $config already exists." >&2
  echo "Add this entry to the \"mcpServers\" object in that file:" >&2
  echo "    \"koine\": { \"command\": \"$bin\" }" >&2
  exit 1
fi

echo
echo "Done. koine-mcp $version installed and registered."
echo "Quit Claude Desktop completely and reopen it to load the server."
echo "Config: $config"
