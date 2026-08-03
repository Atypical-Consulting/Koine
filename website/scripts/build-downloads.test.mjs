/**
 * Unit tests for the release-downloads manifest generator (issue #1909).
 *
 * The generator's network half (fetch the latest release) is untestable without a token and a live
 * API, so the parts that decide what gets *linked* are split out as pure functions and tested here
 * with real asset-name fixtures. Same shape as `classifyBootOutcome` in scripts/smoke-boot.mjs:
 * importing build-downloads.mjs is side-effect-free (main() is guarded behind a run-directly check),
 * so this import never touches the network.
 *
 * Run:  npx vitest run scripts/build-downloads.test.mjs   (or just: npm test)
 */
import { describe, test, expect } from 'vitest';
import { classifyAsset, buildManifest } from './build-downloads.mjs';

// The REAL v0.251.0 asset list. All three of Koine's stamping conventions appear here — the CLI's
// tag form (`koine-v0.251.0-…`), the Tauri bundler's version form (`Koine.Studio_0.251.0_…`), and
// the rpm's third form (`Koine.Studio-0.251.0-1.x86_64.rpm`) — which is exactly why classification
// matches on real names instead of templating them from a version string.
const V251 = [
  'koine-v0.251.0-linux-x64.tar.gz',
  'koine-v0.251.0-osx-arm64.tar.gz',
  'koine-v0.251.0-win-x64.zip',
  'Koine.Cli.0.251.0.nupkg',
  'Koine.Studio_0.251.0_aarch64.dmg',
  'Koine.Studio_0.251.0_x64-setup.exe',
  'Koine.Studio_0.251.0_x64_en-US.msi',
  'Koine.Studio_0.251.0_amd64.AppImage',
  'Koine.Studio_0.251.0_amd64.deb',
  'Koine.Studio-0.251.0-1.x86_64.rpm',
].map((name) => ({ name, browser_download_url: `https://example/${name}`, size: 1024 }));

describe('classifyAsset', () => {
  test('routes the macOS aarch64 dmg to the macos-arm64 app slot', () => {
    expect(classifyAsset('Koine.Studio_0.251.0_aarch64.dmg')).toEqual({
      platform: 'macos-arm64',
      slot: 'app',
      kind: 'dmg',
    });
  });

  test('routes the osx-arm64 tarball to the macos-arm64 cli slot', () => {
    expect(classifyAsset('koine-v0.251.0-osx-arm64.tar.gz')).toEqual({
      platform: 'macos-arm64',
      slot: 'cli',
      kind: 'tar.gz',
    });
  });

  test('ignores nupkgs', () => {
    expect(classifyAsset('Koine.Cli.0.251.0.nupkg')).toBeNull();
  });

  test('returns null for an unrecognised name rather than throwing', () => {
    expect(classifyAsset('Koine.Studio_0.251.0_arm64-setup.exe.blorp')).toBeNull();
  });
});

describe('buildManifest', () => {
  test('a full release yields three platforms, each with app + cli', () => {
    const m = buildManifest({ tag: 'v0.251.0', assets: V251 });
    expect(m.verified).toBe(true);
    expect(m.version).toBe('0.251.0');
    expect(m.platforms.map((p) => p.id)).toEqual(['macos-arm64', 'windows-x64', 'linux-x64']);
    expect(m.platforms[0].app.name).toBe('Koine.Studio_0.251.0_aarch64.dmg');
  });

  // The v0.251.0 mid-flight state: the tag fired, linux-x64 uploaded, the mac/windows matrix legs
  // are still running ~45 min behind. Advertising a dmg here would 404 — hence the omission.
  test('a partial release omits the platforms whose assets have not uploaded yet', () => {
    const partial = V251.filter((a) => a.name === 'koine-v0.251.0-linux-x64.tar.gz');
    const m = buildManifest({ tag: 'v0.251.0', assets: partial });
    expect(m.platforms.map((p) => p.id)).toEqual(['linux-x64']);
    expect(m.platforms[0].app).toBeNull();
  });

  test('no assets at all still yields a usable, unverified manifest', () => {
    const m = buildManifest({ tag: 'v0.251.0', assets: [] });
    expect(m.platforms).toEqual([]);
    expect(m.releaseUrl).toContain('v0.251.0');
  });
});
