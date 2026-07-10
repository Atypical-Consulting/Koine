import { describe, expect, test } from 'vitest';
import type { EmitFile } from '@/lsp/protocol';
import { buildFileTree } from '@/shell/output/fileTree';

function emitFile(path: string, contents = `// ${path}`): EmitFile {
  return { path, contents };
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
              },
            ],
          },
          {
            kind: 'file',
            name: 'Order.cs',
            path: 'Billing/Order.cs',
            contents: '// Billing/Order.cs',
          },
        ],
      },
      {
        kind: 'file',
        name: 'Program.cs',
        path: 'Program.cs',
        contents: '// Program.cs',
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
      },
    ]);
  });

  test('empty input produces an empty tree', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});
