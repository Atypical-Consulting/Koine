// @vitest-environment happy-dom
// Unit tests for the MCP section module (extracted from prefs.ts, #987 task 6). Drives buildMcpSection()
// in isolation — no mountPreferencesPane — against the REAL @/settings/persistence module backed by
// happy-dom's localStorage, matching output.section.test.ts's established pattern for these
// section-module tests. The real createJsonView (@/editor/editor) is used too (not mocked), matching
// prefs.test.ts's own MCP-panel tests — CodeMirror's DOM (.cm-editor) is asserted on directly rather than
// spying on a mocked destroy(), since that's the mocking (non-)pattern already established in this repo.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMcpSection } from "@/settings/prefsSections/mcp";
import { buildCtx } from "@/settings/prefsSections/testSupport";
import { DEFAULT_SETTINGS, saveSettings, loadSettings } from "@/settings/persistence";
import type { McpEndpoint } from "@/host/types";

// Flush queued microtasks + timers so the section's async steps (mcpEndpoint, mcpStop, probe) settle —
// mirrors prefs.test.ts's own flush/settle helpers.
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) await flush();
}

const URL = "http://127.0.0.1:51000/mcp";

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
});

const enableToggle = (panel: HTMLElement) =>
    panel.querySelector<HTMLButtonElement>(
        '.koi-switch[aria-label="Enable MCP server"]',
    )!;
const urlInput = (panel: HTMLElement) =>
    panel.querySelector<HTMLInputElement>("#koi-mcp-url")!;
const status = (panel: HTMLElement) =>
    panel.querySelector<HTMLElement>(".koi-mcp-status")!;
const snippetView = (panel: HTMLElement) =>
    panel.querySelector(".koi-mcp-snippet .cm-editor");

describe("buildMcpSection — panel shape", () => {
    it("builds the koi-settings-panel-mcp tabpanel with a mounted CodeMirror recipe view", () => {
        const ctx = buildCtx();
        const section = buildMcpSection(ctx, {
            mcpEndpoint: async () => ({ url: URL, fallback: false }),
            mcpStop: async () => {},
            mcpHostable: true,
        });
        expect(section.panel.id).toBe("koi-settings-panel-mcp");
        expect(section.panel.getAttribute("role")).toBe("tabpanel");
        expect(snippetView(section.panel)).not.toBeNull();
    });
});

describe("buildMcpSection.destroy — supersedes an in-flight enable and tears down the recipe view", () => {
    it("a late endpoint resolve after destroy() does not repaint the (torn-down) panel", async () => {
        // A manually-controlled promise makes the enable→destroy→resolve race deterministic, mirroring
        // prefs.test.ts's "a disable during the on-open (re)start drops the stale resolve" test.
        let resolveEndpoint!: (e: McpEndpoint) => void;
        const mcpEndpoint = vi.fn(
            () => new Promise<McpEndpoint>((res) => (resolveEndpoint = res)),
        );
        const ctx = buildCtx();
        const section = buildMcpSection(ctx, {
            mcpEndpoint,
            mcpStop: vi.fn(async () => {}),
            mcpHostable: true,
        });
        document.body.appendChild(section.panel);
        section.populate(loadSettings());

        enableToggle(section.panel).click(); // fires applyMcpEnabled(true) — endpoint promise still pending
        await flush();
        expect(mcpEndpoint).toHaveBeenCalled();

        section.destroy(); // supersede (bump mcpGen) + tear down the CodeMirror view mid-flight

        // The stale on-enable endpoint resolves AFTER destroy() — must not repaint a live URL.
        resolveEndpoint({ url: URL, fallback: false });
        await settle();

        expect(urlInput(section.panel).value).toBe("");
    });

    it("destroys the CodeMirror recipe view", () => {
        const ctx = buildCtx();
        const section = buildMcpSection(ctx, {
            mcpEndpoint: async () => ({ url: URL, fallback: false }),
            mcpStop: async () => {},
            mcpHostable: true,
        });
        document.body.appendChild(section.panel);
        expect(snippetView(section.panel)).not.toBeNull();

        section.destroy();

        expect(snippetView(section.panel)).toBeNull();
    });

    it("clears the pending copy-confirmation timers without throwing", async () => {
        const ctx = buildCtx();
        const section = buildMcpSection(ctx, {
            mcpEndpoint: async () => ({ url: URL, fallback: false }),
            mcpStop: async () => {},
            mcpHostable: true,
        });
        document.body.appendChild(section.panel);
        section.populate(loadSettings());
        const writeText = vi.fn(() => Promise.resolve());
        Object.defineProperty(navigator, "clipboard", {
            value: { writeText },
            configurable: true,
        });
        const copyBtn = [
            ...section.panel.querySelectorAll<HTMLButtonElement>(
                ".koi-set-action",
            ),
        ].find((b) => b.textContent === "Copy mcp.json")!;
        // No URL yet, so the click is a no-op guard (`if (!url) return`) — just confirms destroy() never
        // throws regardless of whether a copy timer is actually armed.
        copyBtn.click();
        await flush();

        expect(() => section.destroy()).not.toThrow();
    });
});

describe("buildMcpSection — showMcpOff bumps mcpGen internally", () => {
    it("showMcpOff() alone (no external ++mcpGen) still supersedes a stale in-flight enable", async () => {
        let resolveEndpoint!: (e: McpEndpoint) => void;
        const mcpEndpoint = vi.fn(
            () => new Promise<McpEndpoint>((res) => (resolveEndpoint = res)),
        );
        const ctx = buildCtx();
        const section = buildMcpSection(ctx, {
            mcpEndpoint,
            mcpStop: vi.fn(async () => {}),
            mcpHostable: true,
        });
        document.body.appendChild(section.panel);
        section.populate(loadSettings());

        enableToggle(section.panel).click(); // in-flight enable
        await flush();

        section.showMcpOff(); // the caller no longer bumps mcpGen itself — showMcpOff() must do it

        resolveEndpoint({ url: URL, fallback: false });
        await settle();

        expect(urlInput(section.panel).value).toBe("");
        expect(status(section.panel).dataset.state).toBe("off");
    });
});

describe("buildMcpSection.populate", () => {
    it("reflects mcpEnabled/mcpPort/mcpClient and renders the recipe", () => {
        saveSettings({
            ...DEFAULT_SETTINGS,
            mcpEnabled: true,
            mcpPort: 5555,
            mcpClient: "claude-desktop",
        });
        const ctx = buildCtx();
        const section = buildMcpSection(ctx, {
            mcpEndpoint: async () => ({ url: URL, fallback: false }),
            mcpStop: async () => {},
            mcpHostable: true,
        });
        document.body.appendChild(section.panel);

        section.populate(loadSettings());

        expect(enableToggle(section.panel).getAttribute("aria-checked")).toBe(
            "true",
        );
        const portInput =
            section.panel.querySelector<HTMLInputElement>("input.koi-number")!;
        expect(portInput.value).toBe("5555");
        const clientSelect =
            section.panel.querySelector<HTMLSelectElement>(".koi-select")!;
        expect(clientSelect.value).toBe("claude-desktop");
        expect(snippetView(section.panel)).not.toBeNull();
    });
});
