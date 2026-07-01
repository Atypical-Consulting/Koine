// Mounts a story's primary story with Preact — the same render Storybook produces, so the preview card
// is faithful by construction. Used only by the preview-card bundles (never ships in _ds_bundle.js).
import { render, h } from 'preact';

export function mountStoryPreact(mod, storyName) {
  const meta = mod.default || {};
  const story = mod[storyName] || {};
  const args = { ...(meta.args || {}), ...(story.args || {}) };
  const renderFn = story.render || meta.render;
  const vnode = renderFn ? renderFn(args, { args }) : h(meta.component, args);
  render(vnode, document.getElementById('root'));
}
