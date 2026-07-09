// The AI assistant host factory. `createAssistantChat` binds the host deps (provider settings, editor
// context, the compiler/edit tools, persistence) into the send effect behind the declarative
// AssistantChat view (src/ai/components/AssistantChat.tsx — Transcript + ChangeSetPanel + Composer
// over the store's `chat` slice) and returns the small imperative handle the shell consumes
// (focusInput / syncWorkspace / explainSelection).
//
// #990 Task 6 retired the imperative DOM panel that used to live here (transcript bubbles, tool
// cards, the change-set island, the controls row — all repainted by hand): rendering is now Preact
// over the chat slice, and this module keeps ONLY the effectful host logic — the AbortController, the
// agentic turn loop wiring (ai.ts), the grammar-constraint/repair loop (#257/#446), the apply-gate
// (#444/#561), the change-set apply flow with drift detection (#473/#633/#684), the saveChat commit
// points, and the workspace-sync deferral. Ephemeral view state the slice deliberately doesn't carry
// (the API-key/error notice, the "Stopped." marker, the mechanism chip + repair counter, the per-apply
// wording) lives in this factory's closure and re-renders AssistantChat as props.
//
// Needs a user-supplied API key for remote providers (set in Preferences, stored locally). With no
// key it shows a prompt to add one rather than calling the API.
import { createElement, render } from 'preact';
import {
  isLocalProviderUrl,
  runAssistant,
  type AiProvider,
  type ChatMessage,
} from '@/ai/ai';
import {
  chooseMechanism,
  isGrammarCapable,
  parseValidationOutcome,
  probeGrammarCapability,
  repairBudgetFor,
  repairToValid,
  type ConstraintMechanism,
} from '@/ai/grammarConstraint';
// The pure prompt builders + context types (the system/explain/repair prompts) live in ./aiPrompts;
// re-export them so existing importers keep resolving `import { … } from '@/ai/aiPanel'` unchanged,
// and import the subset this factory's turn loop references.
export * from '@/ai/aiPrompts';
import {
  buildExplainPrompt,
  buildRepairPrompt,
  buildSystem,
  WORKSPACE_EDIT_GUIDE,
  type AssistantContext,
} from '@/ai/aiPrompts';
import { AssistantChat } from '@/ai/components/AssistantChat';
import { files } from '@/ai/components/ChangeSetPanel';
import { makeTextCoalescer } from '@/ai/textCoalescer';
import type { ComposerQuickAction } from '@/ai/components/Composer';
import type { TranscriptNotice, TurnMechanism } from '@/ai/components/Transcript';
import { buildDisplayIndex } from '@/ai/assistantTools';
import { createEditSession, type EditSession, type StagedEdit } from '@/ai/editSession';
import { loadChat, saveChat, clearChat } from '@/settings/persistence';
import { appStore, type AppState } from '@/store/index';
import type { ChangeSetFileState, ChatToolCall } from '@/store/slices/chat';
import type { StoreApi } from 'zustand/vanilla';

/**
 * Most parse-and-repair rounds the assistant will attempt before declaring it could not produce a
 * model that parses (issue #257). Each round is a full extra LLM turn (latency + tokens), so this is
 * a small constant rather than the larger {@link import('@/ai/ai').MAX_TOOL_ROUNDS} agentic-loop cap.
 */
export const MAX_REPAIR_ROUNDS: number = 3;

/**
 * The per-send workspace snapshot for multi-file agentic editing (#472): the current text of every
 * `.koi` buffer keyed by its OPAQUE session key (the buffer uri — unique even when two roots of a
 * multi-root workspace hold the same workspace-relative path; single-root/legacy hosts key by relPath),
 * plus each key's workspace-relative display path. The keys seed the per-turn {@link EditSession}; the
 * display paths are what the model (and the change-set review) see.
 */
export interface WorkspaceFilesSnapshot {
  /** Current text per session key (buffer uri, or relPath in single-root hosts). */
  files: Record<string, string>;
  /** Workspace-relative display path per key — NOT unique across the roots of a multi-root workspace. */
  displayPath: Record<string, string>;
}

