import type { ComponentChildren } from 'preact';

// A thin Preact host for the right-rail AI Chat (`#view-assistant`) — the #759 migration's declarative
// owner of the assistant's content node, replacing the raw imperative write into the static section.
//
// The assistant panel itself (`src/ai/aiPanel.ts`) STAYS imperative: it owns a large transcript /
// change-set DOM and lazily imports the Anthropic SDK, so — like CodeMirror and maxGraph — it is an
// imperative-by-design island. This component does NOT re-render its internals; it renders the single
// mount node once and the host (`panelHost.ensureAssistant`) attaches the imperative panel into it via
// `createAssistantPanel({ container })`. `createAssistantPanel` adds its own `koi-assistant` class
// (`height: 100%; display: flex; flex-direction: column`) to that node, so the mount node becomes the
// flex column that fills the absolutely-positioned `.rview` section exactly as the section did before —
// no layout change. Because the node is rendered once and never re-rendered, Preact and the imperative
// panel never contend for it.
//
// `ensureAssistant()` must return the panel synchronously and idempotently (the inspector controller and
// the command palette use the return immediately), and Preact does not flush effects synchronously
// within `render()`, so creation stays in the host: it renders this view, then synchronously queries the
// mount node and builds the panel. Visibility (the section's `hidden`) stays controller-owned, so this
// host does not subscribe to the store (the assistant has no store slice yet).

/** The class on the mount node the host queries to attach the imperative assistant panel. */
export const ASSISTANT_MOUNT_CLASS = 'koi-assistant-mount';

export function AssistantView(props: {
  /** Optional content for stories/tests to render inside the mount node (representative transcript
   *  markup). Production renders it empty and lets `createAssistantPanel` populate the node. */
  children?: ComponentChildren;
}) {
  return <div class={ASSISTANT_MOUNT_CLASS}>{props.children}</div>;
}
