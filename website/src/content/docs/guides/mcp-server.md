---
title: "MCP server"
description: "Let an AI agent author a complete Koine domain — validate, compile, format, and learn the language over the Model Context Protocol."
---

Koine ships an **MCP server** (`koine-mcp`) that exposes the compiler to AI agents over the
[Model Context Protocol](https://modelcontextprotocol.io). An agent connected to it can author a
complete domain in `.koi` end-to-end: write source, get compiler diagnostics, inspect the generated
C#, and stay grounded in the language — without shelling out to the CLI.

It reuses the exact same parser, validator, and emitters as `koine build`, so what the agent sees
matches what the CLI produces. The server lives in `src/Koine.Mcp` and speaks two transports with the
**same tools**: **stdio** (the default, for editor-spawned clients like Claude Desktop) and **HTTP**
(Streamable HTTP/SSE, so any client connects by URL — see [Over HTTP](#over-http-lm-studio-any-client-by-url)).

## Tools

| Tool | What it does |
|------|--------------|
| `koine_validate` | Parse + full semantic checks over one or many `.koi` files; returns diagnostics with stable codes and 1-based line/column spans. The loop-closer: fix and re-validate until `ok`. |
| `koine_compile` | Run the full pipeline through a target emitter — `csharp` (default), `typescript`, `python`, `glossary`, or `docs` — and return the generated files. |
| `koine_format` | Canonically format a single `.koi` source string. |
| `koine_reference` | A compact cheatsheet of every construct, the type system, and the expression/invariant sublanguage. Call with no topic for the whole thing, or a topic slug (e.g. `value`, `aggregate`, `expressions`, `context-map`) for one section. |
| `koine_examples` | Real, compilable example models — `billing` (small) and the six-context `shop-*` domain — to learn the syntax and idioms. |

The reference and examples are also exposed as **resources** (`koine://reference`,
`koine://reference/{topic}`, `koine://examples/{name}`) for clients that surface those.

A multi-file model is compiled together, so cross-file imports, context maps, and integration events
resolve — pass each file as its own entry in the `files` list.

## Install & register

### Quick install (from a checkout)

If you have the repo cloned, one script packs the server, installs it as a global tool, and
registers it with **Claude Desktop** (merging into your existing `claude_desktop_config.json`
without disturbing other servers):

```bash
./scripts/install-mcp/install-mcp.sh        # macOS / Linux
./scripts/install-mcp/install-mcp.ps1       # any OS with PowerShell
scripts/install-mcp/install-mcp.cmd         # Windows
```

Then fully quit and reopen Claude Desktop. The rest of this section covers manual registration for
other MCP clients (or the published package).

### Manual

The server is packaged as a .NET tool:

```bash
dotnet tool install -g Koine.Mcp     # provides the `koine-mcp` command
```

Then register it with your MCP client. For clients that read an `.mcp.json` (or equivalent
`mcpServers` block):

```json
{
  "mcpServers": {
    "koine": {
      "command": "koine-mcp"
    }
  }
}
```

To run it straight from a checkout instead of the installed tool:

```json
{
  "mcpServers": {
    "koine": {
      "command": "dotnet",
      "args": ["run", "--project", "src/Koine.Mcp"]
    }
  }
}
```

## Over HTTP (LM Studio, any client by URL)

stdio is ideal when the client *spawns* the server, but some clients — **LM Studio**, browser-based
MCP clients — would rather point at a **URL**. The same five tools are served over the SDK's
**Streamable HTTP / SSE** transport, so there are no DLL paths to wire up:

```bash
koine mcp --http               # or: koine-mcp --http
koine mcp --http --port 3001   # pin a port (default 0 = OS-assigned)
```

It binds **loopback only** (`127.0.0.1`) and prints the endpoint to stderr:

```
[koine-mcp] http://127.0.0.1:50286/mcp
```

Point the client at that URL. An LM Studio `mcp.json` collapses to one line:

```json
{
  "mcpServers": {
    "koine": {
      "url": "http://127.0.0.1:50286/mcp"
    }
  }
}
```

:::note
Tools only work with a **tool-capable model** — pick one whose card shows tool/function-calling
support in LM Studio, or the model can't call `koine_validate` & friends.
:::

The bind is loopback, so the surface is local to your machine; there is no auth in this mode (it
isn't meant to be exposed off-host).

### From Koine Studio (desktop)

The desktop build of **Koine Studio** launches the HTTP server for you as a sidecar and surfaces the
endpoint under **Settings → Assistant**, with a **Copy `mcp.json`** button — so connecting LM Studio
to Koine is a single paste. (The browser build can't host a server; use the `koine mcp --http` recipe
above instead.)

## A typical agent loop

1. `koine_reference` / `koine_examples` — learn the syntax (models rarely know Koine cold).
2. Draft the `.koi` model.
3. `koine_validate` — read diagnostics, fix, repeat until `ok` is `true`.
4. `koine_compile` — inspect the generated C# (or TypeScript / Python / glossary / docs).

Because a green compile is snapshot- *and* Roslyn-tested in this repo, `koine_compile` returning
`success` means the emitted C# actually builds.
