// The routed Home view for Koine Studio as a Preact component (#991 task 3). Mounted by `mountHome`
// (welcome.ts) into a router-provided container — not a `document.body` overlay. Offers the first
// actions: start a new model, open a folder, clone a repo, or reopen a recent one; a live hero snippet
// shows the product's thesis. This is the migration of the old imperative `welcome.ts` builder: the
// recents filter and gallery search are now CONTROLLED inputs (deleting the old attach/detach +
// caret-preservation hacks that existed only because `renderRecent()` wiped `innerHTML`), the gallery
// tablist is a state-driven roving tabindex, and the gallery layer's `registerOverlay` Esc-stack
// contract is an effect keyed on `galleryOpen` (register on open, unregister on cleanup — which also
// covers `destroy()` mid-open).
//
// STORE-FREE (critical): Home renders pre-IDE-boot (before `init()` wires the IDE), so it reads only
// props + callbacks + `settings/persistence` (`getRecentFolders` & co.). It never subscribes to any
// IDE-wired store slice (workspace / diagnostics / docViews), which is only populated once the editor
// boots.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import {
  getRecentFolders,
  removeRecentFolder,
  pinRecentFolder,
  clearRecentFolders,
  getLastSession,
  type RecentFolder,
  type LastSession,
} from '@/settings/persistence';
import { getPlatform, type Platform } from '@/host';
import { registerOverlay, koiConfirm } from '@atypical/koine-ui';
import { PROJECT_LINKS, CREATOR_URL, CREATOR_NAME, CREDIT_PREFIX, wireExternalLink } from '@/shared/colophon';
import { type Template } from '@/welcome/templates';
import { wrapIndex } from '@/shared/wrapIndex';
import { basename } from '@/shared/path';
import { koineMark } from '@/shared/logo';
import { toggleTheme, currentTheme } from '@/settings/theme';
import { MOD } from '@/shared/platform';

/** What the welcome actions delegate to; the host (main.ts) performs the real work. */
export interface WelcomeCallbacks {
  onNewModel(): void;
  onOpenFolder(): void;
  onOpenRecent(path: string): void;
  /** Open one of the starter templates as a workspace. */
  onOpenExample(template: Template): void;
  /** Return to the user's editor session — fired by the resume-session card (#1005 / #392 / #766). */
  onResume?(): void;
  /** Open the Settings surface — fired by the top bar's gear button. */
  onOpenSettings?(): void;
  /** Clone the git repository at `url` — fired by the inline clone form (#1005). A rejection is surfaced
   *  inline; a resolve means the caller has taken over navigation. */
  onClone?(url: string): Promise<void>;
  /** "Open anyway" for a cloned-but-empty folder (#1017). */
  onOpenEmptyAnyway?(path: string): void;
}

/** The active gallery filters. Any field left undefined/empty is treated as "no constraint". */
export interface TemplateFilter {
  /** Free-text query matched (case-insensitive) against name, tagline and tags. */
  query?: string;
  /** A single tag the template must carry. */
  tag?: string;
  /** A single difficulty the template must be. */
  difficulty?: Template['difficulty'];
}

/** Canonical difficulty ordering — starters first, advanced last. Drives grouping and chip order. */
export const DIFFICULTY_ORDER: Template['difficulty'][] = ['starter', 'beginner', 'intermediate', 'advanced'];

/**
 * Pure, side-effect-free filter over a template list — the testable core of the gallery. Preserves
 * input order. A template passes when it satisfies *all* of the supplied constraints (logical AND):
 * the query substring-matches its name/tagline/any tag, and the tag/difficulty (if given) match.
 */
