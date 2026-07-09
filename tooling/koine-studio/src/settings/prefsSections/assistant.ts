// The Assistant (AI) section (extracted from prefs.ts, #987 task 6): provider/base-URL/API-key/model
// fields, sampling temperature (#750), and the Compiler-tools / grammar-constraint mutual exclusion
// (#447) — see syncAiExclusivity below for the collapsing rule (grammar wins).
//
// Two call sites route through ctx.onChange instead of ctx.commit, because both need something
// ctx.commit's single-field-patch shape doesn't expose:
// - aiProviderSelect's change handler calls the raw patchSettings() (imported directly, not through
//   ctx.commit) so it can read the just-switched provider's remembered model back off the RETURN VALUE
//   before reporting it — ctx.commit only reports via cb.onChange internally, it never hands the merged
//   Settings back to the caller.
// - aiKeyInput's change handler saves the secret through saveApiKey (the key lives in the encrypted
//   secret store, not the plaintext settings blob patchSettings writes) then reports the reloaded
//   Settings once the save resolves.
//
// backfillSecret() exposes the on-open secret back-fill that used to run inline in prefs.ts's
// applyOpenState: once whenSecretsReady() resolves, fill aiKeyInput from the decrypted store, UNLESS the
// user already started typing (a non-empty value would be clobbered mid-keystroke).
//
// This module must not import prefs.ts (no import cycles).
import {
    loadSettings,
    patchSettings,
    saveApiKey,
    whenSecretsReady,
    type Settings,
} from "@/settings/persistence";
import {
    row,
    panel,
    toggle,
    select,
    metricInput,
} from "@/settings/prefsControls";
import type { PrefsSection, SectionCtx } from "@/settings/prefsSections/types";

// Assistant temperature bounds (#750); mirrors the load-time clamp in persistence.ts.
const TEMP_MIN = 0;
const TEMP_MAX = 2;
const TEMP_STEP = 0.1;

