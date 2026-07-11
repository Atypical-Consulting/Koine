import { describe, expect, test } from 'vitest';
import type { EmitFile } from '@/lsp/protocol';
import { buildFileTree } from '@/shell/output/fileTree';

function emitFile(path: string, contents = `// ${path}`, kind?: string | null): EmitFile {
  return { path, contents, kind };
}

describe('buildFileTree', () => {
  test('nests files under folder nodes, folders sorted before files, alphabetical within a level', () => {
    const files: EmitFile[] = [
      emitFile('Billing/ValueObjects/Money.cs'),
      emitFile('Billing/Order.cs'),
      emitFile('Program.cs'),
    ];

    const tree = buildFileTree(files);

    expect(tree).toEqual([
      {
        kind: 'folder',
        name: 'Billing',
        path: 'Billing',
        children: [
          {
            kind: 'folder',
            name: 'ValueObjects',
            path: 'Billing/ValueObjects',
            children: [
              {
                kind: 'file',
                name: 'Money.cs',
                path: 'Billing/ValueObjects/Money.cs',
                contents: '// Billing/ValueObjects/Money.cs',
                dddKind: null,
                loc: 1,
              },
            ],
          },
          {
            kind: 'file',
            name: 'Order.cs',
            path: 'Billing/Order.cs',
            contents: '// Billing/Order.cs',
            dddKind: null,
            loc: 1,
          },
        ],
      },
      {
        kind: 'file',
        name: 'Program.cs',
        path: 'Program.cs',
        contents: '// Program.cs',
        dddKind: null,
        loc: 1,
      },
    ]);
  });

  test('a single root-level file produces a single file node', () => {
    const files: EmitFile[] = [emitFile('Program.cs')];

    const tree = buildFileTree(files);

    expect(tree).toEqual([
      {
        kind: 'file',
        name: 'Program.cs',
        path: 'Program.cs',
        contents: '// Program.cs',
        dddKind: null,
        loc: 1,
      },
    ]);
  });

  test('empty input produces an empty tree', () => {
    expect(buildFileTree([])).toEqual([]);
  });

  test('a file node carries its EmitFile.kind as dddKind, and loc as its derived line count', () => {
    const files: EmitFile[] = [emitFile('Order.cs', 'line1\nline2\nline3', 'aggregate')];

    const tree = buildFileTree(files);

    expect(tree).toEqual([
      {
        kind: 'file',
        name: 'Order.cs',
        path: 'Order.cs',
        contents: 'line1\nline2\nline3',
        dddKind: 'aggregate',
        loc: 3,
      },
    ]);
  });

  test('a file with no kind and empty contents produces dddKind: null and loc: 0', () => {
    const files: EmitFile[] = [emitFile('Empty.cs', '')];

    const tree = buildFileTree(files);

    expect(tree).toEqual([
      {
        kind: 'file',
        name: 'Empty.cs',
        path: 'Empty.cs',
        contents: '',
        dddKind: null,
        loc: 0,
      },
    ]);
  });
});
