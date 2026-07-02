// OWNED preview for DeckBar (no @ds-preview marker — owned files win over the generated twin).
//
// Same root cause as DeckCard: the generated preview recompiles DeckBar.stories.tsx, whose deck-surface
// `icon: (props) => JSX.Element` fixtures are Preact JSX. Compiled with React's runtime they become
// frozen React elements, and the real (Preact) DeckBar threw "Cannot add property __, object is not
// extensible" trying to render them. This owned preview supplies the same surfaces with icons built
// from the bundle's own Preact `h`. DeckBar is full-width chrome (storybook `layout: fullscreen`), so
// each story renders the bar directly. Fixtures mirror src/components/deckFixtures.tsx (SAMPLE_SURFACES).
import { DeckBar, h } from '@atypical/koine-ui';

const svgIcon = (children: any) => (props: { class?: string }) =>
  h('svg', { class: props.class, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'aria-hidden': 'true' }, children);

const IconCanvas = svgIcon([
  h('circle', { cx: 6, cy: 6, r: 2.4 }),
  h('circle', { cx: 18, cy: 8, r: 2.4 }),
  h('circle', { cx: 9, cy: 18, r: 2.4 }),
  h('path', { d: 'M8 6.6 15.6 7.5M7.6 15.9 8.4 8.4M11.2 17 16 9.8' }),
]);
const IconCode = svgIcon(h('path', { d: 'M8 7 3 12l5 5M16 7l5 5-5 5M14 4l-4 16', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
const IconOutput = svgIcon([
  h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
  h('path', { d: 'M7 9l3 3-3 3M13.5 15H17', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
]);
const IconDocs = svgIcon([
  h('path', { d: 'M5 4h10a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z' }),
  h('path', { d: 'M9 8h5M9 12h5' }),
]);

// SAMPLE_SURFACES, in filmstrip order (Canvas / Code / Output / Docs).
const SURFACES: any[] = [
  { id: 'visual', label: 'Canvas', tag: 'Domain diagram', accent: 'var(--koi-ddd-aggregate)', icon: IconCanvas, facets: [] },
  { id: 'technical', label: 'Code', tag: 'ubiquitous.koi', accent: 'var(--koi-hl-keyword)', icon: IconCode,
    facets: [{ value: 'editor', label: 'Editor' }, { value: 'scenarios', label: 'Scenarios' }] },
  { id: 'output', label: 'Output', tag: 'Compiler artifacts', accent: 'var(--koi-ddd-event)', icon: IconOutput,
    facets: [{ value: 'generated', label: 'Generated' }, { value: 'compatibility', label: 'Compatibility' }, { value: 'contextmap', label: 'Context Map' }] },
  { id: 'docs', label: 'Docs', tag: 'Glossary & ADRs', accent: 'var(--koi-ddd-entity)', icon: IconDocs,
    facets: [{ value: 'glossary', label: 'Glossary' }, { value: 'adr', label: 'Decisions' }, { value: 'notes', label: 'Notes' }] },
];

const noop = () => {};
const base = { surfaces: SURFACES, onOverview: noop, onFocus: noop, onOpenBeside: noop };

/** 1-up: Canvas is the sole shown surface; the other three chips offer "open beside" on hover. */
export const Focus1Up = () => <DeckBar mode="focus" primary="visual" secondary={null} {...base} />;

/** 2-up: Code is primary (filled) and Canvas is secondary (tinted outline); the rest stay neutral. */
export const Focus2Up = () => <DeckBar mode="focus" primary="technical" secondary="visual" {...base} />;

/** Overview: the bird's-eye toggle is active; no chip carries the "open beside" affordance. */
export const Overview = () => <DeckBar mode="overview" primary="visual" secondary="technical" {...base} />;
