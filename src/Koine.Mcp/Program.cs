using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

// The Koine MCP server. It speaks the Model Context Protocol over stdio so an AI agent
// can author a complete domain in .koi: validate it, compile it to C#/TypeScript/glossary/docs,
// format it, and read the language reference + real examples. Every tool is a thin wrapper over
// the existing Koine.Compiler service API — no compiler changes.
//
// Critical: stdout carries ONLY framed MCP messages, so all logging must go to stderr
// (mirrors the constraint LspServer.Run() enforces for the LSP server).
var builder = Host.CreateApplicationBuilder(args);

builder.Logging.AddConsole(options =>
    options.LogToStandardErrorThreshold = LogLevel.Trace);

builder.Services
    .AddMcpServer()
    .WithStdioServerTransport()
    .WithToolsFromAssembly()
    .WithResourcesFromAssembly();

await builder.Build().RunAsync();
