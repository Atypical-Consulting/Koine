import type { ComponentChildren } from 'preact';

// A thin Preact host for a right-rail AI Chat panel — Koine Studio's #759 migration's declarative owner
// of the assistant's content node, replacing a raw imperative write into a static section. Moved here
// verbatim (issue #905, Task 4).
//
// The assistant panel's actual content stays the consuming app's responsibility: it owns a large
// transcript / change-set DOM and typically lazily imports an LLM SDK, so — like CodeMirror and maxGraph
// in Koine Studio — it is an imperative-by-design island best left outside this component. This component
// does NOT re-render its internals; it renders the single mount node once, and the host attaches its
// imperative panel into it. Because the node is rendered once and never re-rendered, Preact and the
// imperative panel never contend for it.
//
// Koine Studio's host (`ensureAssistant()`) must return the panel synchronously and idempotently, and
// Preact does not flush effects synchronously within `render()`, so creation stays in the host: it
// renders this view, then synchronously queries the mount node and builds the panel. Visibility stays
// host-owned, so this component does not take a store/visibility prop.

/** The class on the mount node a host queries to attach its imperative assistant panel. */
export const ASSISTANT_MOUNT_CLASS = 'koi-assistant-mount';

export function AssistantView(props: {
  /** Optional content for stories/tests to render inside the mount node (representative transcript
   *  markup). Production usually renders it empty and lets the host populate the node. */
  children?: ComponentChildren;
}) {
  return <div class={ASSISTANT_MOUNT_CLASS}>{props.children}</div>;
}
