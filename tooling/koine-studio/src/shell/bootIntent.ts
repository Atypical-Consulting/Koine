import type { Template } from '@/welcome/templates';

// A one-shot "what the user picked on Home" hand-off. Home and the editor are distinct routes (#368),
// so a Home action can't call the IDE directly — the IDE isn't mounted yet. Instead the Home action
// queues its intent here and navigates to the editor; the IDE consumes it once, at boot, and performs
// the real action (new model / open folder / open recent / open template). Without an intent the editor
// boots its default workspace, exactly as a cold `#/editor` deep link does.

export type StartIntent =
  | { kind: 'new' }
  | { kind: 'open-folder' }
  | { kind: 'open-recent'; path: string }
  | { kind: 'open-example'; template: Template };

let pending: StartIntent | null = null;

/** Queue the action the editor should perform on its next boot. The last write wins. */
export function setStartIntent(intent: StartIntent): void {
  pending = intent;
}

/** Read-and-clear the queued intent (null if none). One-shot: a second call returns null. */
export function takeStartIntent(): StartIntent | null {
  const intent = pending;
  pending = null;
  return intent;
}

/** Read the queued intent WITHOUT clearing it (null if none) — for naming a target on a boot failure. */
export function peekStartIntent(): StartIntent | null {
  return pending;
}
