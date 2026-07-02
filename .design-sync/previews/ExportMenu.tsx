// OWNED preview for ExportMenu (no @ds-preview marker — owned files win over the generated twin).
//
// ExportMenu is a compact `<details>` disclosure (story layout: 'centered'). The full-width ThemeSurface
// stretched its container so the pop-up menu (`.koi-export-menu { right: 0 }`) right-anchored across the
// whole card instead of dropping under the button. Wrapping it in a content-width (inline-block) box
// restores the compact toolbar button with the menu directly beneath it, matching the storybook render.
// Mirrors src/components/ExportMenu.stories.tsx.
import { ExportMenu } from '@atypical/koine-ui';

const noop = () => {};
const box = (child: any) => <div style={{ display: 'inline-block' }}>{child}</div>;

/** The compact toolbar default — the disclosure summary only, menu collapsed. */
export const Closed = () => box(<ExportMenu onExport={noop} onCopyMermaid={noop} />);

/** The menu popped open, showing the SVG / PNG / PlantUML / Copy Mermaid items. */
export const Open = () => box(<ExportMenu defaultOpen onExport={noop} onCopyMermaid={noop} />);