export interface AssistantPanelOptions {
  container: HTMLElement;
  /**
   * The app store carrying the `chat` slice (transcript + turn lifecycle, #984). Defaults to the
   * app-wide singleton; tests inject their own `createAppStore()` so panels don't leak conversation
   * state across tests — the same injection pattern as `useAppStore`'s two-argument overload.
   */
  store?: StoreApi<AppState>;
  /** The configured provider ('anthropic' | 'openai'). */
  getProvider: () => AiProvider;
  /** The OpenAI-compatible base URL (used only when the provider is 'openai'). */
  getBaseUrl: () => string;
  /** The API key (empty string when unset; not required for local servers). */
  getApiKey: () => string;
  /** The model id to use (provider-appropriate defaults handled in ai.ts). */
  getModel: () => string;
  /** The assistant sampling temperature (Settings → Assistant, #750); omitted ⇒ the provider default. */
  getTemperature?: () => number;
  /** The current editor model + diagnostics, captured fresh on each send (may be async). */
  getContext: () => AssistantContext | Promise<AssistantContext>;
  /** The current editor selection (the construct to explain), or null when there's nothing useful. */
  getSelection: () => { text: string } | null;
  /** Replace the active editor document with a generated model. */
  onApplyModel: (source: string) => void;
  /** Open Preferences (so the user can add their API key). */
  onOpenPrefs: () => void;
  /**
   * The per-workspace storage key for the conversation (the folder identity, or the literal
   * 'scratch' in scratch mode), so each opened folder keeps its own transcript across reloads.
   */
  getWorkspaceKey: () => string;
  /**
   * Execute a Koine compiler tool (validate/compile/format) by name with JSON args, for the
   * assistant's tool loop (OpenAI-compatible path). Omitted when the host can't run tools, in which
   * case the assistant stays plain chat.
   */
  runCompilerTool?: (name: string, argsJson: string) => Promise<string>;
  /**
   * Whether to advertise the compiler tools to the model. Off keeps replies streaming — local
   * servers (LM Studio / Ollama) buffer the whole completion when tools are present. When false we
   * withhold `runCompilerTool` so ai.ts runs a plain single-round streaming chat.
   */
  getUseTools: () => boolean;
  /**
   * Whether to constrain/guarantee the assistant's generated `.koi` parses (issue #257, on by default).
   * When on: a grammar-capable local backend has its decoding constrained by the GBNF; every other
   * provider validates-and-repairs the candidate, and "Apply to editor" stays disabled until it parses.
   */
  getConstrainGrammar: () => boolean;
  /**
   * Fetch the llama.cpp GBNF grammar from the host, to constrain a grammar-capable local model's
   * decoding (issue #257). Browser-host ONLY — the desktop host omits it, in which case the panel
   * falls back to the parse-and-repair path. Fetched defensively (a throw is treated as "unavailable").
   */
  getGrammar?: () => Promise<string>;
  /**
   * Snapshot the open workspace's .koi files (key→current-text plus key→display-relPath, #472),
   * captured fresh per send. When present & non-empty together with {@link runEditTool}, the
   * assistant can edit ACROSS files.
   */
  getWorkspaceFiles?: () => WorkspaceFilesSnapshot;
  /** Host executor for the list/read/write edit tools against the per-turn staging session. */
  runEditTool?: (name: string, argsJson: string, session: EditSession) => Promise<string>;
  /**
   * Validate the WHOLE staged workspace once, at end of an agentic turn (host-supplied: browser WASM
   * `DiagnoseWorkspace`, desktop MCP `koine_validate`). Wired into the request so `runToolLoop` runs it
   * a SINGLE time after the turn instead of after each `koine_write_file` (issue #474); the resulting
   * diagnostics are shown in the change-set panel for pre-apply review.
   */
  validateStaged?: (session: EditSession) => Promise<string>;
  /**
   * Commit an accepted multi-file change set: write each accepted file through the workspace
   * controller (new files under the folder root), then re-validate. Resolves with the relPaths whose
   * write FAILED (empty when all succeeded) so the panel can report a partial apply instead of a
   * false "Applied ✓".
   */
  onApplyChangeSet?: (files: StagedEdit[]) => Promise<{ failed: string[] }>;
}

export interface AssistantPanel {
  /** Move keyboard focus into the prompt input. */
  focusInput(): void;
  /**
   * Re-point the panel at the current workspace's conversation when the folder changed: rehydrate the
   * chat slice from storage. A no-op when the workspace key is unchanged, so the host can call it on
   * every tab show without recreating the panel. Deferred until the in-flight request settles when one
   * is streaming (a mid-stream hydrate would swap the transcript out from under the turn being
   * committed — the slice's own no-op is the belt-and-braces half).
   */
  syncWorkspace(): void;
  /**
   * Explain the current construct (the editor selection, or the whole model when there's none) in
   * plain language — an explanatory turn that does NOT offer to apply anything. For the command palette.
   */
  explainSelection(): void;
}

/**
 * The model source from a markdown reply: prefer a ```koine / ```koi fenced block (tolerating an
 * info string and trailing whitespace on the opening fence — e.g. ```koine billing.koi), and fall
 * back to the first fenced block of any language. Returns null when there is no fenced block.
 */
function extractKoine(markdown: string): string | null {
  const koine = markdown.match(/```[ \t]*(?:koine|koi)\b[^\n]*\n([\s\S]*?)```/);
  if (koine) return koine[1].replace(/\n+$/, '');
  const any = markdown.match(/```[^\n]*\n([\s\S]*?)```/);
  return any ? any[1].replace(/\n+$/, '') : null;
}

