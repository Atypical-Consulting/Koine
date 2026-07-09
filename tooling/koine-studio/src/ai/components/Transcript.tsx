import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Fragment, type ComponentChildren } from 'preact';
import type { StoreApi } from 'zustand/vanilla';
import { useAppStore } from '@/store/hooks';
import type { AppState } from '@/store/index';
import type { ChatToolCall } from '@/ai/ai';
import { MdHtml } from '@/ai/components/MdHtml';

// The assistant transcript as a declarative Preact component (#990 Task 4). It replaces the
// imperative panel's transcript half (rebuildTranscript / replayMessage / addBubble /
// addToolCard / completeToolCard in aiPanel.ts, retired by Task 6) while reproducing its exact DOM
// contract: the `koi-assistant-transcript` scroller, the `koi-assistant-intro` empty state, the
// `koi-msg koi-msg-{user,assistant,note,error}` bubbles, the `koi-assistant-tool` `<details>` cards
// (`data-state` pending/ok/error, decorative glyph + sr-only state text, pretty-printed Arguments,
// the TOOL_RESULT_CLAMP-clamped Result), the gated "Apply to editor" affordance (#444), and the
// autoscroll on growth.
//
// It is a PURE consumer of the chat slice: the finished conversation renders from `chat.messages`
// (keyed, so a slice update PATCHES the existing bubbles instead of rebuilding the list) and the
// live turn renders from the EPHEMERAL `chat.turn` (#984) — the streamed text as a plain-text bubble
// and one card per tool call, keyed by call id so an END event settles the very element its START
// opened. Everything async stays with the host: the apply-gate resolves through
// `getApplyCandidate`, and the note/error bubbles the imperative panel painted as loose DOM arrive
// as the ephemeral `notice`/`stoppedPartial` props (never persisted — persistence only ever saves
// `chat.messages`).

/**
 * An ephemeral bubble the host paints OUTSIDE the persisted transcript: the missing/rejected-API-key
 * note (with its "Open Settings" affordance) or a request-failure/stop error. Mirrors the imperative
 * panel's `koi-msg-note` / `koi-msg-error` treatments.
 */
export interface TranscriptNotice {
  readonly kind: 'note' | 'error';
  readonly text: string;
  /** Append the "Open Settings" link-button (routes to {@link TranscriptProps.onOpenPrefs}). */
  readonly openSettings?: boolean;
}

/**
 * The host's grammar-constraint view state for the TRAILING assistant turn (#257/#446): the mechanism
 * chip ("grammar-constrained" / "parse-and-repair"), the live "repair k/N" counter the repair loop
 * ticks, and the terminal "couldn't produce valid Koine" notice when every round failed. EPHEMERAL —
 * host-rendered per live turn, never persisted, so a replayed turn renders none of it (exactly like
 * the imperative panel, which attached these as loose DOM on the live bubble only).
 */
export interface TurnMechanism {
  readonly chip: string | null;
  readonly repairCounter: string;
  readonly invalidNotice: string | null;
}

export interface TranscriptProps {
  /** The app store carrying the chat slice (#984); tests and stories inject their own createAppStore(). */
  store: StoreApi<AppState>;
  /** "Apply to editor" clicked: the host replaces the active editor document with the candidate. */
  onApplyModel: (source: string) => void;
  /** "Open Settings" clicked in a notice (missing/rejected API key): the host opens Preferences. */
  onOpenPrefs: () => void;
  /**
   * The host's apply-gate (#444): given a finished assistant turn's markdown, resolve the validated
   * `.koi` source to offer "Apply to editor" for — which on the repair path is NOT the text in the
   * markdown — or null to offer nothing. Owns candidate extraction and the validation policy (the
   * constrain-grammar toggle, fail-closed on an unavailable validator). Absent ⇒ Apply is never
   * offered. A rejection is treated as null (fail closed).
   */
  getApplyCandidate?: (markdown: string) => Promise<string | null>;
  /** The ephemeral trailing note/error bubble, or null/absent for none. */
  notice?: TranscriptNotice | null;
  /**
   * True when the trailing assistant turn is a partial committed by Stop-mid-stream: its bubble
   * carries the ephemeral "Stopped." marker (`koi-assistant-stopped`), exactly like the imperative
   * panel — and like there, the marker is NOT persisted, so a replay renders the partial plain.
   */
  stoppedPartial?: boolean;
  /**
   * The grammar-constraint treatment for the TRAILING assistant turn (chip / repair counter /
   * invalid notice), or null/absent for none. Like {@link stoppedPartial}, it scopes to the last
   * bubble only and is never persisted.
   */
  mechanism?: TurnMechanism | null;
  /**
   * Extra content rendered at the END of the transcript scroller — the host mounts the change-set
   * review here (#990 Task 6) so a long per-file diff scrolls with the conversation, as the
   * imperative panel's in-bubble change set did.
   */
  children?: ComponentChildren;
}

