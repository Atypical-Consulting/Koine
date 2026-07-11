// The MCP section (Settings → MCP, extracted from prefs.ts, #987 task 6): the desktop shell hosts a
// `koine mcp --http` sidecar; this panel toggles it on/off, shows the right copy-paste recipe per client,
// and self-probes the endpoint to confirm an LLM can reach Koine's tools. The web build can't host a
// server, so the toggle is disabled and only the recipes (pointing at the `koine mcp --http` CLI) are
// shown.
//
// This is the section with the async lifecycle: the sidecar start/stop round-trips through `deps`, two
// copy buttons wired via the shared `@/shell/copyFeedback` helper (#1362), a read-only CodeMirror view
// for the recipe snippet, and mcpGen — a monotonic
// token bumped by every enable/disable/reset/open. A slow async result (endpoint launch, probe) checks
// its captured token before writing the UI and drops itself if a newer action has since superseded it —
// so a late enable can't re-show a URL for a server the user just disabled, and a probe can't overwrite
// "Server off" after a disable.
//
// showMcpOff() bumps mcpGen ITSELF (rather than requiring callers to bump immediately before calling it):
// audited all 4 original call sites (3 in prefs.ts, 1 here in this module) before making that call —
//   1. the initial mount sequence (prefs.ts): `applyOpenState(...); ++mcpGen; showMcpOff();`
//   2. applyMcpEnabled's disable branch (below): `await cb.mcpStop?.(); if (gen !== mcpGen) return; showMcpOff();`
//      — the ONE call site that did NOT pair an immediate ++mcpGen right before the call (it captured
//      `gen` at the top of the function instead). Bumping again inside showMcpOff() here is harmless: the
//      function returns right after (`syncMcpUi(on)`, which doesn't read mcpGen), so nothing in the same
//      tick checks mcpGen after the extra bump.
//   3. the Advanced Reset handler (prefs.ts, outside this module): `void cb.mcpStop?.(); ++mcpGen;
//      showMcpOff(); syncMcpUi(false);`
//   4. startMcpSidecar's "not enabled / not hostable" branch (below): `else { ++mcpGen; showMcpOff(); }`
// Sites 1, 3, and 4 paired an immediate bump with the call, so folding the bump into showMcpOff() itself is
// a pure simplification there; site 2 is harmless per the above. So showMcpOff() now owns the bump, and
// every call site just calls it — see prefs.ts's own destroy()/mount-tail/Advanced-reset-handler and this
// module's startMcpSidecar for the updated (bump-free) call sites.
//
// applyMcpPort / startMcpSidecar (re)launch the sidecar directly through `resolveMcpEndpoint()` — the
// pane-independent startMcpSidecarIfEnabled in prefs.ts re-checks `s.mcpEnabled && mcpHostable !== false`
// internally, but both of ITS call sites here already checked that same condition immediately beforehand
// (applyMcpPort returns early unless enabled+hostable; startMcpSidecar branches on it explicitly), so the
// internal re-check was always a no-op AT THESE CALL SITES — calling the narrower `resolveMcpEndpoint()`
// (already needed here for applyMcpEnabled's "on" branch) is behaviourally identical, and it means this
// module never needs to import prefs.ts's startMcpSidecarIfEnabled (section modules must not import
// prefs.ts — no import cycles). startMcpSidecarIfEnabled itself stays in prefs.ts unchanged: it's a
// public, DOM-free export the JSON Settings representation (which mounts no MCP panel) and prefs.test.ts
// both call directly.
import type { McpEndpoint } from "@/host/types";
import type { Settings } from "@/settings/persistence";
import { loadSettings } from "@/settings/persistence";
import { row, panel, toggle, select, metricInput } from "@/settings/prefsControls";
import { wireCopyButton } from "@/shell/copyFeedback";
import { createJsonView } from "@/editor/editor";
import { mcpJsonSnippet, MCP_CLIENTS, probeMcp } from "@/mcp/mcp";
import type { PrefsSection, SectionCtx } from "@/settings/prefsSections/types";

