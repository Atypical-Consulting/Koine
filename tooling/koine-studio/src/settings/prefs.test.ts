// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPreferences, type PrefsCallbacks } from '@/settings/prefs';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '@/settings/persistence';

// Flush queued microtasks + timers so the panel's async steps (mcpEndpoint, mcpStop, probe) settle.
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush();
}

const URL = 'http://127.0.0.1:51000/mcp';

function openPrefs(over: Partial<PrefsCallbacks> = {}): void {
  const prefs = createPreferences({
    onChange: () => {},
    mcpEndpoint: async () => URL,
    mcpStop: async () => {},
    mcpHostable: true,
    ...over,
  });
  prefs.open();
}

const mcpToggle = () =>
  document.querySelector<HTMLButtonElement>('.koi-switch[aria-label="Enable MCP server"]')!;
const mcpClientSelect = () =>
  document.querySelector<HTMLSelectElement>('#koi-settings-panel-mcp .koi-select')!;
const snippet = () => document.querySelector<HTMLPreElement>('.koi-mcp-snippet')!;
const status = () => document.querySelector<HTMLElement>('.koi-mcp-status')!;
const endpointUrl = () => document.querySelector<HTMLInputElement>('.koi-mcp-control .koi-text')!;
const testBtn = () =>
  [...document.querySelectorAll<HTMLButtonElement>('#koi-settings-panel-mcp .koi-set-action')].find(
    (b) => b.textContent === 'Test connection',
  )!;

describe('Settings → MCP panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
  });

  it('starts disabled, server off, with the LM Studio HTTP recipe (placeholder URL)', async () => {
    openPrefs();
    await settle();
    expect(mcpToggle().getAttribute('aria-checked')).toBe('false');
    expect(status().dataset.state).toBe('off');
    // Disabled ⇒ no endpoint started ⇒ the HTTP snippet carries the placeholder, not a live URL.
    expect(snippet().textContent).toContain('"url"');
    expect(snippet().textContent).toContain('PORT');
  });

  it('enabling starts the sidecar and the snippet picks up the live URL', async () => {
    const mcpEndpoint = vi.fn(async () => URL);
    openPrefs({ mcpEndpoint });
    await settle();
    mcpToggle().click();
    await settle();
    expect(mcpEndpoint).toHaveBeenCalled();
    expect(endpointUrl().value).toBe(URL);
    expect(snippet().textContent).toContain(URL);
  });

  it('disabling stops the sidecar', async () => {
    const mcpStop = vi.fn(async () => {});
    openPrefs({ mcpStop });
    await settle();
    mcpToggle().click(); // on
    await settle();
    mcpToggle().click(); // off
    await settle();
    expect(mcpStop).toHaveBeenCalled();
    expect(status().dataset.state).toBe('off');
  });

  it('switching to Claude Desktop shows the stdio command recipe', async () => {
    openPrefs();
    await settle();
    const sel = mcpClientSelect();
    sel.value = 'claude-desktop';
    sel.dispatchEvent(new Event('change'));
    await settle();
    expect(snippet().textContent).toContain('koine-mcp');
    expect(snippet().textContent).not.toContain('"url"');
  });

  it('Test connection reports the tool count from a stubbed server', async () => {
    const TOOLS = ['koine_validate', 'koine_compile', 'koine_format', 'koine_reference', 'koine_examples'];
    const fetchStub = vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const payload =
        body.method === 'initialize'
          ? { result: { serverInfo: { name: 'koine' } } }
          : { result: { tools: TOOLS.map((name) => ({ name })) } };
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchStub as unknown as typeof fetch;
    try {
      openPrefs();
      await settle();
      mcpToggle().click(); // enable so the endpoint resolves
      await settle();
      testBtn().click();
      await settle();
      expect(status().dataset.state).toBe('ok');
      expect(status().textContent).toContain('5 tools');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('on a non-hostable (web) host the toggle is disabled but recipes still render', async () => {
    openPrefs({ mcpHostable: false });
    await settle();
    expect(mcpToggle().disabled).toBe(true);
    expect(snippet().textContent).toContain('"url"');
  });

  it('enabling when the sidecar fails to start surfaces a failure status', async () => {
    openPrefs({ mcpEndpoint: async () => null });
    await settle();
    mcpToggle().click();
    await settle();
    expect(endpointUrl().value).toBe('');
    expect(status().dataset.state).toBe('fail');
  });
});

describe('Settings → Output panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
  });

  const langOpts = () =>
    [...document.querySelectorAll<HTMLButtonElement>('#koi-settings-panel-output .koi-lang-opt')];

  it('renders the five language options with C# selected by default', () => {
    openPrefs();
    const opts = langOpts();
    expect(opts.map((b) => b.dataset.value)).toEqual(['csharp', 'typescript', 'python', 'php', 'rust']);
    const checked = opts.find((b) => b.getAttribute('aria-checked') === 'true');
    expect(checked?.dataset.value).toBe('csharp');
  });

  it('selecting a language commits previewTarget and reports it via onChange', () => {
    const onChange = vi.fn();
    openPrefs({ onChange });
    langOpts().find((b) => b.dataset.value === 'python')!.click();
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(last.previewTarget).toBe('python');
    expect(loadSettings().previewTarget).toBe('python');
  });

  it('reflects the persisted target when reopened', () => {
    saveSettings({ ...DEFAULT_SETTINGS, previewTarget: 'php' });
    openPrefs();
    const checked = langOpts().find((b) => b.getAttribute('aria-checked') === 'true');
    expect(checked?.dataset.value).toBe('php');
  });
});

describe('Settings → About panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
  });

  it('renders About as the last category tab with the wordmark and four links', () => {
    openPrefs();
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.koi-settings-tab')];
    expect(tabs[tabs.length - 1]?.id).toBe('koi-settings-tab-about');
    const panel = document.querySelector('#koi-settings-panel-about')!;
    expect(panel.querySelector('.koi-about-wordmark')?.textContent).toContain('Koine');
    const labels = [...panel.querySelectorAll('.koi-about-link-label')].map((n) => n.textContent);
    expect(labels).toEqual(['GitHub', 'Home', 'Docs', 'Blog']);
  });

  it('open("about") opens directly on the About tab', () => {
    const prefs = createPreferences({
      onChange: () => {},
      mcpEndpoint: async () => URL,
      mcpStop: async () => {},
      mcpHostable: true,
    });
    prefs.open('about');
    const tab = document.querySelector<HTMLButtonElement>('#koi-settings-tab-about')!;
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector<HTMLElement>('#koi-settings-panel-about')!.hidden).toBe(false);
  });

  it('fills the build chip on open', async () => {
    openPrefs();
    await settle();
    const chip = document.querySelector<HTMLElement>('#koi-settings-panel-about .koi-about-chip')!;
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toMatch(/^v/);
  });
});
