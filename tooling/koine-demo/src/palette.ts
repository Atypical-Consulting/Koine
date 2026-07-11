// Koine brand + editor palette. Concept colors mirror Studio: one DDD concept, one color.
export const P = {
  // surfaces
  bg: "#0b0f17",
  bgDeep: "#06090f",
  panel: "#0f1420",
  panelHead: "#131a28",
  panelBorder: "#222c3d",
  text: "#c9d3e0",
  dim: "#8b97a8",

  // brand
  brand: "#3245b8",
  brandLite: "#6b7ff0",

  // syntax
  keyword: "#ff7b72",
  type: "#79c0ff",
  string: "#a5d6ff",
  number: "#f0b429",
  comment: "#6b7688",
  punct: "#c9d3e0",

  // concept colors (Koine)
  value: "#4aa3ff",
  enumC: "#f0b429",
  aggregate: "#b78cff",
  entity: "#7ee787",
} as const;

export const MONO =
  '"SF Mono", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace';
export const SANS =
  'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// per-target accent used by the emit chip on the right panel
export const TARGET_ACCENT: Record<string, string> = {
  "C#": "#8a63ff",
  TypeScript: "#3aa0ff",
  Python: "#f0b429",
  Rust: "#ff7043",
};
