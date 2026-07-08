// Renders a `PreviewViewModel` (issue #1143, task 5) into the launcher's `.lx-preview` pane — plain
// Preact JSX, never innerHTML. Every section (`.pv-file`, `.pv-code-block`, `.pv-grid`, `.pv-states`,
// `.pv-fields`, `.pv-pills`, `.pv-note`, the diff/commit-file rows) is conditionally rendered off
// whichever optional field the selected result's builder actually populated; sections whose data the
// builder degraded away (see preview.ts's per-builder doc comments) simply don't render.
import { Fragment } from 'preact';
import { KIND } from '@/launcher/catalog';
import { GlyphPaths, type GlyphKind } from '@/launcher/ResultRow';
import type { PreviewViewModel } from '@/launcher/preview';

export interface PreviewPaneProps {
  model: PreviewViewModel;
}

function FileIcon() {
  return (
    <svg class="lx-ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 2.4h4.5l3 3v8H4z" />
      <path d="M8.5 2.4v3h3" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg class="lx-ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.2 3.2 4v3.4c0 3 2 5 4.8 6.4 2.8-1.4 4.8-3.4 4.8-6.4V4z" />
    </svg>
  );
}

/** One `.lx-item`-style header: a DDD chip (`chipSlug`) or a line-icon glyph (`glyph`), plus name/sub. */
function PreviewHead({ chipSlug, glyph, name, sub }: PreviewViewModel['header']) {
  const chip = chipSlug ? KIND[chipSlug as keyof typeof KIND] : undefined;
  return (
    <div class="pv-head">
      {chip ? (
        <span class="lx-kind" style={{ '--kc': `var(${chip.token})` }} title={chip.word}>
          {chip.code}
        </span>
      ) : (
        <span class="lx-glyph">
          <svg class="lx-ic" viewBox="0 0 16 16" aria-hidden="true">
            <GlyphPaths kind={(glyph as GlyphKind) ?? 'file'} />
          </svg>
        </span>
      )}
      <div class="pv-title">
        <div class="pv-name">{name}</div>
        <div class="pv-sub">{sub}</div>
      </div>
    </div>
  );
}

export function PreviewPane({ model }: PreviewPaneProps) {
  const {
    header, filePath, codeLines, meta, desc, states, payloadFields, diff, glossaryPills, rule, transition, commitFiles, note,
  } = model;

  return (
    <div class="pv">
      <PreviewHead {...header} />

      {filePath && (
        <div class="pv-file">
          <FileIcon />
          {filePath}
        </div>
      )}

      {desc && <div class="pv-desc">{desc}</div>}

      {codeLines && codeLines.length > 0 && (
        <pre class="pv-code-block">
          <code>
            {codeLines.map((line, i) => (
              <Fragment key={i}>
                {i > 0 && '\n'}
                {line}
              </Fragment>
            ))}
          </code>
        </pre>
      )}

      {diff && diff.length > 0 && (
        <pre class="pv-code-block pv-diff">
          <code>
            {diff.map((d, i) => (
              <span key={i} class={`dl dl-${d.sign === '+' ? 'add' : d.sign === '-' ? 'del' : 'ctx'}`}>
                {d.text}
                {'\n'}
              </span>
            ))}
          </code>
        </pre>
      )}

      {rule && (
        <pre class="pv-code-block">
          <code>
            <span class="k">{rule.kind}</span> {rule.expr}
            {rule.message ? <span class="s"> {rule.message}</span> : null}
          </code>
        </pre>
      )}

      {transition && (
        <div class="pv-transition">
          <div class="pv-states big">
            <span class="pv-state on">{transition.from}</span>
            <span class="pv-arrow" aria-hidden="true">→</span>
            <span class="pv-state on">{transition.to}</span>
          </div>
          {(transition.guard || transition.via) && (
            <p class="pv-transition-meta">
              {transition.guard && (
                <span class="pv-transition-part">
                  when <code>{transition.guard}</code>
                </span>
              )}
              {transition.via && (
                <span class="pv-transition-part">
                  via <code>{transition.via}()</code>
                </span>
              )}
            </p>
          )}
        </div>
      )}

      {meta && meta.length > 0 && (
        <div class="pv-grid">
          {meta.map(([k, v], i) => (
            <Fragment key={i}>
              <div class="pv-k">{k}</div>
              <div class="pv-v">{v}</div>
            </Fragment>
          ))}
        </div>
      )}

      {states && states.length > 0 && (
        <>
          <div class="pv-section">State machine</div>
          <div class="pv-states">
            {states.map((s, i) => (
              <Fragment key={i}>
                <span class="pv-state">{s}</span>
                {i < states.length - 1 && <span class="pv-arrow">→</span>}
              </Fragment>
            ))}
          </div>
        </>
      )}

      {payloadFields && payloadFields.length > 0 && (
        <>
          <div class="pv-section">Payload</div>
          <div class="pv-fields">
            {payloadFields.map(([n, t], i) => (
              <div class="pv-field" key={i}>
                <span class="pr">{n}</span>
                <span class="pf-t">{t}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {glossaryPills && glossaryPills.length > 0 && (
        <>
          <div class="pv-section">Appears in</div>
          <div class="pv-pills">
            {glossaryPills.map((p, i) => (
              <span class="pv-pill" key={i}>{p}</span>
            ))}
          </div>
        </>
      )}

      {commitFiles && commitFiles.length > 0 && (
        <>
          <div class="pv-section">Files changed</div>
          <div class="pv-files">
            {commitFiles.map((f, i) => (
              <div class="pv-frow" key={i}>
                <span class={`sc-glyph ${f.status === 'M' ? 'modified' : f.status === 'A' ? 'added' : 'deleted'}`}>
                  {f.status}
                </span>
                <span class="pv-fpath">{f.path}</span>
                {f.stat && <span class="pv-fn">{f.stat}</span>}
              </div>
            ))}
          </div>
        </>
      )}

      {note && (
        <div class="pv-note">
          <NoteIcon />
          {note}
        </div>
      )}
    </div>
  );
}
