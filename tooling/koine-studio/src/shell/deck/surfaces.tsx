// Deck surfaces — the single registry of the four center surfaces (Canvas / Code / Output / Docs),
// their hoisted facets, accent hue, and icon. Shared by the Deck components (DeckSpine / DeckCard /
// DeckStage) and by inspectorController (which maps facet clicks to setTech/setOutput/setDocs and
// computes which facet is active). Ported from the Deck v2 POC's SURFACES + ICONS registry, with the
// POC's `--st-*` accents rewritten to the app's real `--koi-ddd-*` / `--koi-hl-*` tokens.
import type { JSX } from 'preact';
import type { CenterView } from '@/store/slices/uiChrome';

/** One hoisted facet (sub-view) of a surface — the value is the surface's facet-enum member as a
 *  string (TechView / OutputTab / DocsView); the controller narrows it back when applying. */
export interface DeckFacet {
  value: string;
  label: string;
}

export interface DeckSurface {
  id: CenterView;
  label: string;
  /** Short subtitle shown in the card header (1-up / overview) and as the chip title. */
  tag: string;
  /** CSS custom-property reference tinting the surface's header icon. */
  accent: string;
  icon: (props: { class?: string }) => JSX.Element;
  /** The surface's facets, in display order. Empty when the surface has a single view (Canvas). */
  facets: DeckFacet[];
}

// --- Icons (camelCased SVG, ported 1:1 from the POC ICONS) -------------------

function svg(children: JSX.Element, opts: { fill?: string; strokeWidth?: number; lineCap?: boolean } = {}) {
  return (props: { class?: string }) => (
    <svg
      class={props.class}
      viewBox="0 0 24 24"
      fill={opts.fill ?? 'none'}
      stroke={opts.fill === 'currentColor' ? undefined : 'currentColor'}
      stroke-width={opts.fill === 'currentColor' ? undefined : (opts.strokeWidth ?? 1.7)}
      stroke-linecap={opts.lineCap ? 'round' : undefined}
      stroke-linejoin={opts.lineCap ? 'round' : undefined}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconCanvas = svg(
  <>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="18" cy="8" r="2.4" />
    <circle cx="9" cy="18" r="2.4" />
    <path d="M8 6.6 15.6 7.5M7.6 15.9 8.4 8.4M11.2 17 16 9.8" />
  </>,
);
export const IconCode = svg(<path d="M8 7 3 12l5 5M16 7l5 5-5 5M14 4l-4 16" />, { lineCap: true });
export const IconOutput = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3M13.5 15H17" />
  </>,
  { lineCap: true },
);
export const IconDocs = svg(
  <>
    <path d="M5 4h10a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" />
    <path d="M9 8h5M9 12h5" />
  </>,
);
// IconOverview / IconSplit / IconClose / IconSwap moved to @atypical/koine-ui's deckIcons.tsx (issue #905,
// Task 4 + concept-7) — DeckSpine / DeckCard, their only consumers, now live there.

// --- Registry ----------------------------------------------------------------

/** The four surfaces in filmstrip / keyboard (1–4) order: Canvas · Code · Output · Docs. */
export const DECK_SURFACE_ORDER: CenterView[] = ['visual', 'technical', 'output', 'docs'];

export const DECK_SURFACES: Record<CenterView, DeckSurface> = {
  visual: {
    id: 'visual',
    label: 'Canvas',
    tag: 'Domain diagram',
    accent: 'var(--koi-ddd-aggregate)',
    icon: IconCanvas,
    facets: [],
  },
  technical: {
    id: 'technical',
    label: 'Code',
    tag: 'ubiquitous.koi',
    accent: 'var(--koi-hl-keyword)',
    icon: IconCode,
    facets: [
      { value: 'editor', label: 'Editor' },
      { value: 'scenarios', label: 'Scenarios' },
    ],
  },
  output: {
    id: 'output',
    label: 'Output',
    tag: 'Compiler artifacts',
    accent: 'var(--koi-ddd-event)',
    icon: IconOutput,
    facets: [
      { value: 'generated', label: 'Generated' },
      { value: 'compatibility', label: 'Compatibility' },
      { value: 'contextmap', label: 'Context Map' },
    ],
  },
  docs: {
    id: 'docs',
    label: 'Docs',
    tag: 'Glossary & ADRs',
    accent: 'var(--koi-ddd-entity)',
    icon: IconDocs,
    facets: [
      { value: 'glossary', label: 'Glossary' },
      { value: 'adr', label: 'Decisions' },
      { value: 'notes', label: 'Notes' },
    ],
  },
};

/** The surfaces in display order — convenience for mapping the filmstrip / overview. */
export const DECK_SURFACE_LIST: DeckSurface[] = DECK_SURFACE_ORDER.map((id) => DECK_SURFACES[id]);
