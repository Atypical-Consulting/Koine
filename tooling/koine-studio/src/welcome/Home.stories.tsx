import type { Meta, StoryObj } from '@storybook/preact-vite';
import { Home, type WelcomeCallbacks, type HomeControls } from '@/welcome/Home';
import type { Template } from '@/welcome/templates';

// The routed Home view (#991 task 3): the top bar (brand + theme + settings), a hero snippet + colophon
// on the left, and the launch rail (resume card + Start actions + recents) on the right, with the
// example gallery swapped in over the console on demand. Store-free — driven purely by props/callbacks —
// so a story just supplies no-op callbacks, a sample template set, and a throwaway `controls` ref (the
// facade's imperative-handle seam, unused by the rendered component). The Storybook/Chromium project
// runs these with axe, mirroring welcome.test.ts's a11y pins.

/** A minimal Template factory — only the fields the gallery reads need realistic values. */
const tpl = (over: Partial<Template> & Pick<Template, 'id' | 'name' | 'difficulty'>): Template =>
  ({
    tagline: '',
    description: '',
    tags: [],
    contexts: [],
    coreAggregate: 'Root',
    entryFile: `${over.id}.koi`,
    teaches: [],
    icon: '📦',
    source: '',
    ...over,
  }) as Template;

const SAMPLE: Template[] = [
  tpl({ id: 'billing', name: 'Billing', tagline: 'Money and orders', difficulty: 'starter', tags: ['money', 'orders'], icon: '💳' }),
  tpl({ id: 'ordering', name: 'Ordering', tagline: 'A state machine', difficulty: 'starter', tags: ['state-machine'], icon: '📦' }),
  tpl({ id: 'library', name: 'Library', tagline: 'Loans and fines', difficulty: 'intermediate', tags: ['ddd'], icon: '📚' }),
  tpl({ id: 'saas', name: 'SaaS Subscription', tagline: 'Multi-tenant metering', difficulty: 'advanced', tags: ['saas'], icon: '🧾' }),
];

const noop = (): void => {};
const cb: WelcomeCallbacks = {
  onNewModel: noop,
  onOpenFolder: noop,
  onOpenRecent: noop,
  onOpenExample: noop,
  onResume: noop,
  onOpenSettings: noop,
  onClone: () => Promise.resolve(),
};

/** A throwaway imperative-handle ref (the facade owns the real one; the component only populates it). */
const controls: { current: HomeControls | null } = { current: null };

const meta = {
  title: 'Panels/Home',
  component: Home,
  parameters: { layout: 'fullscreen' },
  args: {
    cb,
    templates: SAMPLE,
    canOpenFolders: true,
    controls,
  },
} satisfies Meta<typeof Home>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The start console: hero + launch rail, empty recents, no resume card. */
export const Console: Story = {};

/** A returning user owed one-click Resume (#766) — the minimal "Resume editing" card shows. */
export const CanResume: Story = { args: { canResume: true } };

/** A desktop host that can clone a git repository (#1005) — the Clone-repository Start row renders. */
export const CloneCapable: Story = { args: { canClone: true } };

/** A browser host that can't open folders — the "Open folder…" action is disabled with an honest reason. */
export const NoFolderAccess: Story = { args: { canOpenFolders: false } };
