// Panel-level checks for the workspace search UI. These stand in for the plan's manual check (the
// browser web build needs the CI-only WASM bundle): they mount the real SearchPanel with fake seams
// and assert the observable behaviour — a results tree grouped by file with correct counts, an
// invalid-regex inline error, live-buffer text winning over disk, and a click revealing the match.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { SearchPanel, type SearchPanelOptions } from '@/shell/searchController';

afterEach(() => cleanup());

const DISK: Record<string, string> = {
  'file:///a.koi': 'aggregate Order\n  total: Money\n',
  'file:///b.koi': 'value Money\n',
};

function makeOpts(over: Partial<SearchPanelOptions> = {}): SearchPanelOptions {
  return {
    listFiles: vi.fn(async () => Object.keys(DISK)),
    readFile: vi.fn(async (uri: string) => DISK[uri] ?? null),
    getActiveBuffers: vi.fn(() => new Map<string, string>()),
    openAndReveal: vi.fn(),
    labelOf: (uri: string) => uri.replace('file:///', ''),
    replaceInBuffer: vi.fn(),
    writeFile: vi.fn(async () => {}),
    ...over,
  };
}

function mount(opts: SearchPanelOptions) {
  return render(<SearchPanel {...opts} visible={true} onClose={() => {}} />);
}

describe('SearchPanel', () => {
  test('renders a results tree grouped by file with per-file and total counts', async () => {
    const opts = makeOpts();
    const view = mount(opts);
    fireEvent.input(view.getByLabelText('Search text'), { target: { value: 'Money' } });

    await view.findByText('2 results in 2 files');
    expect(view.getByText('a.koi')).toBeTruthy();
    expect(view.getByText('b.koi')).toBeTruthy();
    // One match button per hit, across both files.
    expect(view.container.querySelectorAll('.koi-search-match')).toHaveLength(2);
  });

  test('clicking a result reveals the match with its file uri and 1-based line / 0-based column', async () => {
    const opts = makeOpts();
    const view = mount(opts);
    fireEvent.input(view.getByLabelText('Search text'), { target: { value: 'Money' } });

    await waitFor(() => expect(view.container.querySelectorAll('.koi-search-match')).toHaveLength(2));
    fireEvent.click(view.container.querySelector('.koi-search-match') as HTMLElement);

    expect(opts.openAndReveal).toHaveBeenCalledTimes(1);
    const [uri, match] = (opts.openAndReveal as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(uri).toBe('file:///a.koi');
    expect(match).toMatchObject({ line: 2, column: 9, length: 5 });
  });

  test('an invalid regex shows an inline error and no results', async () => {
    const opts = makeOpts();
    const view = mount(opts);
    fireEvent.click(view.getByTitle('Use regular expression'));
    fireEvent.input(view.getByLabelText('Search text'), { target: { value: '(' } });

    const alert = await view.findByRole('alert');
    expect(alert.textContent).toBeTruthy();
    expect(view.container.querySelectorAll('.koi-search-match')).toHaveLength(0);
  });

  test('searches live (unsaved) buffer text in preference to on-disk text', async () => {
    const opts = makeOpts({
      getActiveBuffers: () => new Map([['file:///a.koi', 'aggregate Order\n  total: Cash\n']]),
    });
    const view = mount(opts);
    fireEvent.input(view.getByLabelText('Search text'), { target: { value: 'Cash' } });

    await view.findByText('1 result in 1 file');
    // The live buffer supplied a.koi's text, so it was never read from disk.
    expect(opts.readFile).not.toHaveBeenCalledWith('file:///a.koi');
  });

  test('an include glob narrows which files are searched', async () => {
    const opts = makeOpts();
    const view = mount(opts);
    fireEvent.input(view.getByLabelText('Search text'), { target: { value: 'Money' } });
    await view.findByText('2 results in 2 files');

    fireEvent.input(view.getByLabelText('Files to include'), { target: { value: 'a.koi' } });
    await view.findByText('1 result in 1 file');
  });

  test('Replace all routes an open buffer through the dirty pipeline and a closed file to disk', async () => {
    // a.koi is OPEN (live buffer); b.koi is CLOSED (read from disk).
    const opts = makeOpts({
      getActiveBuffers: () => new Map([['file:///a.koi', 'aggregate Order\n  total: Money\n']]),
    });
    const view = mount(opts);
    fireEvent.input(view.getByLabelText('Search text'), { target: { value: 'Money' } });
    fireEvent.input(view.getByLabelText('Replace with'), { target: { value: 'Cash' } });
    await view.findByText('2 results in 2 files');

    fireEvent.click(view.getByLabelText('Replace all'));

    await waitFor(() => {
      // Open buffer → through the buffer/dirty pipeline with its replaced text.
      expect(opts.replaceInBuffer).toHaveBeenCalledWith('file:///a.koi', 'aggregate Order\n  total: Cash\n');
      // Closed file → written to disk with its replaced text.
      expect(opts.writeFile).toHaveBeenCalledWith('file:///b.koi', 'value Cash\n');
    });
  });

  test('per-file Replace touches only that file', async () => {
    const opts = makeOpts();
    const view = mount(opts);
    fireEvent.input(view.getByLabelText('Search text'), { target: { value: 'Money' } });
    fireEvent.input(view.getByLabelText('Replace with'), { target: { value: 'Cash' } });
    await view.findByText('2 results in 2 files');

    fireEvent.click(view.getByLabelText('Replace all in a.koi'));

    await waitFor(() => expect(opts.writeFile).toHaveBeenCalledWith('file:///a.koi', 'aggregate Order\n  total: Cash\n'));
    expect(opts.writeFile).not.toHaveBeenCalledWith('file:///b.koi', expect.anything());
  });
});
