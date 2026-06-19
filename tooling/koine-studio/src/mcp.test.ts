import { describe, expect, test } from 'vitest';
import { mcpJsonSnippet } from './mcp';
import { BrowserPlatform } from './host/browser';

describe('mcpJsonSnippet', () => {
  test('wraps the endpoint URL in the mcp.json a client pastes', () => {
    const url = 'http://127.0.0.1:50286/mcp';
    const snippet = mcpJsonSnippet(url);

    // Parses back to exactly { mcpServers: { koine: { url } } } — the shape LM Studio expects.
    expect(JSON.parse(snippet)).toEqual({ mcpServers: { koine: { url } } });
    // Pretty-printed (multi-line) so it is readable when pasted.
    expect(snippet).toContain('\n');
    expect(snippet).toContain('"koine"');
  });

  test('round-trips an arbitrary loopback URL verbatim', () => {
    const url = 'http://localhost:3001/mcp';
    expect(JSON.parse(mcpJsonSnippet(url)).mcpServers.koine.url).toBe(url);
  });
});

describe('BrowserPlatform.mcpEndpoint', () => {
  test('returns null — a browser tab cannot host an MCP server, so the affordance hides', async () => {
    await expect(new BrowserPlatform().mcpEndpoint()).resolves.toBeNull();
  });
});
