import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  sanitizeProjectName,
  defaultProjectName,
  isValidProjectName,
  synthesizeCsproj,
  buildProjectZip,
  canGenerate,
} from '@/generateProject';

describe('sanitizeProjectName', () => {
  it('keeps a valid dotted identifier unchanged', () => {
    expect(sanitizeProjectName('Acme.Billing')).toBe('Acme.Billing');
  });
  it('replaces invalid characters with underscores', () => {
    expect(sanitizeProjectName('my project!')).toBe('my_project_');
  });
  it('prefixes an underscore when the name starts with a digit', () => {
    expect(sanitizeProjectName('1app')).toBe('_1app');
  });
  it('falls back to KoineProject when blank', () => {
    expect(sanitizeProjectName('   ')).toBe('KoineProject');
  });
});

describe('isValidProjectName', () => {
  it('accepts identifiers and dotted namespaces', () => {
    expect(isValidProjectName('Shop')).toBe(true);
    expect(isValidProjectName('Acme.Billing._v2')).toBe(true);
  });
  it('rejects empty, leading-digit, and space-containing names', () => {
    expect(isValidProjectName('')).toBe(false);
    expect(isValidProjectName('1bad')).toBe(false);
    expect(isValidProjectName('has space')).toBe(false);
  });
});

describe('defaultProjectName', () => {
  it('uses the first segment of the first namespaced path', () => {
    expect(defaultProjectName([{ path: 'Billing/Orders/Order.cs', contents: '' }])).toBe('Billing');
  });
  it('sanitizes a segment that is not a valid identifier', () => {
    expect(defaultProjectName([{ path: 'my ctx/Order.cs', contents: '' }])).toBe('my_ctx');
  });
  it('skips top-level files (e.g. a TS emitter runtime.ts) and uses the first namespaced path', () => {
    expect(
      defaultProjectName([
        { path: 'runtime.ts', contents: '' },
        { path: 'tsconfig.json', contents: '' },
        { path: 'Billing/Order.ts', contents: '' },
      ]),
    ).toBe('Billing');
  });
  it('falls back to KoineProject when nothing is namespaced', () => {
    expect(defaultProjectName([{ path: 'runtime.ts', contents: '' }])).toBe('KoineProject');
    expect(defaultProjectName([])).toBe('KoineProject');
  });
});

describe('synthesizeCsproj', () => {
  it('emits an SDK-style net10.0 project at <name>/<name>.csproj', () => {
    const { path, contents } = synthesizeCsproj('Acme.Billing');
    expect(path).toBe('Acme.Billing/Acme.Billing.csproj');
    expect(contents).toContain('<Project Sdk="Microsoft.NET.Sdk">');
    expect(contents).toContain('<TargetFramework>net10.0</TargetFramework>');
    expect(contents).toContain('<Nullable>enable</Nullable>');
    expect(contents).toContain('<ImplicitUsings>enable</ImplicitUsings>');
    expect(contents).toContain('<LangVersion>latest</LangVersion>');
  });
});

describe('buildProjectZip', () => {
  const files = [
    { path: 'Billing/Orders/Order.cs', contents: '// order' },
    { path: 'Billing/Money.cs', contents: '// money' },
  ];

  it('prefixes every emitted file with the project name', async () => {
    const bytes = await buildProjectZip(files, { projectName: 'Shop', includeCsproj: false });
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('Shop/Billing/Orders/Order.cs')).not.toBeNull();
    expect(await zip.file('Shop/Billing/Money.cs')!.async('string')).toBe('// money');
  });

  it('adds the csproj only when requested', async () => {
    const without = await JSZip.loadAsync(await buildProjectZip(files, { projectName: 'Shop', includeCsproj: false }));
    expect(without.file('Shop/Shop.csproj')).toBeNull();
    const withCsproj = await JSZip.loadAsync(await buildProjectZip(files, { projectName: 'Shop', includeCsproj: true }));
    expect(withCsproj.file('Shop/Shop.csproj')).not.toBeNull();
  });

  it('adds glossary.md when a non-empty glossary is supplied', async () => {
    const bytes = await buildProjectZip(files, { projectName: 'Shop', includeCsproj: false, glossary: '# Glossary' });
    const zip = await JSZip.loadAsync(bytes);
    expect(await zip.file('Shop/glossary.md')!.async('string')).toBe('# Glossary');
  });

  it('omits glossary.md for an empty/whitespace glossary', async () => {
    const zip = await JSZip.loadAsync(await buildProjectZip(files, { projectName: 'Shop', includeCsproj: false, glossary: '   ' }));
    expect(zip.file('Shop/glossary.md')).toBeNull();
  });

  it('rejects path-traversal entries', async () => {
    await expect(
      buildProjectZip([{ path: '../evil.cs', contents: 'x' }], { projectName: 'Shop', includeCsproj: false }),
    ).rejects.toThrow();
  });
});

describe('canGenerate', () => {
  const ok = { files: [{ path: 'A/x.cs', contents: '' }], error: null };
  it('allows a clean model with a valid name', () => {
    expect(canGenerate(ok, 'Shop')).toBe(true);
  });
  it('blocks when emit reported an error', () => {
    expect(canGenerate({ ...ok, error: 'boom' }, 'Shop')).toBe(false);
  });
  it('blocks when nothing was emitted', () => {
    expect(canGenerate({ files: [], error: null }, 'Shop')).toBe(false);
  });
  it('blocks on an invalid project name', () => {
    expect(canGenerate(ok, '1bad')).toBe(false);
  });
});