export function filterTemplates(templates: readonly Template[], filter: TemplateFilter): Template[] {
  const q = (filter.query ?? '').trim().toLowerCase();
  return templates.filter((t) => {
    if (filter.difficulty && t.difficulty !== filter.difficulty) return false;
    if (filter.tag && !t.tags.includes(filter.tag)) return false;
    if (q) {
      const haystack = [t.name, t.tagline, ...t.tags].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/**
 * The seams the boot layer drives when an open-recent start-intent fails, registered back through the
 * `mountHome` handle via a component ref (see {@link HomeProps.controls}).
 */
export interface HomeControls {
  /** Rebuild the recent-folders list from storage, in place. */
  refreshRecent(): void;
  /** Confirm "Remove from Recent?" and, on accept, forget the dead entry + refresh the list (#391). */
  recover(path: string): Promise<void>;
  /** Tell the user a clone succeeded but has no `.koi` files yet, offering "Open anyway" (#1017). */
  notifyClonedEmpty(path: string): Promise<void>;
}

export interface HomeProps {
  cb: WelcomeCallbacks;
  templates: readonly Template[];
  canOpenFolders: boolean;
  /** The editor is live *this session* (#392) — drives the resume card's live "ping" dot. */
  warm?: boolean;
  /** Whether this host can clone a git repository (#1005) — gates the "Clone repository" Start row. */
  canClone?: boolean;
  /** There is a session to return to even without a rich snapshot (#766) — shows the Resume control. */
  canResume?: boolean;
  /** A mutable ref the component populates with its imperative {@link HomeControls}. */
  controls: { current: HomeControls | null };
}

/**
 * A repository URL the Home clone form accepts: an http(s), scp-style `git@host:…`, or `ssh://` URL,
 * each followed by at least one non-space character. Deliberately permissive — the real validation is
 * the clone attempt itself; this only gates the button so an obviously-empty/garbage value can't submit.
 */
const CLONE_URL_RE = /^(https?:\/\/|git@|ssh:\/\/)\S+/;

/** The recent list shows this many rows collapsed; a "View all" toggle then reveals the rest. */
const RECENT_COLLAPSE_LIMIT = 6;

// The hero artifact: the canonical Money value object, lifted verbatim from the billing starter. Fully
// static (no user input), so rendering it via dangerouslySetInnerHTML is safe here and preserves the
// exact <pre> whitespace and token spans — see the justified disable at its render site.
const HERO_SNIPPET = `<span class="koi-syn-kw">value</span> <span class="koi-syn-type">Money</span> <span class="koi-syn-punct">{</span>
  <span class="koi-syn-id">amount</span><span class="koi-syn-punct">:</span>   <span class="koi-syn-type">Decimal</span>
  <span class="koi-syn-id">currency</span><span class="koi-syn-punct">:</span> <span class="koi-syn-type">Currency</span>
  <span class="koi-syn-kw">invariant</span> <span class="koi-syn-id">amount</span> <span class="koi-syn-punct">&gt;=</span> <span class="koi-syn-num">0</span>
<span class="koi-syn-punct">}</span>`;

// Static, trusted inline-SVG icon constants (drawn in the toolbar's stroked 16×16 line-icon idiom).
const ICON_NEW = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.4v9.2M3.4 8h9.2"/></svg>';
const ICON_OPEN =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 4.3c0-.7.5-1.3 1.2-1.3h2.9l1.3 1.6h4.9c.7 0 1.3.6 1.3 1.3v6c0 .7-.6 1.2-1.3 1.2H3.4c-.7 0-1.2-.5-1.2-1.2z"/></svg>';
const ICON_GALLERY =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.4" y="2.4" width="4.4" height="4.4" rx="1"/><rect x="9.2" y="2.4" width="4.4" height="4.4" rx="1"/><rect x="2.4" y="9.2" width="4.4" height="4.4" rx="1"/><rect x="9.2" y="9.2" width="4.4" height="4.4" rx="1"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5 5 8l4.5 4.5"/></svg>';
const ICON_ARROW = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
const ICON_THEME =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 9.3A5.4 5.4 0 0 1 6.7 2.8 5.4 5.4 0 1 0 13.2 9.3z"/></svg>';
const ICON_SUN =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.1"/><path d="M8 1.3v1.7M8 13v1.7M1.3 8h1.7M13 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2"/></svg>';
const ICON_SEARCH =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.6 13.6"/></svg>';
const ICON_SETTINGS =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.39 6.82L14.44 7.10L14.44 8.90L12.39 9.18L11.94 10.27L13.19 11.91L11.91 13.19L10.28 11.94L9.18 12.39L8.90 14.44L7.10 14.44L6.82 12.39L5.73 11.94L4.09 13.19L2.81 11.91L4.06 10.27L3.61 9.18L1.56 8.90L1.56 7.10L3.61 6.82L4.06 5.72L2.81 4.09L4.09 2.81L5.72 4.06L6.82 3.61L7.10 1.56L8.90 1.56L9.18 3.61L10.28 4.06L11.91 2.81L13.19 4.09L11.94 5.72Z"/><circle cx="8" cy="8" r="2.1"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.4v9.2L12.5 8z" fill="currentColor" stroke="none"/></svg>';
const ICON_BRANCH =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="4" r="1.4"/><circle cx="4.5" cy="12" r="1.4"/><circle cx="11.5" cy="5.5" r="1.4"/><path d="M4.5 5.4v5.2M4.5 8.4c0-1.8 1-2.9 3.4-2.9h1"/></svg>';

// The Start-action keycaps (#1005): the platform-aware primary modifier (MOD — ⌘ on mac, Ctrl
// elsewhere) plus the action's letter, with a leading ⇧ for the shift combos. Each shortcut is an
// ARRAY of keys, mirrored by the document-level keydown handler so the on-screen hint and the shortcut
// that fires it can never drift apart.
const KEY_SHIFT = '⇧';
const KEYS_NEW = [MOD, 'N'];
const KEYS_EXAMPLE = [MOD, 'E'];
const KEYS_CLONE = [KEY_SHIFT, MOD, 'C'];
const KEYS_OPEN = [KEY_SHIFT, MOD, 'O'];

/** Emit-target id → SHORT code for a recent row's language tag (e.g. `csharp` → `C#`). */
function shortLang(id: string): string {
  const codes: Record<string, string> = {
    csharp: 'C#',
    typescript: 'TS',
    python: 'PY',
    php: 'PHP',
    rust: 'RS',
    asyncapi: 'ASYNC',
    openapi: 'OPENAPI',
  };
  return codes[id] ?? id.toUpperCase();
}

/**
 * A compact, human relative-time label: "just now" under a minute, then "N min ago", "Nh ago", "Nd ago".
 * Pure over an explicit `now` so it's deterministic. A future/clock-skewed `then` clamps to "just now".
 */
function timeAgo(then: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** Whether the user asks for less motion — so the resume card's live ping never animates for them. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Whether focus is in a text-entry control, so a stray modifier never hijacks typing. */
function isTextEntryFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * A static, trusted inline-SVG icon constant rendered into an `aria-hidden` span. The one sanctioned
 * `dangerouslySetInnerHTML` site in this file (mirrors About.tsx's link-icon/brand-mark pattern): every
 * `markup` value is a module-scope constant (`ICON_*`) or `koineMark()`, never user/model-derived text.
 */
function Icon(props: { markup: string; class?: string }): JSX.Element {
  return (
    <span
      class={props.class}
      aria-hidden="true"
      // eslint-disable-next-line no-restricted-syntax -- static, trusted inline-SVG constant (module-scope ICON_*/koineMark), never user input; mirrors About.tsx's link-icon pattern
      dangerouslySetInnerHTML={{ __html: props.markup }}
    />
  );
}

/** A quiet, decorative keycap group (`.koi-welcome-keys`): one small boxed `<kbd>` per key. The whole
 *  group is aria-hidden — the action's visible label already carries the accessible name (WCAG 2.5.3). */
function Keycap(props: { keys: readonly string[] }): JSX.Element {
  return (
    <span class="koi-welcome-keys" aria-hidden="true">
      {props.keys.map((k, i) => (
        <kbd key={i} class="koi-welcome-key">
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** A start action: an icon, a label, a one-line description and an optional keycap group. */
function ActionButton(props: {
  icon: string;
  label: string;
  desc: string;
  primary?: boolean;
  disabled?: boolean;
  /** Stable semantic hook (sets `data-action`) for tests and Home's navigation wiring. */
  action?: string;
  keys?: readonly string[];
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      class={props.primary ? 'koi-welcome-action primary' : 'koi-welcome-action'}
      disabled={props.disabled}
      data-action={props.action}
      onClick={props.onClick}
    >
      <Icon markup={props.icon} class="koi-welcome-action-icon" />
      <span class="koi-welcome-action-text">
        <span class="koi-welcome-action-label">{props.label}</span>
        <span class="koi-welcome-action-desc">{props.desc}</span>
      </span>
      {props.keys && <Keycap keys={props.keys} />}
    </button>
  );
}

/** An external `<a target="_blank" rel="noopener noreferrer">` wired through `wireExternalLink` /
 *  `platform.openExternal` (so it opens in the system browser, not the webview) — the same helper the
 *  About panel uses. */
function ExternalLink(props: {
  class: string;
  href: string;
  title?: string;
  platform: Platform;
  children: ComponentChildren;
}): JSX.Element {
  const ref = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    if (ref.current) wireExternalLink(ref.current, props.href, props.platform);
  }, [props.href, props.platform]);
  return (
    <a ref={ref} class={props.class} href={props.href} title={props.title} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  );
}

/** The rich resume-session card (#1005): the "continue where you left off" affordance. */
function ResumeCard(props: { session: LastSession | null; warm: boolean; onResume?: () => void }): JSX.Element {
  const { session, warm } = props;
  return (
    <button
      type="button"
      class="koi-home-resume"
      data-action="resume"
      title="Return to your editor session"
      onClick={() => props.onResume?.()}
    >
      <span class="koi-home-resume-tile" aria-hidden="true">
        <Icon markup={ICON_PLAY} />
        {warm && <span class={`koi-home-resume-ping${prefersReducedMotion() ? '' : ' is-live'}`} />}
      </span>
      <span class="koi-home-resume-body">
        <span class="koi-home-resume-eyebrow">Last session</span>
        <span class="koi-home-resume-meta">
          <span class="koi-home-resume-project">{session ? session.project : 'Resume editing'}</span>
          {session?.file && (
            <>
              <span class="koi-home-resume-sep" aria-hidden="true">
                ·
              </span>
              <span class="koi-home-resume-file">{basename(session.file)}</span>
            </>
          )}
        </span>
        {session && (
          <span class="koi-home-resume-detail">
            <span class="koi-home-resume-time">{timeAgo(session.editedAt, Date.now())}</span>
            {session.unsavedCount && session.unsavedCount > 0 ? (
              <span class="koi-home-resume-unsaved">{session.unsavedCount} unsaved</span>
            ) : null}
          </span>
        )}
      </span>
      <Icon markup={ICON_ARROW} class="koi-home-resume-chevron" />
    </button>
  );
}

/** One dense recent row as a SINGLE line: monogram tile + name (+ optional language tag), a right-pushed
 *  optional branch + relative time, plus the hover/focus-revealed pin, copy and remove controls. */
function RecentRow(props: {
  entry: RecentFolder;
  hidden: boolean;
  onOpen: () => void;
  onPin: () => void;
  onCopy: () => void;
  onRemove: () => void;
}): JSX.Element {
  const { entry } = props;
  const name = basename(entry.path);
  return (
    <div class={entry.pinned ? 'koi-welcome-recent-item is-pinned' : 'koi-welcome-recent-item'} hidden={props.hidden}>
      <button type="button" class="koi-welcome-recent-open" title={entry.path} onClick={props.onOpen}>
        <span class="koi-welcome-recent-mono" aria-hidden="true">
          {(name.charAt(0) || '?').toLowerCase()}
        </span>
        <span class="koi-welcome-recent-item-name">{name}</span>
        {entry.language && <span class="koi-welcome-recent-lang">{shortLang(entry.language)}</span>}
        <span class="koi-welcome-recent-side">
          {entry.branch && (
            <span class="koi-welcome-recent-branch" title={`Branch: ${entry.branch}`}>
              <Icon markup={ICON_BRANCH} class="koi-welcome-recent-branch-icon" />
              <span class="koi-welcome-recent-branch-name">{entry.branch}</span>
            </span>
          )}
          {entry.openedAt > 0 && <span class="koi-welcome-recent-time">{timeAgo(entry.openedAt, Date.now())}</span>}
        </span>
      </button>
      <button
        type="button"
        class="koi-welcome-recent-pin"
        aria-pressed={!!entry.pinned}
        aria-label={`${entry.pinned ? 'Unpin' : 'Pin'} ${name}`}
        title={entry.pinned ? 'Unpin' : 'Pin'}
        onClick={props.onPin}
      >
        ★
      </button>
      <button
        type="button"
        class="koi-welcome-recent-copy"
        aria-label={`Copy path of ${name}`}
        title="Copy path"
        onClick={props.onCopy}
      >
        ⧉
      </button>
      <button
        type="button"
        class="koi-welcome-recent-remove"
        aria-label={`Remove ${name} from recent folders`}
        title="Remove from recent folders"
        onClick={props.onRemove}
      >
        ✕
      </button>
    </div>
  );
}

/** The example gallery: a labelled search box + vertical difficulty tabs (a state-driven roving
 *  tabindex) + the active level's cards. Owns its own search/level state, persisted across gallery
 *  open/close (it stays mounted, hidden). */
function Gallery(props: { uid: string; templates: readonly Template[]; onOpenExample: (t: Template) => void }): JSX.Element {
  const { uid, templates, onOpenExample } = props;
  const tablistRef = useRef<HTMLDivElement | null>(null);

  const presentLevels = useMemo(
    () => DIFFICULTY_ORDER.filter((d) => templates.some((t) => t.difficulty === d)),
    [templates],
  );
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<Template['difficulty']>(() => presentLevels[0] ?? 'starter');

  const matches = filterTemplates(templates, { query });
  const levelCounts: Partial<Record<Template['difficulty'], number>> = {};
  for (const l of presentLevels) levelCounts[l] = matches.filter((t) => t.difficulty === l).length;

  // Keep the active level valid: if a search emptied it, jump to the first level that still has matches.
  let activeLevel = level;
  if ((levelCounts[activeLevel] ?? 0) === 0) {
    activeLevel = presentLevels.find((l) => (levelCounts[l] ?? 0) > 0) ?? activeLevel;
  }
  // Persist the jump into state so clearing the search doesn't snap back to the emptied level — the
  // imperative builder mutated `state.level` in place for exactly this parity.
  useEffect(() => {
    if (activeLevel !== level) setLevel(activeLevel);
  }, [activeLevel, level]);

  // A plain per-render closure (not memoized) — it reads `levelCounts`, recomputed each render, and is
  // only ever called from this render's own inline handlers, so there's nothing to memoize against.
  const selectLevel = (l: Template['difficulty'], focus = false): void => {
    if ((levelCounts[l] ?? 0) === 0) return; // empty tabs are non-selectable
    setLevel(l);
    // A tab with tabindex=-1 is still programmatically focusable, so focus immediately — the element
    // exists before and after (only its tabindex flips), so this works in prod and under sync-render.
    if (focus) tablistRef.current?.querySelector<HTMLElement>(`[data-level="${l}"]`)?.focus();
  };

  const onTablistKeydown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>): void => {
    const enabled = presentLevels.filter((l) => (levelCounts[l] ?? 0) > 0);
    if (!enabled.length) return;
    const here = Math.max(0, enabled.indexOf(activeLevel));
    let next = here;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = wrapIndex(here, +1, enabled.length);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = wrapIndex(here, -1, enabled.length);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    else return;
    e.preventDefault();
    selectLevel(enabled[next], true);
  };

  const domainCount = templates.length === 1 ? '1 ready-made domain' : `${templates.length} ready-made domains`;
  const cards = matches.filter((t) => t.difficulty === activeLevel);

  return (
    <section class="koi-welcome-gallery" aria-label="Example templates">
      <div class="koi-welcome-gallery-head">
        <div class="koi-welcome-gallery-lede">
          <p class="koi-welcome-eyebrow">Worked examples</p>
          <h2 class="koi-welcome-section-title" id={`${uid}-title`}>
            Start from an example
          </h2>
          <p class="koi-welcome-gallery-sub">{`${domainCount} — open any one as an editable workspace.`}</p>
        </div>
        <div class="koi-welcome-search">
          <label class="koi-sr-only" for={`${uid}-search`}>
            Search example templates
          </label>
          <input
            type="search"
            id={`${uid}-search`}
            class="koi-welcome-search-input"
            placeholder="Search by name or tag…"
            autocomplete="off"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            // Esc inside the search clears it WITHOUT bubbling up to the overlay stack (which would pop
            // the gallery); when the query is already empty, Esc bubbles and closes the gallery.
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
        </div>
      </div>

      <div class="koi-welcome-gallery-main">
        <div
          class="koi-welcome-tablist"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Example difficulty"
          ref={tablistRef}
          onKeyDown={onTablistKeydown}
        >
          {presentLevels.map((l) => {
            const count = levelCounts[l] ?? 0;
            const selected = l === activeLevel;
            return (
              <button
                type="button"
                key={l}
                class={count === 0 ? 'koi-welcome-tab is-empty' : 'koi-welcome-tab'}
                id={`${uid}-tab-${l}`}
                data-level={l}
                role="tab"
                aria-controls={`${uid}-panel`}
                aria-selected={selected}
                aria-disabled={count === 0}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectLevel(l)}
              >
                <span class="koi-welcome-tab-label">{l}</span>
                <span class="koi-welcome-tab-count">{String(count)}</span>
              </button>
            );
          })}
        </div>

        <div
          class="koi-welcome-tabpanel"
          id={`${uid}-panel`}
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`${uid}-tab-${activeLevel}`}
        >
          {!matches.length ? (
            <p class="koi-welcome-gallery-empty" role="status" aria-live="polite">
              No examples match your search.
            </p>
          ) : (
            <div class="koi-welcome-gallery-grid">
              {cards.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  class="koi-welcome-example"
                  aria-label={`${t.name} — ${t.tagline}`}
                  onClick={() => onOpenExample(t)}
                >
                  <span class="koi-welcome-example-icon" aria-hidden="true">
                    {t.icon}
                  </span>
                  <span class="koi-welcome-example-body">
                    <span class="koi-welcome-example-name">{t.name}</span>
                    <span class="koi-welcome-example-blurb">{t.tagline}</span>
                  </span>
                  <Icon markup={ICON_ARROW} class="koi-welcome-example-arrow" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * The routed Home console. Renders the top bar (brand + theme + settings), then a single persistent
 * card holding two swap-in-place views: the start console (hero + launch rail) and the example gallery.
 */
export function Home(props: HomeProps): JSX.Element {
  const { cb, templates, canOpenFolders, warm, canClone, canResume, controls } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const platform = useMemo(() => getPlatform(), []);
  const uid = useMemo(() => `koi-welcome-${Math.random().toString(36).slice(2, 8)}`, []);
  const cloneFormId = useMemo(() => `koi-welcome-clone-form-${Math.random().toString(36).slice(2, 8)}`, []);
  const recentFilterId = useMemo(() => `koi-welcome-recent-filter-${Math.random().toString(36).slice(2, 8)}`, []);

  // Re-render the theme toggle's glyph after each flip (the destination affordance swaps on every flip).
  const [, setThemeTick] = useState(0);

  // Gallery open/close — drives the console↔gallery view swap and the overlay Esc-stack registration.
  const [galleryOpen, setGalleryOpen] = useState(false);
  const showGallery = useCallback(() => setGalleryOpen(true), []);
  const closeGallery = useCallback(() => setGalleryOpen(false), []);

  // Clone form (canClone hosts only).
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneInFlight, setCloneInFlight] = useState(false);
  const toggleCloneForm = useCallback(() => setCloneOpen((o) => !o), []);
  const isValidCloneUrl = CLONE_URL_RE.test(cloneUrl.trim());

  // Recents. `refreshRecent` bumps a nonce that re-reads storage; internal mutations (pin/remove/clear)
  // and the boot-layer seams both route through it.
  const [recentNonce, setRecentNonce] = useState(0);
  const refreshRecent = useCallback(() => setRecentNonce((n) => n + 1), []);
  const [recentQuery, setRecentQuery] = useState('');
  const [recentExpanded, setRecentExpanded] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recentNonce is a deliberate cache-buster: getRecentFolders() reads localStorage (an external source exhaustive-deps can't see), and bumping the nonce is how mutations/refreshRecent force a fresh read
  const allRecents = useMemo(() => getRecentFolders(), [recentNonce]);

  // Version chip (colophon): lazily fetched, hidden until a version resolves (mirrors fillVersionChip).
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    platform
      .appVersion()
      .then((v) => {
        if (!cancelled) setVersion(v ? `v${v}` : null);
      })
      .catch(() => {
        if (!cancelled) setVersion(null);
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  // The resume card self-gates on a persisted snapshot OR the caller's `canResume` signal (#392 / #766).
  const session = useMemo(() => getLastSession(), []);
  const showResume = session !== null || !!canResume;

  // Dead-recent recovery (#391): confirm "Remove from Recent?" and, on accept, forget + refresh in place.
  const recover = useCallback(
    async (path: string): Promise<void> => {
      const forget = await koiConfirm({
        title: `"${basename(path)}" is no longer available`,
        message: 'Its folder may have moved, been deleted, or had its permission revoked. Remove it from Recent?',
        confirmLabel: 'Remove from Recent',
        danger: true,
      });
      if (forget) {
        removeRecentFolder(path);
        refreshRecent();
      }
    },
    [refreshRecent],
  );

  // Cloned-empty recovery (#1017): a non-destructive "cloned, but empty" notice with an Open-anyway path.
  const notifyClonedEmpty = useCallback(
    async (path: string): Promise<void> => {
      const openAnyway = await koiConfirm({
        title: `Cloned "${basename(path)}"`,
        message: "It's saved in Recent, but has no .koi files yet. Open it anyway to start a new model there?",
        confirmLabel: 'Open anyway',
        cancelLabel: 'Not now',
      });
      if (openAnyway) cb.onOpenEmptyAnyway?.(path);
    },
    [cb],
  );

  // Register the imperative handle back through the facade's ref (runs synchronously post-commit, so a
  // caller that invokes `recover`/`notifyClonedEmpty` right after mountHome sees it wired).
  useLayoutEffect(() => {
    controls.current = { refreshRecent, recover, notifyClonedEmpty };
    return () => {
      controls.current = null;
    };
  }, [controls, refreshRecent, recover, notifyClonedEmpty]);

  // Gallery overlay: register on open, unregister on cleanup (also covers destroy() mid-open). Focus
  // lands in the search box so a newcomer can start narrowing immediately (WCAG 2.4.3).
  useEffect(() => {
    if (!galleryOpen) return;
    rootRef.current?.querySelector<HTMLElement>('.koi-welcome-search-input')?.focus();
    const unregister = registerOverlay(closeGallery);
    return () => unregister();
  }, [galleryOpen, closeGallery]);

  // On CLOSE (open→false), return focus to the control that opened the gallery — but NOT on the initial
  // mount and NOT on unmount (destroy), which must drop the layer without animating focus.
  const wasGalleryOpen = useRef(false);
  useEffect(() => {
    if (!galleryOpen && wasGalleryOpen.current) {
      rootRef.current?.querySelector<HTMLElement>('[data-action="open-example"]')?.focus();
    }
    wasGalleryOpen.current = galleryOpen;
  }, [galleryOpen]);

  // Focus the clone URL field when the form opens (matches the imperative toggle's `urlInput.focus()`).
  useEffect(() => {
    if (cloneOpen) rootRef.current?.querySelector<HTMLElement>('.koi-welcome-clone-url')?.focus();
  }, [cloneOpen]);

  // Home keyboard shortcuts (#1005): mod+N new, mod+E gallery, ⇧mod+O open folder, ⇧mod+C clone form.
  // Lives on `document` and is removed on unmount, so a torn-down Home leaves no live handler (#1000/#980);
  // an `isConnected` guard additionally stands a detached-but-not-yet-unmounted copy down.
  useEffect(() => {
    function onHomeKeydown(e: KeyboardEvent): void {
      if (!rootRef.current?.isConnected) return; // a routed-away/detached Home ignores shortcuts
      if (!(e.metaKey || e.ctrlKey)) return; // needs the primary modifier (⌘ / Ctrl)
      if (galleryOpen || isTextEntryFocused()) return; // the gallery owns its own keys; never hijack typing
      const key = e.key.toLowerCase();
      if (e.shiftKey) {
        if (key === 'o' && canOpenFolders) {
          e.preventDefault();
          cb.onOpenFolder();
        } else if (key === 'c' && canClone) {
          e.preventDefault();
          toggleCloneForm();
        }
        return;
      }
      if (key === 'n') {
        e.preventDefault();
        cb.onNewModel();
      } else if (key === 'e') {
        e.preventDefault();
        showGallery();
      }
    }
    document.addEventListener('keydown', onHomeKeydown);
    return () => document.removeEventListener('keydown', onHomeKeydown);
  }, [galleryOpen, canOpenFolders, canClone, cb, showGallery, toggleCloneForm]);

  async function submitClone(): Promise<void> {
    const url = cloneUrl.trim();
    if (cloneInFlight || !CLONE_URL_RE.test(url)) return;
    setCloneError(null);
    setCloneInFlight(true);
    try {
      await cb.onClone?.(url);
      // Resolved: on the happy path onClone opens the cloned folder, tearing this Home down; but it also
      // resolves without navigating when the user dismisses the folder picker, so the finally restores.
    } catch (err) {
      setCloneError(err instanceof Error && err.message ? err.message : 'Clone failed. Check the URL and try again.');
    } finally {
      setCloneInFlight(false);
    }
  }

  const onClearAll = (): void => {
    void koiConfirm({
      title: 'Clear recent folders?',
      message: 'This removes every folder from the Recent list. Your projects on disk are untouched.',
      confirmLabel: 'Clear',
    }).then((ok) => {
      if (!ok) return;
      clearRecentFolders();
      setRecentQuery('');
      setRecentExpanded(false);
      refreshRecent();
    });
  };

  const hasAny = allRecents.length > 0;
  const q = recentQuery.trim().toLowerCase();
  const folders = q
    ? allRecents.filter((r) => r.path.toLowerCase().includes(q) || basename(r.path).toLowerCase().includes(q))
    : allRecents;

  const themeIcon = currentTheme() === 'dark' ? ICON_SUN : ICON_THEME;

  return (
    <div
      class="koi-welcome koi-welcome-embedded"
      ref={rootRef}
      // Clicking the card's backdrop pops one layer: if the gallery is open, close it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && galleryOpen) closeGallery();
      }}
    >
      {/* The app top bar — persists across console↔gallery swaps (it lives outside the card). */}
      <header class="koi-home-topbar">
        <div class="koi-home-topbar-slot koi-home-topbar-start">
          {/* Brand lockup: reuse the editor toolbar's global `.brand` markup. The `koi-home-brand` class
              strips the button hover (this copy is a decorative div). The mark comes from logo.ts. */}
          <div class="brand koi-home-brand" role="img" aria-label="Koine Studio">
            <Icon markup={koineMark()} class="brand-logo" />
            <span class="brand-text" aria-hidden="true">
              <span class="brand-name">Koine</span>
              <span class="brand-eyebrow">Studio</span>
            </span>
          </div>
        </div>
        <div class="koi-home-topbar-slot koi-home-topbar-end">
          <button
            type="button"
            class="koi-home-iconbtn"
            aria-label="Toggle theme"
            title="Toggle theme"
            onClick={() => {
              toggleTheme();
              setThemeTick((t) => t + 1);
            }}
          >
            <Icon markup={themeIcon} />
          </button>
          <button
            type="button"
            class="koi-home-iconbtn"
            aria-label="Settings"
            title="Settings"
            onClick={() => cb.onOpenSettings?.()}
          >
            <Icon markup={ICON_SETTINGS} />
          </button>
        </div>
      </header>

      <div class="koi-welcome-card">
        {/* --- console view --- */}
        <div class="koi-welcome-view" hidden={galleryOpen}>
          <section class="koi-home-body">
            {/* Left: eyebrow + statement + the live snippet + the colophon footer. */}
            <div class="koi-welcome-lede">
              <p class="koi-welcome-eyebrow">The language of your domain</p>
              <h1 class="koi-welcome-statement">
                Describe the domain.
                <br />
                <span class="koi-welcome-grad">Koine</span> writes the code.
              </h1>

              <figure class="koi-welcome-snippet">
                <figcaption class="koi-welcome-snippet-bar">
                  <span class="koi-welcome-snippet-file">billing.koi</span>
                  <span class="koi-welcome-snippet-kind">value object</span>
                </figcaption>
                <pre class="koi-welcome-snippet-code" aria-label="A Koine value object: Money, with a non-negative invariant">
                  <code
                    // eslint-disable-next-line no-restricted-syntax -- static, trusted syntax-highlighted hero snippet (module-scope HERO_SNIPPET), never user input; preserves exact <pre> whitespace
                    dangerouslySetInnerHTML={{ __html: HERO_SNIPPET }}
                  />
                </pre>
                <p class="koi-welcome-snippet-emit">
                  <span class="koi-welcome-emit-dots" aria-hidden="true">
                    {['csharp', 'typescript', 'python', 'php'].map((lang) => (
                      <span key={lang} class="koi-welcome-emit-dot" style={{ '--emit-dot': `var(--lang-${lang})` }} />
                    ))}
                  </span>
                  <span>One model → idiomatic C#, TypeScript, Python &amp; PHP.</span>
                </p>
              </figure>

              {/* Colophon footer: version chip + project links + byline (#403). */}
              <footer class="koi-home-colophon">
                <span class="koi-home-colophon-chip" hidden={version === null}>
                  {version ?? ''}
                </span>
                <nav class="koi-home-colophon-links" aria-label="Koine project links">
                  {['Docs', 'GitHub', 'Blog'].map((label) => {
                    const link = PROJECT_LINKS.find((l) => l.label === label);
                    if (!link) return null;
                    return (
                      <ExternalLink
                        key={label}
                        class="koi-home-colophon-link"
                        href={link.href}
                        title={link.hint}
                        platform={platform}
                      >
                        {link.label}
                      </ExternalLink>
                    );
                  })}
                </nav>
                <p class="koi-home-colophon-credit">
                  {CREDIT_PREFIX}
                  <ExternalLink class="koi-home-colophon-author" href={CREATOR_URL} platform={platform}>
                    {CREATOR_NAME}
                  </ExternalLink>
                  .
                </p>
              </footer>
            </div>

            {/* Right: the launch rail — resume card (when there's a session), actions, then recents. */}
            <div class="koi-welcome-launch">
              {showResume && <ResumeCard session={session} warm={!!warm} onResume={cb.onResume} />}

              <div class="koi-welcome-rail-head">
                <h2 class="koi-welcome-rail-title">Start</h2>
              </div>

              <div class="koi-welcome-actions">
                <ActionButton
                  icon={ICON_NEW}
                  label="New model"
                  desc="Begin with an empty context"
                  primary
                  action="new-model"
                  keys={KEYS_NEW}
                  onClick={() => cb.onNewModel()}
                />
                <ActionButton
                  icon={ICON_GALLERY}
                  label="Start from an example"
                  desc="Open a ready-made domain"
                  action="open-example"
                  keys={KEYS_EXAMPLE}
                  onClick={showGallery}
                />
                {canClone && (
                  <div class="koi-welcome-clone" data-action="clone" onClick={toggleCloneForm}>
                    {/* The trigger carries NO own click handler — its click bubbles to the wrapper toggle. */}
                    <button
                      type="button"
                      class="koi-welcome-action koi-welcome-clone-trigger"
                      aria-expanded={cloneOpen}
                      aria-controls={cloneFormId}
                    >
                      <Icon markup={ICON_BRANCH} class="koi-welcome-action-icon" />
                      <span class="koi-welcome-action-text">
                        <span class="koi-welcome-action-label">Clone repository</span>
                        <span class="koi-welcome-action-desc">Pull an existing Koine project from Git</span>
                      </span>
                      <Keycap keys={KEYS_CLONE} />
                    </button>
                    {/* Contain every click inside the form so none bubbles up to re-toggle (collapse) the row. */}
                    <div
                      class="koi-welcome-clone-form"
                      id={cloneFormId}
                      hidden={!cloneOpen}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div class="koi-welcome-clone-controls">
                        <input
                          type="text"
                          class="koi-welcome-clone-url"
                          placeholder="https://github.com/user/repo.git"
                          aria-label="Repository URL to clone"
                          autocomplete="off"
                          spellcheck={false}
                          value={cloneUrl}
                          onInput={(e) => setCloneUrl((e.target as HTMLInputElement).value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !cloneInFlight && isValidCloneUrl) {
                              e.preventDefault();
                              void submitClone();
                            }
                          }}
                        />
                        <button
                          type="button"
                          class="koi-welcome-clone-submit"
                          disabled={cloneInFlight || !isValidCloneUrl}
                          onClick={() => void submitClone()}
                        >
                          {cloneInFlight ? 'Cloning…' : 'Clone'}
                        </button>
                      </div>
                      <p class="koi-welcome-clone-hint">HTTPS or SSH URL — cloned into a folder you choose.</p>
                      <p class="koi-welcome-clone-error" role="alert" hidden={cloneError === null}>
                        {cloneError ?? ''}
                      </p>
                    </div>
                  </div>
                )}
                <ActionButton
                  icon={ICON_OPEN}
                  label="Open folder…"
                  desc={canOpenFolders ? 'Work on an existing workspace' : 'Needs a Chromium-based browser (Chrome / Edge)'}
                  disabled={!canOpenFolders}
                  action="open-folder"
                  keys={canOpenFolders ? KEYS_OPEN : undefined}
                  onClick={() => cb.onOpenFolder()}
                />
              </div>

              {/* Recent folders — header (title + count pill + filter) never rebuilds; the body does. */}
              <div class="koi-welcome-recent">
                <div class="koi-welcome-recent-head">
                  <div class="koi-welcome-recent-head-title">
                    <h2 class="koi-welcome-rail-title">Recent</h2>
                    <span class="koi-welcome-recent-count" hidden={!hasAny}>
                      {hasAny ? String(allRecents.length) : ''}
                    </span>
                  </div>
                  <div class="koi-welcome-recent-filter-wrap" hidden={!hasAny}>
                    <Icon markup={ICON_SEARCH} class="koi-welcome-recent-filter-icon" />
                    <label class="koi-sr-only" for={recentFilterId} hidden={!hasAny}>
                      Filter recent folders
                    </label>
                    <input
                      type="search"
                      id={recentFilterId}
                      class="koi-welcome-recent-filter"
                      placeholder="Filter…"
                      hidden={!hasAny}
                      value={recentQuery}
                      onInput={(e) => setRecentQuery((e.target as HTMLInputElement).value)}
                    />
                  </div>
                </div>

                <div class="koi-welcome-recent-body">
                  {!hasAny ? (
                    <p class="koi-welcome-empty">Folders you open will show up here.</p>
                  ) : (
                    <>
                      <div class="koi-welcome-recent-list">
                        {folders.map((entry, i) => (
                          <RecentRow
                            key={entry.path}
                            entry={entry}
                            hidden={!recentExpanded && i >= RECENT_COLLAPSE_LIMIT}
                            onOpen={() => cb.onOpenRecent(entry.path)}
                            onPin={() => {
                              pinRecentFolder(entry.path, !entry.pinned);
                              refreshRecent();
                            }}
                            onCopy={() => {
                              void navigator.clipboard?.writeText(entry.path).catch(() => {});
                            }}
                            onRemove={() => {
                              removeRecentFolder(entry.path);
                              refreshRecent();
                            }}
                          />
                        ))}
                      </div>
                      {folders.length > RECENT_COLLAPSE_LIMIT && (
                        <button
                          type="button"
                          class="koi-welcome-recent-toggle"
                          aria-expanded={recentExpanded}
                          onClick={() => setRecentExpanded((x) => !x)}
                        >
                          {recentExpanded ? 'Show less' : `View all ${folders.length}`}
                        </button>
                      )}
                      <button type="button" class="koi-welcome-recent-clear" onClick={onClearAll}>
                        Clear recent folders
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* --- gallery view: the example catalogue, swapped in over the console --- */}
        <div
          class="koi-welcome-view koi-gallery-view"
          hidden={!galleryOpen}
          role="region"
          aria-labelledby={`${uid}-title`}
        >
          <div class="koi-welcome-bar koi-gallery-bar">
            <button type="button" class="koi-welcome-back" aria-label="Back to the start console" onClick={closeGallery}>
              <Icon markup={ICON_BACK} class="koi-welcome-back-icon" />
              <span>Back to start</span>
            </button>
          </div>
          <Gallery uid={uid} templates={templates} onOpenExample={cb.onOpenExample} />
        </div>
      </div>
    </div>
  );
}
