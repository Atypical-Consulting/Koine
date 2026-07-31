// Shared WCAG 2.1 relative-luminance / contrast-ratio math (issue #1267). Previously hand-copied
// across tokens.test.ts (this package), koine-studio's gen-concept-colors.mjs, and
// conceptColors.test.ts — this is the single source those three now import instead of re-deriving
// the formula.

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [r, g, b];
}

export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [rl, gl, bl] = [r, g, b].map((c) => {
    const srgb = c / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hexToRgb(hex1));
  const l2 = relativeLuminance(hexToRgb(hex2));
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Convenience wrapper for the common "contrast against pure white" check. */
export function contrastOnWhite(hex: string): number {
  return contrastRatio(hex, '#ffffff');
}
