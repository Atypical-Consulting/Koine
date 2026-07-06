import type { ComponentChildren } from 'preact';

// A thin Preact host for a right-rail AI Chat panel — Koine Studio's #759 migration's declarative owner
// of the assistant's content node, replacing a raw imperative write into a static section. Moved here
// verbatim (issue #905, Task 4).
//
// The assistant panel's actual content stays the consuming app's responsibility. Since #990, Koine
// Studio mounts its own Preact `AssistantChat` (rendered over the store's chat slice) into this node —
// the old imperative transcript/change-set DOM is retired. This component still renders the single
// mount node once and never re-renders it, so the host's own render root inside it is never contended;
// children were always supported (stories/tests render representative content the same way).
//
// Koine Studio's host (`ensureAssistant()`) must return the panel handle synchronously and idempotently,
// and Preact does not flush effects synchronously within `render()`, so creation stays in the host: it
// renders this view, then synchronously queries the mount node and renders its chat component into it.
// Visibility stays host-owned, so this component does not take a store/visibility prop.

/** The class on the mount node a host queries to attach its imperative assistant panel. */
export const ASSISTANT_MOUNT_CLASS = 'koi-assistant-mount';

export function AssistantView(props: {
  /** Optional content for stories/tests to render inside the mount node (representative transcript
   *  markup). Production usually renders it empty and lets the host populate the node. */
  children?: ComponentChildren;
}) {
  return <div class={ASSISTANT_MOUNT_CLASS}>{props.children}</div>;
}
