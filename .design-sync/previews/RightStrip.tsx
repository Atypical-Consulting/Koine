// OWNED preview for RightStrip (no @ds-preview marker — owned files win over the generated twin).
//
// RightStrip is a slim VERTICAL icon stripe; its story (layout: 'centered') renders it inside the real
// `#right-strip` toolbar shell (a narrow flex-column). Without that shell the full-width ThemeSurface
// stretches the stripe into a wide horizontal bar. This owned preview replicates the story's decorator
// so the stripe reads as the intended Rider-style vertical toolbar. RightStrip is prop-less and its icons
// are internal, so no fixtures are needed. Mirrors src/components/RightStrip.stories.tsx.
//
// RightStrip emits a decorative `.rstrip-sep` hairline before the Source Control button (#1154) to group
// the git tool-window; the separator is part of the component, so it appears here automatically. If a
// future claude.ai/design re-sync of RightStrip regenerates the twin, the separator must survive it.
import { RightStrip } from '@atypical/koine-ui';

/** The stripe with all three tool-window toggles (Properties · AI Chat · Source Control). */
export const Default = () => (
  <div style={{ display: 'flex', gap: '8px' }}>
    <aside id="right" aria-label="Properties" style={{ width: '1px' }} />
    <div id="right-strip" role="toolbar" aria-label="Tool windows" aria-orientation="vertical"
      style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <RightStrip />
    </div>
  </div>
);
