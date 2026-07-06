// domIds — the single source of truth for the DOM ids, data-attributes and class names that tie
// @atypical/koine-ui's rendered markup to Koine Studio's imperative lookups. Two sides share this
// contract and must stay in lockstep:
//   • create side (this package): LeftRail.tsx / RightStrip.tsx render these ids/attrs into the DOM.
//   • query side (koine-studio):  ide.tsx / inspectorController.tsx / layout.ts capture the same
//     nodes after mount (getElementById / querySelectorAll) and wire their behaviour.
// Both sides import from here so a rename is one edit, not a hunt for duplicated string literals, and
// domIds.test.tsx pins each value to the literal both sides render/query today.

export const LEFT_RAIL_IDS = {
  axisSwitch: 'rail-axis-switch',
  collapse: 'rail-collapse',
  domainPane: 'rail-domain-pane',
  filesPane: 'rail-files',
  filetreeTitle: 'filetree-title',
  filetreeBody: 'filetree-body',
  leftStrip: 'left-strip',
} as const;

export const DATA_AXIS = 'data-axis';
export const DATA_LAXIS = 'data-laxis';
export const DATA_LEXPAND = 'data-lexpand';
export const RSTRIP_BTN_CLASS = 'rstrip-btn';
// The decorative hairline that groups the git tool-window (Source Control) apart from Properties/AI Chat
// on the right-edge stripe (#1154). RightStrip.tsx renders it; its CSS lives Studio-side in
// _inspector.scss (koine-ui ships no SCSS). Not imperatively queried by the controller — kept here only
// to hold the cross-package class literal in one place, mirroring RSTRIP_BTN_CLASS.
export const RSTRIP_SEP_CLASS = 'rstrip-sep';
export const DATA_RVIEW = 'data-rview';

export const RIGHT_STRIP_VIEWS = ['props', 'assistant', 'source-control', 'syntax-tree'] as const;
export type RightStripView = (typeof RIGHT_STRIP_VIEWS)[number];

export const byId = (id: string): string => `#${id}`;
export const axisButtonsSelector = `#${LEFT_RAIL_IDS.axisSwitch} [${DATA_AXIS}]`;
export const lstripAxisButtonsSelector = `#${LEFT_RAIL_IDS.leftStrip} [${DATA_LAXIS}]`;