export function buildAssistantSection(
    ctx: SectionCtx,
): PrefsSection & { backfillSecret(): void } {
    const aiProviderSelect = select([
        { value: "anthropic", label: "Anthropic (Claude)" },
        { value: "openai", label: "OpenAI-compatible" },
    ] as const);

    const aiBaseUrlInput = document.createElement("input");
    aiBaseUrlInput.type = "text";
    aiBaseUrlInput.className = "koi-text";
    aiBaseUrlInput.spellcheck = false;
    aiBaseUrlInput.placeholder = "https://api.openai.com/v1";
    aiBaseUrlInput.setAttribute("list", "koi-ai-base-presets");
    const presets = document.createElement("datalist");
    presets.id = "koi-ai-base-presets";
    for (const url of [
        "https://api.openai.com/v1",
        "http://localhost:11434/v1",
        "http://localhost:1234/v1",
    ]) {
        const opt = document.createElement("option");
        opt.value = url;
        presets.appendChild(opt);
    }

    const aiKeyInput = document.createElement("input");
    aiKeyInput.type = "password";
    aiKeyInput.className = "koi-text";
    aiKeyInput.autocomplete = "off";
    aiKeyInput.placeholder = "sk-…  (blank for local Ollama / LM Studio)";

    const aiModelInput = document.createElement("input");
    aiModelInput.type = "text";
    aiModelInput.className = "koi-text";
    aiModelInput.spellcheck = false;
    aiModelInput.placeholder = "claude-opus-4-8";

    // #447: Compiler tools and grammar-constraint are mutually exclusive — a GBNF that only accepts `.koi`
    // can't also emit the tool-call JSON the agentic loop needs, so with both on the grammar would
    // silently disable the tools. Enabling one CLEARS the other (grammar is the default winner); the
    // losing toggle is greyed by syncAiExclusivity() so the broken pairing can never be set.
    const aiAgenticTools = toggle("Compiler tools", (on) => {
        if (on) aiConstrainGrammar.set(false); // tools win this turn → reflect grammar going off
        ctx.commit(
            on
                ? { aiAgenticTools: true, aiConstrainGrammar: false }
                : { aiAgenticTools: false },
        );
        syncAiExclusivity();
    });
    const aiInlineCompletions = toggle("AI inline completions", (on) =>
        ctx.commit({ aiInlineCompletions: on }),
    );
    const aiConstrainGrammar = toggle(
        "Constrain AI output to the Koine grammar",
        (on) => {
            if (on) aiAgenticTools.set(false); // grammar wins this turn → reflect tools going off
            ctx.commit(
                on
                    ? { aiConstrainGrammar: true, aiAgenticTools: false }
                    : { aiConstrainGrammar: false },
            );
            syncAiExclusivity();
        },
    );

    // Reflect the mutual exclusion in the UI: whichever of the two is on disables (greys) the other, so
    // it can't be turned on alongside. Reads the live aria-checked state so it stays correct after each
    // toggle and on open. A function declaration (hoisted) so the toggle closures above can call it.
    function syncAiExclusivity(): void {
        const toolsOn =
            aiAgenticTools.el.getAttribute("aria-checked") === "true";
        const grammarOn =
            aiConstrainGrammar.el.getAttribute("aria-checked") === "true";
        aiAgenticTools.setDisabled(grammarOn);
        aiConstrainGrammar.setDisabled(toolsOn);
    }

    // Assistant sampling temperature (#750), clamped 0..2; sent on every assistant request (getTemperature).
    const temperatureInput = metricInput(
        TEMP_MIN,
        TEMP_MAX,
        TEMP_STEP,
        () => loadSettings().aiTemperature,
        (v) => ctx.commit({ aiTemperature: v }),
    );
    const temperatureRow = row(
        "Temperature",
        "Assistant sampling temperature (0–2). Lower is steadier; higher is more varied.",
        temperatureInput,
    );

    const baseUrlRow = row(
        "Base URL",
        "Endpoint for the OpenAI-compatible provider.",
        aiBaseUrlInput,
    );
    const agenticToolsRow = row(
        "Compiler tools",
        "Let the model validate, compile and format your model mid-chat. Off keeps replies streaming — some local servers (LM Studio) stop streaming when tools are offered. Mutually exclusive with grammar-constraint below — turn that off to use tools.",
        aiAgenticTools.el,
    );
    const inlineCompletionsRow = row(
        "AI inline completions",
        "Predict the next line as ghost text while you type; Tab accepts, Esc dismisses. Off by default — it sends the surrounding buffer to the provider above on each idle pause, so it spends tokens and no-ops without a configured provider.",
        aiInlineCompletions.el,
    );
    const constrainGrammarRow = row(
        "Constrain AI output to the Koine grammar",
        "Guarantee the assistant's generated .koi parses: grammar-capable local models are constrained to the Koine grammar, while other providers validate-and-repair the model before Apply is enabled. Mutually exclusive with Compiler tools — grammar wins, since a grammar-constrained model can't also call tools.",
        aiConstrainGrammar.el,
    );
    function syncProviderFields(): void {
        const isOpenai = aiProviderSelect.value === "openai";
        baseUrlRow.hidden = !isOpenai;
        // Compiler tool-use is supported on BOTH providers now (the Anthropic adapter advertises the
        // koine tools too — see runAnthropic in ai.ts), so the opt-in applies regardless of provider.
        agenticToolsRow.hidden = false;
        aiModelInput.placeholder = isOpenai
            ? "gpt-4o  ·  qwen2.5-coder  ·  …"
            : "claude-opus-4-8";
    }

    aiProviderSelect.addEventListener("change", () => {
        const aiProvider =
            aiProviderSelect.value === "openai" ? "openai" : "anthropic";
        const merged = patchSettings({ aiProvider });
        // Swap the model field to the model remembered for the now-selected provider, so a Claude id is
        // never left sitting in front of an OpenAI endpoint (and vice-versa).
        aiModelInput.value =
            aiProvider === "openai" ? merged.aiModelOpenai : merged.aiModel;
        syncProviderFields();
        ctx.onChange(merged);
    });
    aiBaseUrlInput.addEventListener("change", () => {
        const url = aiBaseUrlInput.value.trim();
        ctx.commit({ aiBaseUrl: url || "https://api.openai.com/v1" });
    });
    // The key is a secret: it goes through the encrypted store, not the plaintext settings blob.
    aiKeyInput.addEventListener("change", () => {
        void saveApiKey(aiKeyInput.value.trim()).then(() =>
            ctx.onChange(loadSettings()),
        );
    });
    aiModelInput.addEventListener("change", () => {
        const model = aiModelInput.value.trim();
        ctx.commit(
            aiProviderSelect.value === "openai"
                ? { aiModelOpenai: model }
                : { aiModel: model },
        );
    });

    const assistantPanel = panel(
        "assistant",
        row("Provider", "Which API the assistant talks to.", aiProviderSelect),
        baseUrlRow,
        row(
            "API key",
            "Encrypted in this browser and never leaves this device — sent only to the provider you choose.",
            aiKeyInput,
        ),
        row("Model", "The model id the assistant requests.", aiModelInput),
        temperatureRow,
        agenticToolsRow,
        inlineCompletionsRow,
        constrainGrammarRow,
        presets,
    );

    function populate(s: Settings): void {
        aiProviderSelect.value = s.aiProvider;
        aiBaseUrlInput.value = s.aiBaseUrl;
        aiKeyInput.value = s.aiApiKey;
        aiModelInput.value =
            s.aiProvider === "openai" ? s.aiModelOpenai : s.aiModel;
        temperatureInput.value = String(s.aiTemperature);
        // #447: Compiler-tools and grammar-constraint are mutually exclusive. A legacy persisted state with
        // BOTH on is the silently-broken combination → normalize to grammar-wins (tools off) and persist
        // the correction, so the panel never even shows the broken pairing.
        const bothAiOn = s.aiAgenticTools && s.aiConstrainGrammar;
        if (bothAiOn) patchSettings({ aiAgenticTools: false });
        aiAgenticTools.set(bothAiOn ? false : s.aiAgenticTools);
        aiInlineCompletions.set(s.aiInlineCompletions);
        aiConstrainGrammar.set(s.aiConstrainGrammar);
        syncAiExclusivity();
        syncProviderFields();
    }

    // On a very fast first paint the secret may still be decrypting; back-fill the key once it lands, but
    // never clobber a value the user has already started typing. Called from the assembler's
    // applyOpenState, at the same point the inline whenSecretsReady().then(...) block used to run.
    function backfillSecret(): void {
        void whenSecretsReady().then(() => {
            if (aiKeyInput.value === "")
                aiKeyInput.value = loadSettings().aiApiKey;
        });
    }

    return { panel: assistantPanel, populate, backfillSecret };
}