/**
 * The maximum number of characters of a tool's raw result rendered inside an expandable tool-call
 * card, with a visible `(truncated)` note past it — so one noisy `koine_compile` blob can't blow up
 * the transcript. Moved here from the imperative panel when #990 Task 6 retired its island.
 */
export const TOOL_RESULT_CLAMP: number = 8 * 1024;

/** Format a tool's execution time for its card: `312 ms` under a second, `1.4 s` at/above 1000 ms. */
function formatToolDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/**
 * Pretty-print a tool's raw `argsJson` with a 2-space indent for the card's Arguments block; fall back
 * to the raw string when it doesn't parse (a malformed / non-JSON args blob is still shown verbatim
 * rather than dropped).
 */
function prettyToolArgs(argsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argsJson), null, 2);
  } catch {
    return argsJson;
  }
}

/**
 * One finished assistant turn: the markdown body through {@link MdHtml} (the single escaping
 * boundary), the ephemeral "Stopped." marker on a stop-committed partial, and the host-gated "Apply
 * to editor" affordance — the button renders only once `getApplyCandidate` resolves a candidate, and
 * a click applies THAT candidate, then locks into the terminal "Applied ✓".
 */
function AssistantBubble({
  content,
  offerApply,
  stopped,
  mechanism,
  getApplyCandidate,
  onApplyModel,
}: {
  content: string;
  offerApply: boolean;
  stopped: boolean;
  mechanism?: TurnMechanism | null;
  getApplyCandidate?: (markdown: string) => Promise<string | null>;
  onApplyModel: (source: string) => void;
}) {
  const [candidate, setCandidate] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    // This bubble's content changed identity (a hydrateChat replacing the transcript reuses bubbles
    // positionally): any previously resolved candidate — and a terminal Applied lock — belongs to
    // the OLD content. Drop both synchronously, BEFORE the early return below, so a stale Apply
    // affordance can never carry over onto a message whose own gate hasn't (or won't ever) run.
    setCandidate(null);
    setApplied(false);
    // An explanatory turn (offerApply: false) never consults the gate — its reply is prose that must
    // not be applied, and the suppression is persisted on the message so replays stay apply-free.
    if (!offerApply || !getApplyCandidate) return;
    let stale = false;
    getApplyCandidate(content).then(
      (c) => {
        if (!stale) setCandidate(c);
      },
      // Fail closed (#444): if the gate throws we can't prove the model parses, so offer nothing.
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [content, offerApply, getApplyCandidate]);

  return (
    <div class="koi-msg koi-msg-assistant">
      <MdHtml md={content} />
      {stopped && <div class="koi-assistant-stopped">Stopped.</div>}
      {/* The grammar-constraint treatment (#257/#446), in the imperative panel's order: the mechanism
          chip (a status indicator, not decoration — WCAG 2.1 AA 4.1.3), then the live "repair k/N"
          counter (present-but-empty until a repair round actually runs, so the polite live region
          announces each tick), then — mutually exclusive with Apply — the failure notice. */}
      {mechanism?.chip && (
        <span class="koi-assistant-chip" role="status">
          {mechanism.chip}
        </span>
      )}
      {mechanism && (
        <div class="koi-assistant-repair-counter" role="status" aria-live="polite">
          {mechanism.repairCounter}
        </div>
      )}
      {candidate != null && (
        <button
          type="button"
          class="koi-assistant-apply"
          disabled={applied}
          onClick={() => {
            onApplyModel(candidate);
            setApplied(true);
          }}
        >
          {applied ? 'Applied ✓' : 'Apply to editor'}
        </button>
      )}
      {mechanism?.invalidNotice && (
        // The failure + withheld-Apply state is conveyed only by this text, so announce it (WCAG 4.1.3).
        <div class="koi-assistant-invalid" role="alert">
          {mechanism.invalidNotice}
        </div>
      )}
    </div>
  );
}

