// Pure, dependency-free tree-model builder for the "Generated output" panel (#871 task 1): turns
// the flat `EmitFile[]` the compiler returns (each a `/`-joined relative path plus contents) into
// a nested `TreeNode[]` a future DOM/ARIA tree view can render directly. No DOM, no store, no
// host access — just data in, data out — so it is unit-testable in isolation and reusable by
// anything that wants a folder/file tree over emitted output.
import type { EmitFile } from '@/lsp/protocol';

/**
 * One node of a generated-output file tree: a folder (with nested children) or a leaf file (with its
 * emitted contents). A file node also carries `dddKind` — the file's DDD stereotype slug (matches a
 * `--koi-ddd-*` token; `null` for infra/runtime files or targets that don't populate `EmitFile.kind`) —
 * and `loc`, its derived line count (#1361, restoring what the pre-#871 flat rail showed per file).
 * Named `dddKind` rather than `kind` to avoid colliding with this union's own `kind` discriminant
 * ('folder' | 'file').
 */
export type TreeNode =
  | { kind: 'folder'; name: string; path: string; children: TreeNode[] }
  | { kind: 'file'; name: string; path: string; contents: string; dddKind: string | null; loc: number };

/** A folder node under construction: children are keyed by segment name for O(1) merge while walking paths. */
interface FolderBuilder {
  path: string;
  folders: Map<string, FolderBuilder>;
  files: Map<string, { path: string; contents: string; dddKind: string | null; loc: number }>;
}

function newFolder(path: string): FolderBuilder {
  return { path, folders: new Map(), files: new Map() };
}

/** Recursively turn a `FolderBuilder`'s children into sorted `TreeNode[]` — folders before files, alphabetical within each group. */
function toNodes(folder: FolderBuilder): TreeNode[] {
  const folderNodes: TreeNode[] = [...folder.folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, child]) => ({ kind: 'folder', name, path: child.path, children: toNodes(child) }));

  const fileNodes: TreeNode[] = [...folder.files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, file]) => ({
      kind: 'file',
      name,
      path: file.path,
      contents: file.contents,
      dddKind: file.dddKind,
      loc: file.loc,
    }));

  return [...folderNodes, ...fileNodes];
}

/**
 * Build a nested `TreeNode[]` from a flat list of emitted files. Each `EmitFile.path` is split on
 * `/`; every segment but the last becomes (or reuses) a folder node, and the last segment becomes
 * a file node carrying that file's `contents`. Sibling folders sort before sibling files, and each
 * group sorts alphabetically by name — applied at every level, including the root.
 */
export function buildFileTree(files: EmitFile[]): TreeNode[] {
  const root = newFolder('');

  for (const file of files) {
    const segments = file.path.split('/');
    const fileName = segments[segments.length - 1];
    let current = root;

    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      const childPath = current.path ? `${current.path}/${segment}` : segment;
      let child = current.folders.get(segment);
      if (!child) {
        child = newFolder(childPath);
        current.folders.set(segment, child);
      }
      current = child;
    }

    current.files.set(fileName, {
      path: file.path,
      contents: file.contents,
      dddKind: file.kind ?? null,
      loc: file.contents.length ? file.contents.split('\n').length : 0,
    });
  }

  return toNodes(root);
}
