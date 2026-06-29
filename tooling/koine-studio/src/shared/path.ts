// The one trailing-segment helper shared by Studio's path/uri labels — the Review panel's per-file
// header (review/ReviewPanel.tsx), the workspace's folder/file names (host/tauri.ts,
// shell/workspaceController.ts) and the editor's uri/token labels (shell/ide.tsx). Each had its own
// near-copy; they agree on every real input (a file path or a `file://` uri) and only ever differed on
// inputs that never occur — a token with a trailing separator, or one that is all separators — so this
// canonical form (strip trailing separators, then the last non-empty segment) is a deliberate tightening
// of those edges, not a behaviour change. A Studio-only VIEW concern; never touches the semantic model. (#480)

/**
 * The trailing path/uri segment of `pathOrUri` for display — e.g. `a/b/billing.koi` ⇒ `billing.koi`,
 * `C:\\Users\\me\\model.koi` ⇒ `model.koi`. Trailing `/`/`\` are stripped first, then the value is split
 * on either separator and the last non-empty segment returned; when there is none (empty / all
 * separators) the original string is returned unchanged.
 */
export function basename(pathOrUri: string): string {
  const seg = pathOrUri.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  return seg && seg.length > 0 ? seg : pathOrUri;
}