// MCP sidecar loopback-port bounds (#735 follow-up): a TCP port; 0 = OS-assigned. Mirror the load-time
// clamp in persistence.ts (coerceMcpPort) so what the input accepts == what survives a reload.
const MCP_PORT_MIN = 0;
const MCP_PORT_MAX = 65535;
const MCP_PORT_STEP = 1;

/** What buildMcpSection needs from its host: the same three MCP-shaped PrefsCallbacks members
 *  (mcpEndpoint/mcpStop/mcpHostable), narrowed here so this module doesn't need prefs.ts's full
 *  PrefsCallbacks type (and doesn't import prefs.ts at all — no import cycles). */
export interface McpSectionDeps {
    /** Resolve (and on the desktop, lazily launch) the local MCP HTTP endpoint. Optional: a caller that
     *  doesn't wire it simply never shows a live URL — the row stays on the placeholder. */
    mcpEndpoint?(): Promise<McpEndpoint | null>;
    /** Stop the local MCP sidecar when the user disables it. Optional: a host that never starts one
     *  (browser) can omit it. */
    mcpStop?(): Promise<void>;
    /** Whether this host can actually run the MCP sidecar. Defaults to true when omitted. */
    mcpHostable?: boolean;
}

export function buildMcpSection(
    ctx: SectionCtx,
    deps: McpSectionDeps,
): PrefsSection & {
    showMcpOff(): void;
    syncMcpUi(enabled?: boolean): void;
    startMcpSidecar(): void;
    destroy(): void;
} {
    // URL shown inside HTTP recipes before a live endpoint resolves (or on the web build).
    const MCP_URL_PLACEHOLDER = "http://127.0.0.1:PORT/mcp";

    const mcpEnableToggle = toggle(
        "Enable MCP server",
        (on) => void applyMcpEnabled(on),
    );
    const mcpEnableRow = row(
        "Enable MCP server",
        "Serve Koine’s compiler tools to an external MCP client (LM Studio, Claude Desktop…).",
        mcpEnableToggle.el,
    );

    // A browser tab can't host a server — surfaced as a caption when !mcpHostable.
    const mcpWebHint = document.createElement("p");
    mcpWebHint.className = "koi-mcp-note";
    mcpWebHint.textContent =
        "A browser tab can’t host a server. Run `koine mcp --http` from the CLI, then use the recipe below.";
    mcpWebHint.hidden = true;

    // Endpoint URL (read-only) + Copy mcp.json — the quick path for a URL client.
    const mcpUrlInput = document.createElement("input");
    mcpUrlInput.type = "text";
    mcpUrlInput.className = "koi-text";
    mcpUrlInput.readOnly = true;
    mcpUrlInput.spellcheck = false;
    mcpUrlInput.placeholder = "starting…";
    // This input is appended directly (not via row(), which assigns id/name elsewhere), so give it a
    // stable id/name (Chrome form-field id/name check; the aria-label stays the accessible name).
    mcpUrlInput.id = "koi-mcp-url";
    mcpUrlInput.name = "koi-mcp-url";
    mcpUrlInput.setAttribute("aria-label", "Koine MCP endpoint URL");

    const mcpCopyBtn = document.createElement("button");
    mcpCopyBtn.type = "button";
    mcpCopyBtn.className = "koi-set-action";
    mcpCopyBtn.textContent = "Copy mcp.json";
    // An empty URL (the sidecar hasn't resolved an endpoint yet) is a no-op — this guard is registered
    // BEFORE wireCopyButton's own click listener below, so stopImmediatePropagation can veto the copy
    // (no clipboard write, no label flash) before it runs (same-element listeners fire in registration
    // order). Kept here rather than folded into `getText()` since #1362's shared helper always proceeds
    // on whatever `getText()` returns (a genuinely empty string is a valid copy elsewhere), so an empty
    // MCP endpoint URL needs its own pre-check, not a falsy-string one.
    mcpCopyBtn.addEventListener("click", (e) => {
        if (!mcpUrlInput.value.trim()) e.stopImmediatePropagation();
    });
    const cancelMcpCopyReset = wireCopyButton(mcpCopyBtn, "Copy mcp.json", () =>
        mcpJsonSnippet(mcpUrlInput.value.trim()),
    );

    const mcpControl = document.createElement("div");
    mcpControl.className = "koi-mcp-control";
    mcpControl.append(mcpUrlInput, mcpCopyBtn);
    const mcpEndpointRow = row(
        "Endpoint",
        "The loopback URL a URL-based client connects to.",
        mcpControl,
    );

    // Fixed loopback port (#735 follow-up). A clamped numeric input (0..65535; 0 = OS-assigned). On change it
    // persists mcpPort and restarts the sidecar via the SAME stop→start path the enable toggle uses, so a
    // running server rebinds to the new port and the endpoint/recipe repaint (with a busy-port fallback warning).
    const mcpPortInput = metricInput(
        MCP_PORT_MIN,
        MCP_PORT_MAX,
        MCP_PORT_STEP,
        () => loadSettings().mcpPort,
        (v) => void applyMcpPort(v),
    );
    const mcpPortRow = row(
        "Port",
        "Fixed loopback port for the MCP server (0 = pick automatically). Default 56463.",
        mcpPortInput,
    );

    // Per-client recipe picker.
    const mcpClientSelect = select(
        MCP_CLIENTS.map((c) => ({ value: c.id, label: c.label })),
    );
    mcpClientSelect.addEventListener("change", () => {
        ctx.commit({ mcpClient: mcpClientSelect.value as Settings["mcpClient"] });
        renderRecipe();
    });
    const mcpClientRow = row(
        "Client",
        "Pick your MCP client for its exact setup snippet.",
        mcpClientSelect,
    );

    // The recipe body: a heading + Copy, the snippet, the config hint, and an optional caveat.
    // The snippet is a read-only CodeMirror JSON view (createJsonView) so it's syntax-highlighted like
    // every other code surface in Studio; Copy reads its text back verbatim via getText(). tabIndex
    // keeps the box keyboard-focusable/scrollable (CodeMirror's read-only content isn't in the tab
    // order); the accessible name lives on the view's role=textbox content, so the wrapper doesn't
    // repeat it.
    const mcpSnippet = document.createElement("div");
    mcpSnippet.className = "koi-mcp-snippet";
    mcpSnippet.tabIndex = 0;
    const mcpSnippetView = createJsonView(mcpSnippet);

    const mcpRecipeCopy = document.createElement("button");
    mcpRecipeCopy.type = "button";
    mcpRecipeCopy.className = "koi-set-action";
    mcpRecipeCopy.textContent = "Copy";
    const cancelMcpRecipeReset = wireCopyButton(mcpRecipeCopy, "Copy", () =>
        mcpSnippetView.getText(),
    );

    const mcpRecipeHead = document.createElement("div");
    mcpRecipeHead.className = "koi-mcp-recipe-head";
    const mcpRecipeTitle = document.createElement("span");
    mcpRecipeTitle.className = "koi-set-label";
    mcpRecipeTitle.textContent = "Configuration";
    mcpRecipeHead.append(mcpRecipeTitle, mcpRecipeCopy);

    const mcpRecipeHint = document.createElement("p");
    mcpRecipeHint.className = "koi-mcp-hint";
    const mcpRecipeNote = document.createElement("p");
    mcpRecipeNote.className = "koi-mcp-note";

    const mcpRecipe = document.createElement("div");
    mcpRecipe.className = "koi-mcp-recipe";
    mcpRecipe.append(mcpRecipeHead, mcpSnippet, mcpRecipeHint, mcpRecipeNote);

    function renderRecipe(): void {
        const client =
            MCP_CLIENTS.find((c) => c.id === mcpClientSelect.value) ??
            MCP_CLIENTS[0];
        const url = mcpUrlInput.value.trim() || MCP_URL_PLACEHOLDER;
        mcpSnippetView.setContent(client.snippet(url));
        mcpRecipeHint.textContent = client.configHint;
        mcpRecipeNote.textContent = client.note ?? "";
        mcpRecipeNote.hidden = !client.note;
    }

    // Connection test: Studio probes the endpoint as a minimal MCP client and reports the tool count.
    const mcpTestBtn = document.createElement("button");
    mcpTestBtn.type = "button";
    mcpTestBtn.className = "koi-set-action";
    mcpTestBtn.textContent = "Test connection";

    const mcpStatus = document.createElement("span");
    mcpStatus.className = "koi-mcp-status";
    mcpStatus.setAttribute("role", "status");
    mcpStatus.setAttribute("aria-live", "polite");

    type McpStatusKind = "idle" | "off" | "checking" | "ok" | "fail" | "warn";
    const STATUS_LABEL: Record<McpStatusKind, string> = {
        idle: "Not checked",
        off: "Server off",
        checking: "Checking…",
        ok: "Connected",
        fail: "Not reachable",
        warn: "Port fallback",
    };
    function setMcpStatus(kind: McpStatusKind, text?: string): void {
        mcpStatus.dataset.state = kind;
        mcpStatus.textContent = text ?? STATUS_LABEL[kind];
    }

    const mcpTestControl = document.createElement("div");
    mcpTestControl.className = "koi-mcp-control";
    mcpTestControl.append(mcpTestBtn, mcpStatus);
    const mcpTestRow = row(
        "Connection",
        "Confirm an LLM can reach Koine’s tools at this URL.",
        mcpTestControl,
    );

    // Monotonic token bumped by every enable/disable/reset/open. A slow async result (endpoint launch,
    // probe) checks its captured token before writing the UI and drops itself if a newer action has
    // since superseded it — so a late enable can't re-show a URL for a server the user just disabled,
    // and a probe can't overwrite "Server off" after a disable.
    let mcpGen = 0;

    mcpTestBtn.addEventListener("click", () => void runMcpTest());
    async function runMcpTest(): Promise<void> {
        if (!loadSettings().mcpEnabled) return setMcpStatus("off");
        const url = mcpUrlInput.value.trim();
        if (!url) return setMcpStatus("fail", "No endpoint");
        const gen = ++mcpGen;
        setMcpStatus("checking");
        const result = await probeMcp(url);
        if (gen !== mcpGen) return; // a newer toggle/test ran while we probed — don't clobber its status
        if (result.ok)
            setMcpStatus("ok", `Connected ✓ — ${result.tools.length} tools`);
        else setMcpStatus("fail");
    }

    // Resolve (and on the desktop, lazily launch) the MCP sidecar endpoint, or null if it can't be
    // brought up. DOM-free so callers can guard the write against a newer action via mcpGen.
    async function resolveMcpEndpoint(): Promise<McpEndpoint | null> {
        if (!deps.mcpEndpoint) return null;
        try {
            return (await deps.mcpEndpoint()) ?? null;
        } catch {
            return null;
        }
    }

    // The port number the server actually bound, parsed from its loopback URL (falls back to the raw URL).
    function portFromUrl(url: string): string {
        try {
            return new URL(url).port || url;
        } catch {
            return url;
        }
    }

    // The busy-port fallback warning shown in the status span: the CONFIGURED port was busy, so the host
    // bound the ACTUAL (OS-assigned) one — copied client configs still pointing at the configured port
    // won't reach the server. Requested port = the persisted mcpPort setting; actual = parsed from the URL.
    function fallbackWarning(url: string): string {
        const requested = loadSettings().mcpPort;
        return `Port ${requested} was busy — serving on ${portFromUrl(url)}. Update any copied client configs.`;
    }

    // Paint the "server off" state: no endpoint, the recipe on its placeholder URL, status off. Also bumps
    // mcpGen itself — see the module doc comment above for why this is safe at all 3 original call sites.
    function showMcpOff(): void {
        ++mcpGen;
        mcpUrlInput.value = "";
        renderRecipe();
        setMcpStatus("off");
    }

    // Apply an enable/(re)start result to the UI: reveal the URL + recipe, surface a busy-port fallback as a
    // warning (requested vs actual port), or surface a start failure (a null endpoint means the sidecar
    // never came up) instead of a benign "Not checked".
    function showMcpStarted(endpoint: McpEndpoint | null): void {
        mcpUrlInput.value = endpoint?.url ?? "";
        renderRecipe();
        if (!endpoint) setMcpStatus("fail", "Server didn’t start");
        else if (endpoint.fallback) setMcpStatus("warn", fallbackWarning(endpoint.url));
        else setMcpStatus("idle");
    }

    // Toggle the sidecar: start + reveal the endpoint on enable, stop + clear it on disable.
    async function applyMcpEnabled(on: boolean): Promise<void> {
        const gen = ++mcpGen;
        ctx.commit({ mcpEnabled: on });
        if (on) {
            const endpoint = await resolveMcpEndpoint();
            if (gen !== mcpGen) return; // superseded by a newer toggle/reset — drop this stale result
            showMcpStarted(endpoint);
        } else {
            await deps.mcpStop?.();
            if (gen !== mcpGen) return;
            showMcpOff();
        }
        syncMcpUi(on);
    }

    // Persist a new port and, when a server is actually running here, rebind it: stop the sidecar then
    // (re)start it through the SAME resolveMcpEndpoint path the enable toggle uses (#735), so the
    // endpoint/recipe repaint on the new port (and a busy port surfaces the fallback warning). Guarded by
    // mcpGen so a stale restart can't repaint over a newer toggle/reset. When MCP is disabled (or the host
    // can't serve one) there is nothing running, so the change just persists silently.
    async function applyMcpPort(port: number): Promise<void> {
        ctx.commit({ mcpPort: port });
        const s = loadSettings();
        if (!(s.mcpEnabled && deps.mcpHostable !== false)) return;
        const gen = ++mcpGen;
        await deps.mcpStop?.();
        if (gen !== mcpGen) return;
        const endpoint = await resolveMcpEndpoint();
        if (gen !== mcpGen) return;
        showMcpStarted(endpoint);
    }

    // Reflect enabled state + host capability: the endpoint and test rows only matter when a server is
    // actually running here; the recipes are always useful, so they stay visible.
    function syncMcpUi(enabled: boolean = loadSettings().mcpEnabled): void {
        const hostable = deps.mcpHostable !== false;
        mcpEnableToggle.el.disabled = !hostable;
        mcpWebHint.hidden = hostable;
        mcpEndpointRow.hidden = !hostable || !enabled;
        mcpPortRow.hidden = !hostable || !enabled;
        mcpTestRow.hidden = !hostable || !enabled;
    }

    // The Settings "on show" sidecar (re)start: (re)spawn the desktop sidecar when enabled and reflect the
    // endpoint in THIS panel. Guarded by mcpGen so a stale resolve can't repaint after a newer
    // toggle/reset/close superseded it. The bare mount never calls this, so the opt-in server is never
    // spawned before Settings is shown.
    function startMcpSidecar(): void {
        const s = loadSettings();
        if (s.mcpEnabled && deps.mcpHostable !== false) {
            const gen = ++mcpGen;
            void resolveMcpEndpoint().then((endpoint) => {
                if (gen === mcpGen) showMcpStarted(endpoint);
            });
        } else {
            showMcpOff();
        }
        syncMcpUi(s.mcpEnabled);
    }

    const mcpPanel = panel(
        "mcp",
        mcpEnableRow,
        mcpWebHint,
        mcpEndpointRow,
        mcpPortRow,
        mcpClientRow,
        mcpRecipe,
        mcpTestRow,
    );

    function populate(s: Settings): void {
        mcpEnableToggle.set(s.mcpEnabled);
        mcpPortInput.value = String(s.mcpPort);
        mcpClientSelect.value = s.mcpClient;
        renderRecipe();
    }

    // Supersede any in-flight async (so a late sidecar/probe result can't repaint a torn-down pane), clear
    // pending timers, and destroy the MCP CodeMirror view. Does NOT remove any DOM — the assembler's own
    // destroy() owns the whole pane's layout, not just this section's.
    function destroy(): void {
        ++mcpGen;
        cancelMcpCopyReset();
        cancelMcpRecipeReset();
        mcpSnippetView.destroy();
    }

    return {
        panel: mcpPanel,
        populate,
        showMcpOff,
        syncMcpUi,
        startMcpSidecar,
        destroy,
    };
}