/**
 * One `koi-assistant-tool` card: a native `<details>` whose summary row carries the decorative status
 * glyph (aria-hidden), the visually-hidden state text ("running"/"succeeded"/"failed" — the meaning
 * never rides colour alone, WCAG 2.1 AA 1.4.1), the tool name, the summary chip, and the formatted
 * duration; the expandable `<dl>` body (pretty-printed Arguments, the clamped Result) lands once the
 * call settles. Keyed by call id in the parent, so the END state PATCHES the START's element.
 *
 * Controlled (#1133): `open`/`onToggle` are backed by {@link Transcript}'s hoisted expansion state
 * rather than the element's own DOM state, so an expanded card survives the remount a turn commit
 * (or a workspace swap) causes when the card moves between parents.
 */
function ToolCard({ call, open, onToggle }: { call: ChatToolCall; open: boolean; onToggle: (open: boolean) => void }) {
  const pending = call.state === 'pending';
  const raw = call.result ?? '';
  const truncated = raw.length > TOOL_RESULT_CLAMP;
  // Memoized on the raw argsJson (immutable once the call starts): the transcript re-renders per
  // streamed batch/ephemeral prop, and every settled card would otherwise re-parse + re-stringify.
  const args = useMemo(() => prettyToolArgs(call.args), [call.args]);
  return (
    <details
      class="koi-assistant-tool"
      data-state={call.state}
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span class="koi-tool-glyph" aria-hidden="true">
          {pending ? '…' : call.state === 'ok' ? '✓' : '✕'}
        </span>
        <span class="koi-sr-only koi-tool-state">
          {pending ? 'running' : call.state === 'ok' ? 'succeeded' : 'failed'}
        </span>
        <span class="koi-tool-name">{call.name}</span>
        <span class="koi-tool-summary">{call.summary ?? '…'}</span>
        <span class="koi-tool-duration">{call.durationMs != null ? formatToolDuration(call.durationMs) : ''}</span>
      </summary>
      {!pending && (
        <dl class="koi-tool-detail">
          <dt>Arguments</dt>
          <dd>
            <pre>{args}</pre>
          </dd>
          <dt>Result</dt>
          <dd>
            <pre>{truncated ? raw.slice(0, TOOL_RESULT_CLAMP) : raw}</pre>
            {truncated && <span class="koi-tool-truncated">(truncated)</span>}
          </dd>
        </dl>
      )}
    </details>
  );
}