export function createAssistantChat(opts: AssistantPanelOptions): AssistantPanel {
  // The transcript + turn lifecycle live in the app store's `chat` slice (#984): chat.messages is
  // the conversation for the workspace this panel is pointed at, chat.workspaceKey tracks which one,
  // and chat.status drives the busy treatment. Restored from storage on mount and re-pointed by
  // syncWorkspace() when the folder changes.
  const store = opts.store ?? appStore;
  const chat = () => store.getState().chat;
  store.getState().hydrateChat(opts.getWorkspaceKey(), loadChat(opts.getWorkspaceKey()));

  let aborter: AbortController | null = null;

  // --- ephemeral view state the slice deliberately doesn't carry (never persisted) --------------
  // Each field re-renders AssistantChat as a prop when it changes; the durable conversation renders
  // from the chat slice, to which the components subscribe on their own.
  let notice: TranscriptNotice | null = null;
  let stoppedPartial = false;
  let mechanismView: TurnMechanism | null = null;
  // The trailing turn's settled tool cards: snapshotted off the ephemeral chat.turn at commit time so
  // they stay visible above the reply after the turn ends (as the imperative transcript kept them).
  let toolCardsView: readonly ChatToolCall[] | null = null;
  // The live apply-gate (#444): registered per generative turn BEFORE the reply commits, so the
  // committed bubble's `getApplyCandidate` call resolves with THIS turn's validated (possibly
  // repaired, #257) candidate instead of re-running the legacy re-validation.
  let liveGate: { content: string; promise: Promise<string | null> } | null = null;

  function busy(): boolean {
    return chat().status === 'streaming';
  }

  // The validate seam for the apply-gate: adapt the host's `koine_validate` tool (in-WASM in the
  // browser, the MCP sidecar on desktop) into a {ok, diagnostics}. Null when the host can't run tools,
  // in which case the gate is skipped (we can't parse, so we fall back to the unguarded affordance).
  function makeValidate(): ((source: string) => Promise<{ ok: boolean; diagnostics: string }>) | null {
    const run = opts.runCompilerTool;
    if (!run) return null;
    return async (source) => parseValidationOutcome(await run('koine_validate', JSON.stringify({ source })));
  }

  // Should a model-bearing LEGACY turn (transcript replay / stop-mid-stream partial) offer Apply?
  // With the constraint toggle OFF the apply-gate claims nothing, so behave as the legacy path always
  // did — offer Apply for any extracted model. With it ON, run the live path's validate adapter and
  // offer Apply only when the model parses; fail CLOSED (no Apply) when the adapter is unavailable or
  // throws, since we then can't prove the model is valid (#444).
  async function shouldOfferApply(koine: string): Promise<boolean> {
    if (!opts.getConstrainGrammar()) return true;
    const validate = makeValidate();
    if (!validate) return false;
    try {
      return (await validate(koine)).ok;
    } catch {
      return false;
    }
  }

  // The apply-gate behind every assistant bubble's "Apply to editor" affordance. A STABLE closure
  // (the bubble's mount effect depends on it — a fresh identity per render would re-validate every
  // bubble on every re-render). The LIVE turn resolves through `liveGate` (whose candidate may be the
  // REPAIRED source, not the text in the markdown); the two legacy entry points — transcript replay
  // and the stop-mid-stream partial — re-validate here (#444), recovering a BARE grammar-constrained
  // candidate (no ```koine fence) when the constraint toggle is on (#561) and staying fenced-only
  // (never validating) when it's off.
  const getApplyCandidate = async (markdown: string): Promise<string | null> => {
    const gate = liveGate;
    if (gate && gate.content === markdown) return gate.promise;
    const candidate = extractKoine(markdown) ?? (opts.getConstrainGrammar() ? markdown.trim() || null : null);
    if (!candidate) return null;
    return (await shouldOfferApply(candidate)) ? candidate : null;
  };

  // The canned quick-action prompts by Composer identity; each is built from FRESH editor context.
  const QUICK_PROMPTS: Record<ComposerQuickAction, (ctx: AssistantContext) => string> = {
    'explain-diagnostics': (ctx) =>
      ctx.diagnostics.length
        ? 'Explain each current diagnostic in plain language and show how to fix it.'
        : 'The model currently compiles with no diagnostics. Point out any latent modeling risks anyway.',
    'suggest-invariants': () =>
      'Suggest domain invariants this model is probably missing, with the Koine syntax to add each.',
    'review-model': () =>
      'Review this model for DDD smells (anemic types, leaked identity, missing aggregates, wrong boundaries) and suggest concrete fixes.',
    'add-aggregate': () =>
      'Propose one additional aggregate that would round out this domain, and give the full updated model.',
  };

  // Drop the trailing-turn ephemera (the notice/error bubble, the "Stopped." marker, the mechanism
  // chip/counter, the live gate) — called whenever the transcript moves on: a new send, a workspace
  // swap, Clear conversation. The caller re-renders.
  function clearTurnEphemera(): void {
    notice = null;
    stoppedPartial = false;
    mechanismView = null;
    toolCardsView = null;
    liveGate = null;
  }

  function focusComposer(): void {
    opts.container.querySelector<HTMLTextAreaElement>('.koi-assistant-input')?.focus();
  }

  // (Re)render AssistantChat with the current ephemeral state. Preact diffs against the previous
  // render, so component state (a bubble's resolved Apply candidate, an open tool card) survives.
  function rerender(): void {
    render(
      createElement(AssistantChat, {
        store,
        onApplyModel: opts.onApplyModel,
        onOpenPrefs: opts.onOpenPrefs,
        getApplyCandidate,
        notice,
        stoppedPartial,
        mechanism: mechanismView,
        settledToolCalls: toolCardsView,
        onApplyChangeSet: applyChangeSet,
        onDiscardChangeSet: () => store.getState().discardChangeSet(),
        onSend: (draft) => void send(draft, undefined, { fromInput: true }),
        onStop: () => aborter?.abort(),
        onQuickAction: (id) => {
          if (busy()) return;
          // Await getContext once and reuse it for both the action prompt and the system prompt.
          void (async () => {
            const ctx = await opts.getContext();
            await send(QUICK_PROMPTS[id](ctx), ctx);
          })();
        },
        onExplain: () => {
          if (busy()) return;
          void runExplain();
        },
        // Forget this workspace's conversation: empty the slice history and drop the stored blob.
        // Refused while a request is in flight (the Composer also disables the button) so it can't
        // race the streaming reply (which would re-persist the half-finished turn after the clear).
        onClear: () => {
          if (busy()) return;
          store.getState().clearChatTranscript();
          clearChat(opts.getWorkspaceKey());
          clearTurnEphemera();
          rerender();
        },
      }),
      opts.container,
    );
  }

  // "Explain this construct": an EXPLANATORY turn for a non-coding domain expert — explains the
  // selection (or whole model) in plain language, with the Apply affordance suppressed (offerApply
  // false) since the reply is prose, not a model to apply. Reuses the resolved context for both prompts.
  async function runExplain(): Promise<void> {
    if (busy()) return;
    const sel = opts.getSelection();
    const ctx = await opts.getContext();
    await send(buildExplainPrompt(sel?.text ?? null, ctx.source), ctx, { offerApply: false });
  }

  // Whether a workspace sync arrived while a request was streaming; send()'s finally replays it.
  let pendingSync = false;

  // Re-point the panel at the current workspace's conversation when the folder changed. Deferred
  // while a request is in flight: a mid-stream hydrate would swap the slice transcript out from under
  // the in-flight turn, cross-wiring one workspace's transcript into another's storage key. The
  // slice's hydrateChat is itself a no-op while streaming (belt-and-braces); the pendingSync flag is
  // the SCHEDULING half — send()'s finally replays the deferred sync once the turn settles.
  function syncWorkspace(): void {
    if (busy()) {
      pendingSync = true;
      return;
    }
    pendingSync = false;
    const key = opts.getWorkspaceKey();
    if (key === chat().workspaceKey) return;
    store.getState().hydrateChat(key, loadChat(key));
    // The replaced transcript takes its trailing ephemera with it (the imperative rebuild did too).
    clearTurnEphemera();
    rerender();
  }

  // Drift check (#473): has `file`'s LIVE text moved away from the send-time `before` it was staged
  // against? A drifted file must be skipped so a stale full-file body can't clobber newer work.
  // `fresh` is ONE live workspace read taken at apply time, uri-keyed like the send-time snapshot
  // (#472 Task 4): an existing file resolves by the row's OWN key — never a same-relPath twin under
  // another root. `freshPaths` is `fresh.displayPath`'s value set, built ONCE per apply (null iff
  // `fresh` is) so the new-file branch stays O(1) per row instead of rescanning the display map. The
  // slice normalizes an absent send-time text to '' (`before` is always a string).
  function isDrifted(
    file: ChangeSetFileState,
    fresh: WorkspaceFilesSnapshot | null,
    freshPaths: ReadonlySet<string> | null,
  ): boolean {
    if (file.isNew) {
      // A brand-new file's key is synthetic (`new:<relPath>`) and never appears in the live snapshot:
      // drift iff the path it would CREATE now exists — in a root's display map, or as a raw key in a
      // legacy relPath-keyed host — so a file created since SEND is never clobbered. Absent ⇒ still
      // new ⇒ no drift.
      if (!fresh) return false;
      return (freshPaths?.has(file.relPath) ?? false) || file.relPath in fresh.files;
    }
    const cur = fresh?.files[file.key];
    if (cur === undefined) {
      // The buffer isn't currently readable (closed/removed): safe only if there was nothing to
      // overwrite (base empty); otherwise we can't confirm the target is still the reviewed text → warn.
      return file.before !== '';
    }
    // An existing modification: drift iff the live text differs from the reviewed `before`.
    return cur !== file.before;
  }

  // Apply the change set under review (#984's state machine renders it; this owns the EFFECT): a
  // LIVE workspace read partitions the accepted files into drifted (warned + skipped, #473) and clean;
  // only the clean subset is written via the host, and the settle dispatches walk the slice —
  // beginChangeSetApply → resolveChangeSetApply / rejectChangeSetApply (#633) — with the stale-set
  // guards keeping a late settle from un-retiring a superseded set (#684). The host still COMPOSES the
  // wording (the clean count, the skip notices) but rides it into the live region entirely through the
  // slice's phase `note` (#1136) — the panel is a pure consumer of `chat.changeSet.phase`, no side
  // channel, no `forId` staleness match (the phase transitions themselves are already keyed to the
  // right set by the store's own guards).
  function applyChangeSet(_accepted: readonly ChangeSetFileState[]): void {
    // Belt-and-braces re-entrancy guard alongside the disabled button: only the CURRENT set, still
    // under review, can be applied — 'applying' (in flight) and the terminal phases bail here.
    const cs = store.getState().chat.changeSet;
    if (!cs || cs.phase.kind !== 'reviewing') return;
    const id = cs.id;
    // Derive the accepted list from the STORE the guard just read — never from the panel's render-time
    // argument (`_accepted` stays in the onApply signature but a stale render must not pick the files).
    const list = cs.files.filter((f) => f.accepted);
    if (!list.length) return;

    // Partition the accepted files against a LIVE read taken NOW (#473): a file the user edited while
    // the turn ran (drift) is warned + skipped; only the clean subset is written. The send-time `before`
    // still backs the REVIEWED diff — drift is judged against the current text at apply time. Detection
    // stays here in the host; the RESULT goes through the slice, whose state warns the rows (by key).
    // One pass over the rows, with the display-path set built once for the new-file drift branch.
    const fresh = opts.getWorkspaceFiles?.() ?? null;
    const freshPaths = fresh ? new Set(Object.values(fresh.displayPath)) : null;
    const drifted: ChangeSetFileState[] = [];
    const clean: ChangeSetFileState[] = [];
    for (const f of list) (isDrifted(f, fresh, freshPaths) ? drifted : clean).push(f);
    if (drifted.length) store.getState().markChangeSetDrift(drifted.map((f) => f.key));

    if (!clean.length) {
      // Everything selected drifted: write nothing (beginChangeSetApply is never dispatched — the
      // phase stays reviewing, so Apply stays usable for a fresh review), keep the panel open with
      // the warnings and announce why in the live region.
      store
        .getState()
        .noteChangeSetReview(
          `${drifted.length} ${files(drifted.length)} changed since ` +
            `${drifted.length === 1 ? 'it was' : 'they were'} proposed; nothing was applied. ` +
            `Send again for a fresh proposal.`,
        );
      return;
    }

    const skipped = drifted.length
      ? ` Skipped ${drifted.length} that changed since ${drifted.length === 1 ? 'it was' : 'they were'} proposed.`
      : '';
    // reviewing → applying; the phase guards the in-flight window and snapshots the clean count for the
    // truthful terminal label (#1136). Announce the skip synchronously (drift detection is synchronous)
    // so the warning is visible the instant Apply is clicked; the async result below refines it to the
    // final "Applied N" message.
    store
      .getState()
      .beginChangeSetApply(
        clean.length,
        drifted.length ? `Applying ${clean.length} clean ${files(clean.length)}.${skipped}` : undefined,
      );
    // Address each write by the row's OWN opaque key (#472 Task 4): the rows carry the staged edit's
    // key end-to-end through the review, so a revision applies to exactly the buffer it was staged
    // from — even when several roots share the relPath — and a brand-new file keeps the `new:<relPath>`
    // key it was staged under. The row's DISPLAY label rides in the relPath slot as the failure
    // report's name, so a partial apply names the exact twin (a bare colliding relPath could mean
    // either root); the write itself never reads it.
    const payload: StagedEdit[] = clean.map((f) => ({
      key: f.key,
      relPath: f.display,
      body: f.body,
      isNew: f.isNew,
    }));
    void Promise.resolve(opts.onApplyChangeSet?.(payload) ?? { failed: [] as string[] })
      .then((result) => {
        // A set superseded or replaced WHILE this apply was in flight is terminal (#684): a late settle
        // must not un-retire it — the slice would no-op the dispatch anyway, and bailing here keeps the
        // status live region from overwriting the "superseded" notice. Covers { failed } and success.
        const cur = store.getState().chat.changeSet;
        if (!cur || cur.id !== id || cur.phase.kind !== 'applying') return;
        if (result.failed.length) {
          // Partial/total failure: back to reviewing (no false "Applied ✓") with Apply re-opened by the
          // phase, and report exactly which files didn't write so the user can retry the checked set.
          const wrote = clean.length - result.failed.length;
          store.getState().resolveChangeSetApply({
            failed: result.failed,
            note:
              `${wrote ? `Applied ${wrote} ${files(wrote)}; ` : ''}` +
              `couldn't write ${result.failed.length}: ${result.failed.join(', ')}. Re-apply to retry.` +
              skipped,
          });
          return;
        }
        // Success: terminal applied — the phase locks the review (checkboxes disabled so a later
        // toggle can't trigger a second write), flips Apply to "Applied ✓", and drops Discard.
        store
          .getState()
          .resolveChangeSetApply({ failed: [], note: `Applied ${clean.length} ${files(clean.length)}.${skipped}` });
      })
      .catch((e) => {
        // A set superseded mid-apply stays terminal (#684): a late rejection must not re-enable Apply
        // or replace the "superseded" notice with an "Apply failed" one that invites a retry on a
        // retired change set.
        const cur = store.getState().chat.changeSet;
        if (!cur || cur.id !== id || cur.phase.kind !== 'applying') return;
        // onApply REJECTED (#633): applyFileEdit only turns disk-write errors into a { failed } result;
        // an un-guarded throw from a non-disk op (renderer/LSP sync, dirty refresh, saved-callback)
        // escapes as a rejection. rejectChangeSetApply releases the in-flight lock back to reviewing
        // (re-opening Apply for a retry of the still-checked set) and stores the error as the reviewing
        // phase's own note (#1136 — no duplicate side-channel note to keep in sync) so the failure is
        // announced and recoverable.
        store.getState().rejectChangeSetApply(`Apply failed: ${String(e)}${skipped}`);
      });
  }

  function setMechanism(patch: Partial<TurnMechanism>): void {
    mechanismView = { chip: null, repairCounter: '', invalidNotice: null, ...mechanismView, ...patch };
    rerender();
  }

  /**
   * Settle a finished, CONSTRAINED generative reply (issue #257) into the trailing bubble's view
   * state: the mechanism chip, the live "repair k/N" counter, and — through `resolveGate` — the
   * apply-gate candidate the bubble offers "Apply to editor" for.
   *
   *  • `off`    → exactly the legacy behavior: offer Apply unconditionally (no chip).
   *  • `gbnf`   → the output is meant to be valid by construction; we validate, and the "grammar-constrained"
   *               chip stays only while that holds. If the backend silently ignored the grammar so the
   *               candidate fails to parse, the path SELF-HEALS into the same bounded repair loop as
   *               `repair` (issue #446) — relabelling the chip to "parse-and-repair" — so it's never
   *               strictly worse than parse-and-repair.
   *  • `repair` → bounded parse-and-repair against the real Koine parser, a live "repair k/N" counter
   *               and a "parse-and-repair" chip; Apply is enabled only when a candidate finally parses,
   *               else a "couldn't produce valid Koine" notice is shown and Apply stays withheld.
   *
   * Never throws — a failed/aborted repair turn is folded into an `ok:false` outcome — so it can be
   * awaited inside `send`'s try without disturbing its abort/error handling.
   */
  async function resolveConstrainedOutcome(
    content: string,
    offerApply: boolean,
    mechanism: ConstraintMechanism,
    ctx: AssistantContext,
    resolveGate: (candidate: string | null) => void,
  ): Promise<void> {
    if (!offerApply) {
      resolveGate(null); // explanatory turn — no model to apply, no chip, no gate
      return;
    }
    // On the grammar-constrained path the GBNF root is a BARE `.koi` program — the grammar can't emit a
    // ```` ```koine ```` fence — so a genuinely constrained reply is the model itself with no fence.
    // Fall back to the whole body there; the other paths still require a fenced block (prose ⇒ nothing).
    const candidate = extractKoine(content) ?? (mechanism === 'gbnf' ? content.trim() || null : null);
    if (!candidate) {
      resolveGate(null); // prose reply — nothing to apply or gate
      return;
    }
    const validate = makeValidate();
    // Legacy / no-gate path: the toggle is off, or the host can't validate, so behave as before.
    if (mechanism === 'off' || !validate) {
      resolveGate(candidate);
      return;
    }

    setMechanism({ chip: mechanism === 'gbnf' ? 'grammar-constrained' : 'parse-and-repair' });

    // Both 'gbnf' and 'repair' self-heal (issue #446): validate once and, on failure, fall into the
    // SAME bounded repair loop — so the gbnf path is never strictly worse than parse-and-repair. A
    // grammar that was honored makes the first candidate valid (rounds:0 → no repair, chip unchanged); a
    // grammar the backend silently ignored (Ollama) fails that validate and degrades into the repair
    // loop. The round budget lives in `repairBudgetFor` so the policy is in one place. The counter is
    // ticked only when a repair round actually runs (so it stays empty on the gbnf happy path and a
    // first-try-valid repair); its polite live region announces each tick (WCAG 4.1.3).
    const maxRounds = repairBudgetFor(mechanism, MAX_REPAIR_ROUNDS);
    let round = 0;
    let result: { source: string; ok: boolean; rounds: number };
    try {
      result = await repairToValid(
        candidate,
        {
          validate,
          regenerate: async (previous, diagnostics) => {
            round++;
            setMechanism({ repairCounter: `repair ${round}/${maxRounds}` });
            const repaired = await runAssistant({
              provider: opts.getProvider(),
              baseUrl: opts.getBaseUrl(),
              apiKey: opts.getApiKey(),
              model: opts.getModel(),
              temperature: opts.getTemperature?.(),
              system: buildSystem(ctx),
              messages: [...chat().messages, { role: 'user', content: buildRepairPrompt(previous, diagnostics) }],
              signal: aborter?.signal,
              // Stream nothing into the transcript — we only want the corrected candidate, not a second body.
              onText: () => {},
            });
            return extractKoine(repaired) ?? repaired;
          },
        },
        maxRounds,
      );
    } catch {
      // A network error / user-abort during a repair turn: treat it as "could not validate".
      result = { source: candidate, ok: false, rounds: round };
    }

    // A gbnf turn that had to repair means the grammar wasn't actually honored — relabel the chip so it
    // stops claiming a constraint that didn't hold (the capability probe makes this case rare to begin with).
    if (mechanism === 'gbnf' && result.rounds > 0) setMechanism({ chip: 'parse-and-repair' });

    if (result.ok) {
      resolveGate(result.source);
    } else {
      // Both paths spend repair rounds now, so the message reflects the attempts that were made.
      setMechanism({
        invalidNotice: `Couldn't produce valid Koine after ${maxRounds} repair attempt${maxRounds === 1 ? '' : 's'} — Apply is disabled.`,
      });
      resolveGate(null);
    }
  }

  async function send(
    text: string,
    ctxOverride?: AssistantContext,
    sendOpts?: { offerApply?: boolean; fromInput?: boolean },
  ): Promise<void> {
    const offerApply = sendOpts?.offerApply ?? true;
    // Whether the prompt came from the composer (Send button / Ctrl+Enter). Quick actions and
    // Explain pass their own built prompt, so they must not clear — or, on rollback, overwrite —
    // a draft the user typed but hasn't sent.
    const fromInput = sendOpts?.fromInput ?? false;
    const prompt = text.trim();
    if (!prompt || busy()) return;

    const provider = opts.getProvider();
    const baseUrl = opts.getBaseUrl();
    const apiKey = opts.getApiKey();
    // Whether a *usable* key was configured for this turn: a whitespace-only stored value is truthy
    // but unusable, so trim before deciding. Captured once so both the pre-flight guard and the
    // catch-block auth-error copy agree on whether a key was actually present (#530).
    const hasKey = !!apiKey.trim();
    // A key is required for Anthropic and for any remote OpenAI-compatible endpoint; local servers
    // (Ollama / LM Studio on localhost) need no auth, so a blank key is fine there.
    const needsKey = provider === 'anthropic' || !isLocalProviderUrl(baseUrl);
    if (needsKey && !hasKey) {
      notice = { kind: 'note', text: 'Add your API key in Settings to use the assistant. ', openSettings: true };
      rerender();
      return;
    }

    // #473: a new turn supersedes any still-un-applied change set from a prior turn — its staged bodies
    // were computed against an older workspace snapshot, so retire it (disable Apply + accept checkboxes,
    // announce "superseded") rather than let a late click clobber everything done since. The slice
    // no-ops on a terminal set (an "Applied ✓" survives, #473) and on none at all.
    store.getState().invalidateChangeSet('superseded');

    // Re-point at the CURRENT workspace before this turn touches history: the folder can switch in
    // place while the AI rail stays visible (the host only calls syncWorkspace on tab re-show), and
    // this turn must never be pushed onto the previous folder's transcript.
    syncWorkspace();

    // The transcript moves on: the prior turn's trailing ephemera (a notice, a Stopped marker, the
    // mechanism chip) must not annotate this turn's bubbles.
    clearTurnEphemera();
    rerender();

    if (fromInput) store.getState().setChatDraft('');
    store.getState().appendChatMessage({ role: 'user', content: prompt });

    // Acquire the busy lock synchronously — BEFORE the first await — so a second rapid send (Enter
    // twice, or Enter then a quick action) can't slip past the busy() guard while getContext, now
    // async, is in flight: startChatTurn flips chat.status to 'streaming', which is what busy()
    // reads. Capture the workspace key now, so a folder switch mid-stream can't persist this turn
    // under the wrong workspace; the transcript needs no capture — hydrateChat is a no-op while
    // streaming, so the slice transcript can't be swapped out from under the in-flight turn.
    aborter = new AbortController();
    store.getState().startChatTurn();
    const workspaceKey = opts.getWorkspaceKey();
    // Commit a finished assistant turn to history + storage under the captured key, carrying the apply
    // opt-out so a replay of an explanatory turn stays apply-free. Clearing the ephemeral turn keeps
    // the committed bubble from double-rendering next to the stale streaming one while the busy window
    // stays open (the repair loop below still runs under it).
    const commitAssistantTurn = (content: string): void => {
      const turn: ChatMessage = { role: 'assistant', content };
      if (!offerApply) turn.offerApply = false;
      // The turn's tool cards outlive the ephemeral chat.turn: snapshot them before it is dropped, so
      // they stay above the committed reply (imperative contract) until the conversation moves on.
      const calls = chat().turn?.toolCalls ?? [];
      toolCardsView = calls.length ? calls : null;
      store.getState().appendChatMessage(turn);
      saveChat(workspaceKey, [...chat().messages]);
      store.getState().clearStreamingTurn();
      rerender();
    };
    let full = '';
    // Coalesce streamed deltas into ONE appendStreamingText per animation frame: a store set() per
    // token makes every subscriber (the Transcript's keyed re-render + autoscroll layout read, the
    // StoreInspector) pay per delta. The buffer is INVISIBLE to the store, so it is drained with a
    // synchronous flushNow() at every boundary that reads or clears the live turn's text — a tool
    // call starting, the commit/abort settles below — before that boundary dispatches.
    const streamText = makeTextCoalescer((text) => store.getState().appendStreamingText(text));
    try {
      // Fetch the grounding context ONCE (a quick-action caller passes the one it already resolved, so
      // getContext — which may hit the LSP to build the domain index — isn't run twice).
      const ctx = ctxOverride ?? (await opts.getContext());

      // Decide the constraint mechanism (issue #257). Only bother fetching the GBNF when the toggle is
      // on AND the backend is grammar-capable (a local OpenAI-compatible server) AND the host exposes a
      // grammar accessor (browser only) — otherwise the parse-and-repair fallback covers it. The fetch
      // is defensive: a throw / missing export degrades to repair rather than crashing the send.
      //
      // Gate the whole mechanism on `offerApply`: only GENERATIVE turns produce a `.koi` model to
      // constrain. An explanatory turn (Explain, `offerApply:false`) must stay plain prose — constraining
      // it to the grammar would force the model to answer with a `.koi` model instead of an explanation.
      const constrainOn = opts.getConstrainGrammar() && offerApply;
      let gbnf: string | null = null;
      if (constrainOn && opts.getGrammar && isGrammarCapable(provider, baseUrl)) {
        // Don't TRUST the URL that a loopback OpenAI endpoint honours a GBNF grammar (issue #446):
        // Ollama's OpenAI-compatible endpoint looks identical but ignores a top-level `grammar` (it
        // constrains via its own `format`), which would light a LYING "grammar-constrained" chip and skip
        // the repair loop. Probe the endpoint's ACTUAL behaviour (cached per endpoint) with a tiny
        // sentinel-only grammar, and only attach the real GBNF when the probe confirms the grammar took.
        // A not-capable / errored probe leaves `gbnf` null → `chooseMechanism` returns 'repair' → the
        // honest parse-and-repair path (and the gbnf self-heal is the belt-and-braces backstop).
        const honoursGrammar = await probeGrammarCapability(provider, baseUrl, (grammar) =>
          runAssistant({
            provider,
            baseUrl,
            apiKey,
            model: opts.getModel(),
            temperature: opts.getTemperature?.(),
            system: 'Probe.',
            messages: [{ role: 'user', content: 'ping' }],
            grammar,
            signal: aborter?.signal,
            // Stream nothing into the transcript and don't commit it — the probe is invisible plumbing.
            onText: () => {},
          }),
        );
        if (honoursGrammar) {
          try {
            gbnf = await opts.getGrammar();
          } catch {
            gbnf = null;
          }
        }
      }
      const mechanism = chooseMechanism(constrainOn, provider, baseUrl, !!gbnf);

      // #447: the compiler/edit tools and a GBNF grammar are mutually exclusive at the decoder — a
      // grammar that only accepts `.koi` can't also emit the tool-call JSON the agentic loop needs. So
      // when the grammar is EFFECTIVE for this turn (mechanism === 'gbnf'), grammar wins: we withhold
      // the tools entirely rather than advertise tools the GBNF would silently render uncallable. When
      // the grammar isn't effective ('off'/'repair' — non-capable backend, no GBNF, or an explanatory
      // turn) the tools run exactly as before. The settings UI also makes the two mutually exclusive
      // (prefs.ts), so this is the belt-and-braces guard for any stale/legacy both-on state.
      const toolsEffective = opts.getUseTools() && mechanism !== 'gbnf';

      // Build the per-turn multi-file staging session ONLY for a GENERATIVE workspace turn: offerApply
      // (an Explain turn must never stage/apply edits) AND tools are effective (so not a gbnf turn) AND
      // the host supplies the edit executor AND there are workspace files to edit across. The model's
      // writes land in `editSession`, keyed by the snapshot's opaque keys with the display map carrying
      // each key's relPath (#472); after the turn resolves, `editSession.staged()` holds the files.
      const snapshot =
        offerApply && toolsEffective && opts.runEditTool && opts.getWorkspaceFiles ? opts.getWorkspaceFiles() : null;
      const editSession =
        snapshot && Object.keys(snapshot.files).length > 0
          ? createEditSession(snapshot.files, snapshot.displayPath)
          : null;

      // The once-per-turn whole-staged-workspace validation (issue #474): the loop runs `validateStaged`
      // a single time at end of turn and hands the diagnostics back here via `onStagedValidation`, so
      // the change-set review can show a write that broke the model BEFORE the user applies it.
      let stagedDiagnostics: string | null = null;

      full = await runAssistant({
        provider,
        baseUrl,
        apiKey,
        model: opts.getModel(),
        temperature: opts.getTemperature?.(),
        // In workspace mode, steer the model toward the multi-file edit tools (otherwise the primer's
        // "output one ```koine block" instruction wins and the change-set path never fires).
        system: editSession ? `${buildSystem(ctx)}\n\n${WORKSPACE_EDIT_GUIDE}` : buildSystem(ctx),
        messages: [...chat().messages],
        signal: aborter.signal,
        // Attach the grammar only on the grammar-constrained path; a no-op for providers that ignore it.
        ...(mechanism === 'gbnf' && gbnf ? { grammar: gbnf } : {}),
        onText: (delta) => {
          full += delta;
          streamText.push(delta);
        },
        // Withhold the tools when the user hasn't opted into the agentic loop (plain streaming request —
        // no `tools` ⇒ local servers stream instead of buffering), AND whenever the grammar is effective
        // for this turn (#447): a GBNF that only accepts `.koi` can't emit the tool-call JSON, so
        // advertising tools alongside it would silently disable them. `toolsEffective` folds in both.
        runCompilerTool: toolsEffective ? opts.runCompilerTool : undefined,
        // Offer the multi-file edit surface alongside the compiler tools when this is a workspace turn.
        ...(editSession && opts.runEditTool ? { editSession, runEditTool: opts.runEditTool } : {}),
        // Validate the staged workspace ONCE at end of turn (issue #474): bind the host validator to
        // this turn's session, and capture the diagnostics for the change-set review below.
        ...(editSession && opts.validateStaged
          ? {
              validateStaged: () => opts.validateStaged!(editSession),
              onStagedValidation: (diagnostics: string) => {
                stagedDiagnostics = diagnostics;
              },
            }
          : {}),
        // Expandable tool-call cards render from the EPHEMERAL chat.turn (#984): open a live "pending"
        // card on START, then settle the SAME entry on END (ok/error state, summary, duration, result).
        onToolCallStart: (start) => {
          // Any text streamed this round was a "thinking" preamble before the tool call — the slice
          // clears the turn text (so the card and the eventual answer render in chronological order),
          // and the local accumulator must agree so the eventual commit is the post-tools answer only.
          // Drain the coalescer FIRST so startToolCall's clear disposes of ALL of the preamble — a
          // late frame flush would otherwise resurrect its tail after the card opened.
          streamText.flushNow();
          full = '';
          store.getState().startToolCall({ id: start.id, name: start.name, args: start.argsJson });
        },
        onToolCallEnd: (end) => {
          store.getState().completeToolCall({
            id: end.id,
            state: end.ok ? 'ok' : 'error',
            summary: end.summary,
            // On failure the executor sends an empty resultText + an `error` message — that's the body.
            result: end.ok ? end.resultText : (end.error ?? 'failed'),
            durationMs: end.durationMs,
          });
        },
      });
      // The stream is over: drain the buffered tail (and cancel the pending frame) BEFORE the commit
      // below clears the live turn — an uncancelled frame could otherwise fire into a LATER turn.
      streamText.flushNow();
      // Register the live apply-gate BEFORE the commit renders the bubble: the bubble's mount effect
      // asks `getApplyCandidate` for this content, and it must resolve with THIS turn's outcome (the
      // repaired candidate, or null for a staged/explanatory/invalid turn) rather than re-validating.
      let resolveGate!: (candidate: string | null) => void;
      liveGate = {
        content: full,
        promise: new Promise<string | null>((r) => {
          resolveGate = r;
        }),
      };
      commitAssistantTurn(full);
      if (editSession && editSession.staged().length > 0) {
        // The model staged a multi-file change: review it per file BEFORE any disk write. The
        // single-file Apply gate is for non-staged replies, so this turn's bubble offers nothing.
        resolveGate(null);
        // Stage the set in the chat slice (#984): the state machine owns accepted/drift/phase — a
        // later send supersedes it via invalidateChangeSet, and the declarative ChangeSetPanel is
        // its consumer. The slice's rows resolve their send-time text by the staged edit's KEY
        // (`before[f.key]`, #472 Task 4), so the key-keyed snapshot feeds the before map directly —
        // two roots staging the SAME relPath keep their own entries (a new file's minted key has no
        // snapshot entry, so its before stays the slice default '').
        const before: Record<string, string> = {};
        for (const edit of editSession.staged()) {
          const sendTime = snapshot?.files[edit.key];
          if (sendTime !== undefined) before[edit.key] = sendTime;
        }
        // Carry the TOOL-LAYER display labels onto the staged rows — the SAME per-session index the
        // edit tools addressed files by (buildDisplayIndex, #472) — so the review renders exactly the
        // paths the model listed/wrote. Row order is STAGE order, which for colliding twins can be the
        // OPPOSITE of the index's session order; a label re-derived from row order would swap them.
        const displayFor = buildDisplayIndex(editSession).displayFor;
        const display: Record<string, string> = {};
        for (const edit of editSession.staged()) {
          const label = displayFor.get(edit.key);
          if (label !== undefined) display[edit.key] = label;
        }
        store.getState().stageChangeSet(editSession.staged(), before, stagedDiagnostics, display);
        rerender();
      } else {
        // The apply-gate lives here: a constrained turn validates (and, on the repair path, re-prompts)
        // before "Apply to editor" is enabled, so unparseable text can never be applied (#257).
        await resolveConstrainedOutcome(full, offerApply, mechanism, ctx, resolveGate);
      }
    } catch (e) {
      // The stream ended mid-flight: drain the buffered tail (and cancel the pending frame) before
      // either settle path below commits or rolls back the live turn.
      streamText.flushNow();
      // Keep the stored history in lock-step with the transcript on both failure paths.
      const aborted = aborter?.signal.aborted ?? false;
      if (aborted && full.trim()) {
        // Stopped mid-stream with usable output: commit the (user, partial-assistant) pair so the
        // visible reply and the history agree, mark the bubble with the ephemeral "Stopped." note, and
        // still offer to apply a generated model — through the SAME legacy gate as a replay, so a
        // truncated/invalid partial must clear re-validation before Apply is offered (#444/#561).
        liveGate = null;
        commitAssistantTurn(full);
        stoppedPartial = true;
        rerender();
      } else {
        // Aborted with nothing, or a real error: roll the whole turn back from BOTH history and the
        // ephemeral turn (no dangling user turn or orphaned tool cards), and restore the prompt to retry.
        store.getState().abortChatTurn({ rollbackUserTurn: true });
        // Restore the prompt for a retry only when it came from the composer; a quick action's canned
        // prompt must not overwrite a draft the user typed but hasn't sent.
        if (fromInput) store.getState().setChatDraft(prompt);
        if (aborted) {
          notice = { kind: 'error', text: 'Stopped.' };
        } else {
          const raw = e instanceof Error ? e.message : String(e);
          // A rejected/invalid key (the pre-flight check only catches a BLANK key) surfaces a raw
          // "401 {json}" otherwise — turn it into actionable guidance. Other errors get their human
          // "message" extracted from any JSON body rather than dumping the whole blob.
          const isAuth = /\b401\b|authentication|invalid[\s_-]*(x-)?api[\s_-]*key|unauthor/i.test(raw);
          const jsonMsg = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
          if (isAuth) {
            // "Rejected" only makes sense if a key was actually sent; a 401 with no usable key (a
            // keyless local/remote endpoint that still demands auth) is a missing-key situation, not
            // a bad one — so word it as "not configured" to match the pre-flight guard (#530).
            notice = {
              kind: 'note',
              text: hasKey
                ? 'The provider rejected your API key. Check it in Settings → Assistant. '
                : 'No API key configured — add one in Settings → Assistant. ',
              openSettings: true,
            };
          } else {
            notice = { kind: 'error', text: 'Request failed: ' + (jsonMsg ?? raw) };
          }
        }
        rerender();
      }
    } finally {
      aborter = null;
      // Close the turn's busy window exactly where the old `aborter = null` unlock sat: a turn that
      // completed (or aborted with a usable partial) settles streaming → idle here; the rollback
      // path already left 'error' via abortChatTurn, which must not be clobbered back to idle.
      if (chat().status === 'streaming') store.getState().finishChatTurn();
      // Replay a workspace sync that arrived mid-stream, now that the transcript is quiescent.
      if (pendingSync) syncWorkspace();
      // Flush the settle synchronously BEFORE focusing: the Composer's `disabled={busy}` update via
      // its own store subscription is deferred (Preact batches the hook flush), so focus() would hit
      // a still-disabled textarea and no-op. render() is synchronous and the children re-read the
      // store during render, so the textarea is enabled by the time focus runs.
      rerender();
      focusComposer();
    }
  }

  opts.container.classList.add('koi-assistant');
  // Start from a clean host node (panelHost hands us a fresh mount, but a re-created panel must not
  // leave stale non-Preact content behind for render() to contend with).
  opts.container.replaceChildren();
  rerender();

  return {
    focusInput() {
      focusComposer();
    },
    syncWorkspace,
    explainSelection() {
      void runExplain();
    },
  };
}
