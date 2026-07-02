// The empty-canvas state for the domain diagram: the inviting "blank vellum" the visual editor shows
// before the model has anything to draw. Plain DOM (no renderer dependency), so it is shared by whichever
// renderer is active — the concept tiles carry click handlers that dispatch {@link EMPTY_STATE_PICK_EVENT},
// which ide.ts turns into a seeded starter `.koi`.
import { EMPTY_STATE_PICK_EVENT, type EmptyConceptKind, type EmptyStatePickDetail } from '@/diagrams/diagramContract';

/** SVG glyph (drawn in the canvas's own node idiom) previewing each starting shape. Themed off --tile. */
const CONCEPT_GLYPH: Record<EmptyConceptKind, string> = {
  // A UML class box (the aggregate boundary) with a concept-coloured title bar + attribute rules, and a
  // small nested box hinting at the entities/values it owns.
  aggregate: `<svg viewBox="0 0 100 64" class="koi-glyph" aria-hidden="true" focusable="false">
      <rect class="koi-glyph__box" x="8" y="6" width="58" height="52" rx="4"/>
      <path class="koi-glyph__head" d="M8 10a4 4 0 0 1 4-4h50a4 4 0 0 1 4 4v8H8z"/>
      <line class="koi-glyph__row" x1="16" y1="28" x2="50" y2="28"/>
      <line class="koi-glyph__row" x1="16" y1="37" x2="58" y2="37"/>
      <rect class="koi-glyph__nested" x="40" y="42" width="40" height="16" rx="3"/>
    </svg>`,
  // Three lifecycle pills joined by directed transitions (Draft → Placed → Shipped).
  stateMachine: `<svg viewBox="0 0 100 40" class="koi-glyph" aria-hidden="true" focusable="false">
      <rect class="koi-glyph__state" x="2" y="13" width="24" height="15" rx="7.5"/>
      <rect class="koi-glyph__state" x="38" y="13" width="24" height="15" rx="7.5"/>
      <rect class="koi-glyph__state" x="74" y="13" width="24" height="15" rx="7.5"/>
      <path class="koi-glyph__edge" d="M26 20.5H37"/>
      <path class="koi-glyph__arrow" d="M37 20.5l-5-2.5v5z"/>
      <path class="koi-glyph__edge" d="M62 20.5H73"/>
      <path class="koi-glyph__arrow" d="M73 20.5l-5-2.5v5z"/>
    </svg>`,
  // Two bounded contexts and the directed relationship that maps one onto the other.
  contextMap: `<svg viewBox="0 0 100 52" class="koi-glyph" aria-hidden="true" focusable="false">
      <rect class="koi-glyph__ctx" x="4" y="12" width="32" height="28" rx="5"/>
      <rect class="koi-glyph__ctx" x="64" y="12" width="32" height="28" rx="5"/>
      <path class="koi-glyph__edge" d="M36 26H63"/>
      <path class="koi-glyph__arrow" d="M63 26l-6-3v6z"/>
    </svg>`,
};

/** The three doorways, in the order the prose lists them: copy + concept colour + real `.koi` keyword. */
const CONCEPT_TILES: ReadonlyArray<{
  kind: EmptyConceptKind;
  name: string;
  desc: string;
  keyword: string;
  color: string;
}> = [
  {
    kind: 'aggregate',
    name: 'Aggregate',
    desc: 'A consistency boundary that owns its entities and value objects.',
    keyword: 'aggregate',
    color: 'var(--koi-ddd-aggregate)',
  },
  {
    kind: 'stateMachine',
    name: 'State machine',
    desc: 'The lifecycle a concept moves through — states and guarded transitions.',
    keyword: 'states',
    color: 'var(--koi-ddd-state-machine)',
  },
  {
    kind: 'contextMap',
    name: 'Context map',
    desc: 'How your bounded contexts relate across the wider domain.',
    keyword: 'contextmap',
    color: 'var(--koi-accent)',
  },
];

/**
 * Build the empty-canvas state. Real DOM (not innerHTML) so the concept tiles carry click + keyboard
 * handlers that dispatch {@link EMPTY_STATE_PICK_EVENT}; ide.ts seeds the picked starter and the canvas
 * re-renders.
 */
export function buildEmptyState(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'koi-canvas-empty';

  const stage = document.createElement('div');
  stage.className = 'koi-canvas-empty__stage';
  // The screen is one self-contained invitation; name it for assistive tech.
  stage.setAttribute('role', 'group');
  stage.setAttribute('aria-label', 'Start your domain model');

  const eyebrow = document.createElement('p');
  eyebrow.className = 'koi-canvas-empty__eyebrow';
  eyebrow.textContent = 'Domain canvas';

  const title = document.createElement('h2');
  title.className = 'koi-canvas-empty__title';
  title.textContent = 'Start your domain model';

  const lead = document.createElement('p');
  lead.className = 'koi-canvas-empty__lead';
  // Keep the recognisable "No diagrams yet" thread for anyone (and any test) scanning for it, then turn
  // it into a directive: the canvas is a consequence of the model, picking a doorway is the first move.
  lead.textContent =
    'No diagrams yet. The canvas fills in as you describe your model in Koine — pick a starting point to drop your first concept.';

  const tiles = document.createElement('div');
  tiles.className = 'koi-canvas-empty__tiles';
  for (const t of CONCEPT_TILES) tiles.appendChild(buildConceptTile(t));

  const alt = document.createElement('p');
  alt.className = 'koi-canvas-empty__alt';
  alt.append('Prefer to type? Open the ');
  const codeTab = document.createElement('b');
  codeTab.textContent = 'Code';
  alt.append(codeTab, ' tab and write .koi directly.');

  stage.append(eyebrow, title, lead, tiles, alt);
  root.appendChild(stage);
  return root;
}

/** One concept doorway: a button styled as a card, previewing (and on click, seeding) its shape. */
function buildConceptTile(t: (typeof CONCEPT_TILES)[number]): HTMLButtonElement {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'koi-concept-tile';
  tile.dataset.kind = t.kind;
  tile.style.setProperty('--tile', t.color);
  tile.setAttribute('aria-label', `Add ${article(t.name)} ${t.name.toLowerCase()} to your model`);

  const glyph = document.createElement('span');
  glyph.className = 'koi-concept-tile__glyph';
  glyph.innerHTML = CONCEPT_GLYPH[t.kind]; // trusted, static markup defined above

  const name = document.createElement('span');
  name.className = 'koi-concept-tile__name';
  name.textContent = t.name;

  const desc = document.createElement('span');
  desc.className = 'koi-concept-tile__desc';
  desc.textContent = t.desc;

  const kw = document.createElement('span');
  kw.className = 'koi-concept-tile__kw';
  kw.textContent = t.keyword;

  tile.append(glyph, name, desc, kw);
  tile.addEventListener('click', () => {
    tile.dispatchEvent(
      new CustomEvent<EmptyStatePickDetail>(EMPTY_STATE_PICK_EVENT, { bubbles: true, detail: { kind: t.kind } }),
    );
  });
  return tile;
}

/** "an" before a vowel-led label, "a" otherwise — for the tile's aria-label. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}
