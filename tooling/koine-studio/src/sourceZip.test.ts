import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildSourceZip } from '@/sourceZip';

describe('buildSourceZip', () => {
  it('bundles every .koi file under a single root folder, preserving relative paths', async () => {
    const bytes = await buildSourceZip(
      [
        { relPath: 'a/x.koi', text: '// x' },
        { relPath: 'y.koi', text: '// y' },
      ],
      { root: 'Demo' },
    );
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('Demo/a/x.koi')).not.toBeNull();
    expect(zip.file('Demo/y.koi')).not.toBeNull();
    expect(await zip.file('Demo/a/x.koi')!.async('string')).toBe('// x');
    expect(await zip.file('Demo/y.koi')!.async('string')).toBe('// y');
  });

  it('rejects a leading `..` traversal segment', async () => {
    await expect(
      buildSourceZip([{ relPath: '../escape.koi', text: 'x' }], { root: 'Demo' }),
    ).rejects.toThrow();
  });

  it('rejects an interior `..` traversal segment', async () => {
    await expect(
      buildSourceZip([{ relPath: 'a/../b.koi', text: 'x' }], { root: 'Demo' }),
    ).rejects.toThrow();
  });

  it('does NOT reject a legitimate name that merely contains `..` as a substring', async () => {
    const bytes = await buildSourceZip([{ relPath: 'My..Context.koi', text: 'x' }], { root: 'Demo' });
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('Demo/My..Context.koi')).not.toBeNull();
  });
});