export function Transcript({
  store,
  onApplyModel,
  onOpenPrefs,
  getApplyCandidate,
  notice,
  stoppedPartial,
  mechanism,
  children,
}: TranscriptProps) {
  const messages = useAppStore(store, (s) => s.chat.messages);
  const status = useAppStore(store, (s) => s.chat.status);
  const turn = useAppStore(store, (s) => s.chat.turn);
  // The workspace key scopes the positional bubble keys below: a workspace swap (hydrateChat to a
  // different key) must REMOUNT every bubble rather than positionally reuse one conversation's
  // per-bubble state (a resolved Apply candidate, an open tool card) for another's.
  const workspaceKey = useAppStore(store, (s) => s.chat.workspaceKey);
  const scroller = useRef<HTMLDivElement>(null);
  // Tool-card expansion, hoisted OUT of the <details> element's own DOM state (#1133): a card moves
  // between parents at turn commit (live → settled) and at a workspace swap, and a native <details>'s
  // `open` is lost on any remount. Identities are `workspaceKey`-prefixed, so a swap simply never
  // matches a prior entry — stale entries are unreachable and harmless.
  const [expandedCards, setExpandedCards] = useState<Set<string>>(() => new Set());
  const toggleCard = (id: string, open: boolean) => {
    setExpandedCards((prev) => {
      if (prev.has(id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const toolCard = (id: string, c: ChatToolCall) => (
    <ToolCard key={id} call={c} open={expandedCards.has(id)} onToggle={(open) => toggleCard(id, open)} />
  );
  // "Clear conversation" empties `messages` WITHOUT changing `workspaceKey` (unlike a workspace swap),
  // so identities restart from the same `m0`/`m1` indices and per-turn tool-call ids restart from 1 —
  // a stale entry would otherwise mark a brand-new, never-touched card in the NEXT conversation as
  // pre-expanded. `Transcript` never unmounts across a Clear (same render target), so this state would
  // otherwise persist right through it.
  const messagesEmpty = messages.length === 0;
  useEffect(() => {
    if (messagesEmpty) setExpandedCards((prev) => (prev.size === 0 ? prev : new Set()));
  }, [messagesEmpty]);

  // The live turn renders only while streaming — finish/abort clear `chat.turn`, but gating on the
  // status too keeps a stray ephemeral turn from ghosting a bubble after the lifecycle settles.
  const streaming = status === 'streaming' && turn != null;

  // Autoscroll on growth: every transcript mutation the imperative panel scrolled on (a new bubble, a
  // streamed delta, a tool card opening/settling, a notice) lands through these dependencies.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, turn, notice]);

  const last = messages.length - 1;
  return (
    <div class="koi-assistant-transcript" ref={scroller}>
      {/* Empty-state hint shown until the first bubble of any kind (message, live turn, or notice). */}
      {messages.length === 0 && !streaming && !notice && (
        <div class="koi-assistant-intro">
          <p>
            <strong>Domain copilot.</strong> Describe a domain to model, or ask about the current one. Use the
            quick actions below, or type a prompt.
          </p>
        </div>
      )}
      {messages.map((m, i) => (
        <Fragment key={`${workspaceKey}:m${i}`}>
          {/* Each assistant message's settled tool cards sit ABOVE its own reply bubble, exactly
              where they streamed (the imperative insertBefore contract survives the turn's
              completion) — every such message, not just the trailing one (#1133). */}
          {m.role === 'assistant' && m.toolCalls?.map((c) => toolCard(`${workspaceKey}:m${i}:t${c.id}`, c))}
          {m.role === 'assistant' ? (
            <AssistantBubble
              content={m.content}
              offerApply={m.offerApply !== false}
              stopped={!!stoppedPartial && i === last}
              mechanism={i === last ? mechanism : null}
              getApplyCandidate={getApplyCandidate}
              onApplyModel={onApplyModel}
            />
          ) : (
            // User text verbatim — never through the markdown renderer.
            <div class="koi-msg koi-msg-user">{m.content}</div>
          )}
        </Fragment>
      ))}
      {streaming && (
        <>
          {/* Tool cards sit ABOVE the streaming bubble (the imperative insertBefore contract). Live
              cards use `messages.length` as their index (#1133) — the index the pending assistant
              message will occupy once committed, since the user turn is already appended by then —
              so a card's identity never changes across the live→settled transition. */}
          {turn.toolCalls.map((c) => toolCard(`${workspaceKey}:m${messages.length}:t${c.id}`, c))}
          {/* The live reply streams as PLAIN TEXT ('…' until the first delta); markdown renders only
              once the turn commits to `messages`. */}
          <div key="stream" class="koi-msg koi-msg-assistant">
            {turn.text || '…'}
          </div>
        </>
      )}
      {notice && (
        <div class={`koi-msg koi-msg-assistant koi-msg-${notice.kind}`}>
          {notice.text}
          {notice.openSettings && (
            <button type="button" class="koi-link-btn" onClick={() => onOpenPrefs()}>
              Open Settings
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
