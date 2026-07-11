// The keyboard-shortcuts table body rendered into the shared createModal() (src/shared/help.ts). Plain
// JSX over ShortcutRow[] — ported from help.ts's imperative buildTable()/appendKeycaps() (#991, task 5).
// Each chord (e.g. 'mod+Shift+O') splits on '+' into one .koi-kbd keycap per segment; a literal 'mod'
// segment renders as ⌘/Ctrl per platform via the shared modKey() (src/shared/platform.ts) — the same
// substitution the toolbar hints and command palette use, so the help overlay always agrees with them.
import { Fragment } from 'preact';
import { modKey } from '@/shared/platform';
import type { ShortcutRow } from '@/shared/help';

export function ShortcutsTable(props: { rows: ShortcutRow[] }) {
  return (
    <table class="koi-help-table">
      <tbody>
        {props.rows.map((row, i) => (
          <tr key={`${i}-${row.keys}`}>
            <td>
              <Keycaps keys={row.keys} />
            </td>
            <td>{row.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Split a chord like 'mod+Shift+O' on '+' and render one .koi-kbd keycap per segment. */
function Keycaps(props: { keys: string }) {
  const parts = props.keys
    .split('+')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 ? ' ' : null}
          <span class="koi-kbd">{modKey(part)}</span>
        </Fragment>
      ))}
    </>
  );
}
