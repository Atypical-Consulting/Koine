// Generates website/src/generated/downloads.json — the manifest that drives the homepage's
// Downloads section (issue #1909).
//
// The manifest is built from the GitHub Releases API's ACTUAL asset list, not from templated
// filenames, for two reasons:
//
//   1. The release-window race. Merging the release-please PR tags vX.Y.Z and fires BOTH the docs
//      deploy (Directory.Build.props is in its paths trigger) and the release asset matrices — but
//      the Tauri legs take ~45 minutes to upload their installers. A manifest templated from
//      <Version> would advertise a .dmg URL that 404s for that whole window. Listing only assets
//      that were observed on the release makes that impossible.
//   2. Koine stamps its assets THREE different ways, and a fourth would appear silently the day a
//      bundler changes its naming:
//        koine-v0.251.0-osx-arm64.tar.gz     tag form, with `v`, dash-separated
//        Koine.Studio_0.251.0_aarch64.dmg    version form, no `v`, underscore-separated
//        Koine.Studio-0.251.0-1.x86_64.rpm   version form, dash-separated, extra `-1` field
//      Matching real names means a rename leaves a slot unfilled and WARNS, rather than emitting a
//      confidently wrong URL.
//
// No network is not an error: a failed fetch (offline `npm run dev`, a fork with no token, an API
// outage) falls back to a `verified: false` manifest carrying no asset URLs at all, and the
// Downloads component degrades to the releases-page link. A tool that cannot establish freshness
// says so rather than serving something it can't vouch for.
//
// Run via `npm run build:downloads`; invoked automatically by predev/prebuild alongside the other
// build:* steps. Output is git-ignored and regenerated on every build — never hand-edit it.
//
// No deps beyond Node's stdlib.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'Atypical-Consulting/Koine';

/** Platform slots, in the order they are rendered. */
const PLATFORMS = [
  { id: 'macos-arm64', label: 'macOS', arch: 'Apple Silicon' },
  { id: 'windows-x64', label: 'Windows', arch: 'x64' },
  { id: 'linux-x64', label: 'Linux', arch: 'x64' },
];

// Ordered match table. `rank` breaks ties when one platform+slot has several candidates: the
// lowest rank wins, so Windows offers the NSIS .exe over the .msi and Linux offers the portable
// .AppImage over the distro packages. Anchored to the end of the name so a near-miss
// ("…_arm64-setup.exe.blorp") falls through to null instead of being force-fitted into a slot.
const RULES = [
  { re: /_aarch64\.dmg$/, platform: 'macos-arm64', slot: 'app', kind: 'dmg', rank: 0 },
  { re: /-osx-arm64\.tar\.gz$/, platform: 'macos-arm64', slot: 'cli', kind: 'tar.gz', rank: 0 },

  { re: /_x64-setup\.exe$/, platform: 'windows-x64', slot: 'app', kind: 'exe', rank: 0 },
  { re: /_x64_en-US\.msi$/, platform: 'windows-x64', slot: 'app', kind: 'msi', rank: 1 },
  { re: /-win-x64\.zip$/, platform: 'windows-x64', slot: 'cli', kind: 'zip', rank: 0 },

  { re: /_amd64\.AppImage$/, platform: 'linux-x64', slot: 'app', kind: 'AppImage', rank: 0 },
  { re: /_amd64\.deb$/, platform: 'linux-x64', slot: 'app', kind: 'deb', rank: 1 },
  { re: /\.x86_64\.rpm$/, platform: 'linux-x64', slot: 'app', kind: 'rpm', rank: 2 },
  { re: /-linux-x64\.tar\.gz$/, platform: 'linux-x64', slot: 'cli', kind: 'tar.gz', rank: 0 },
];

/**
 * The NuGet packages are deliberately not a download slot — the `dotnet tool install` line in the
 * Downloads component covers them, and listing 16 .nupkg files would bury the binaries.
 */
const IGNORED = /\.nupkg$/;

/** The full matching rule for an asset name, or null. Internal: `rank` is not part of the API. */
function matchRule(name) {
  return RULES.find((r) => r.re.test(name)) ?? null;
}

/**
 * Classify a release asset filename into its platform download slot.
 *
 * @param {string} name e.g. 'Koine.Studio_0.251.0_aarch64.dmg'
 * @returns {{platform: string, slot: 'app'|'cli', kind: string}|null} null when the asset is
 *   ignored (.nupkg) or unrecognised — callers warn on the latter rather than guessing.
 */
export function classifyAsset(name) {
  if (IGNORED.test(name)) return null;
  const rule = matchRule(name);
  return rule ? { platform: rule.platform, slot: rule.slot, kind: rule.kind } : null;
}

/**
 * Build the download manifest from a release's real asset list.
 *
 * A platform with neither an app nor a cli asset is omitted entirely — that is the race-proofing:
 * an installer still uploading simply isn't offered, instead of being linked and 404ing.
 *
 * @param {{tag: string, assets: Array<{name: string, browser_download_url?: string, size?: number}>}} release
 */
export function buildManifest({ tag, assets }) {
  /** @type {Record<string, Record<string, {rank: number, entry: object}>>} */
  const best = {};

  for (const asset of assets) {
    if (IGNORED.test(asset.name)) continue;
    const rule = matchRule(asset.name);
    if (!rule) continue;

    const slots = (best[rule.platform] ??= {});
    const incumbent = slots[rule.slot];
    if (incumbent && incumbent.rank <= rule.rank) continue;

    slots[rule.slot] = {
      rank: rule.rank,
      entry: {
        kind: rule.kind,
        name: asset.name,
        url: asset.browser_download_url ?? '',
        size: asset.size ?? 0,
      },
    };
  }

  const platforms = PLATFORMS.filter((p) => best[p.id]).map((p) => ({
    id: p.id,
    label: p.label,
    arch: p.arch,
    app: best[p.id].app?.entry ?? null,
    cli: best[p.id].cli?.entry ?? null,
  }));

  return {
    version: tag.replace(/^v/, ''),
    tag,
    verified: true,
    releaseUrl: `https://github.com/${REPO}/releases/tag/${tag}`,
    platforms,
  };
}

/**
 * The manifest used when the release could not be read (offline, no token on a fork, API outage).
 *
 * It carries NO asset URLs and is never `verified` — the component renders only the releases-page
 * link and the `dotnet tool` line, both of which are correct unconditionally. The version is still
 * reported (from Directory.Build.props) so the page can name a version rather than nothing, but it
 * is deliberately not used to synthesise download links: an unverified URL is worse than no URL.
 *
 * @param {string} version e.g. '0.251.0'
 */
export function fallbackManifest(version) {
  return {
    version,
    tag: `v${version}`,
    verified: false,
    releaseUrl: `https://github.com/${REPO}/releases/latest`,
    platforms: [],
  };
}

// ---------------------------------------------------------------------------
// Generator (side-effecting). Guarded below so importing this module — which the
// unit tests do — never fetches anything.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolve(here, '..');
const repoRoot = resolve(websiteRoot, '..');
const outPath = resolve(websiteRoot, 'src', 'generated', 'downloads.json');

/** The in-development version, used only as the fallback's label. */
function versionFromProps() {
  try {
    const props = readFileSync(resolve(repoRoot, 'Directory.Build.props'), 'utf8');
    return props.match(/<Version>([^<]+)<\/Version>/)?.[1]?.trim() ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Fetch the latest release, or null if it can't be read for any reason. */
async function fetchLatestRelease() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'koine-website-build',
  };
  // In CI GITHUB_TOKEN lifts the rate limit from 60/h/IP to 1000/h/repo. Locally its absence is
  // fine — this is one request per build.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`build-downloads: GitHub API returned ${res.status} ${res.statusText}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`build-downloads: could not reach the GitHub API (${err.message})`);
    return null;
  }
}

async function main() {
  const release = await fetchLatestRelease();
  let manifest;

  if (release?.tag_name) {
    const assets = release.assets ?? [];
    // Name every asset we could not place. A silently-unfilled slot is exactly the failure this
    // generator exists to prevent, so a bundler rename must be loud rather than just absent.
    for (const asset of assets) {
      if (!asset.name.endsWith('.nupkg') && classifyAsset(asset.name) === null) {
        console.warn(`build-downloads: unrecognised asset "${asset.name}" — no download slot`);
      }
    }
    manifest = buildManifest({ tag: release.tag_name, assets });
    console.log(
      `build-downloads: ${manifest.tag} — ${manifest.platforms.length} platform(s): ` +
        manifest.platforms.map((p) => p.id).join(', '),
    );
  } else {
    manifest = fallbackManifest(versionFromProps());
    console.warn(
      'build-downloads: falling back to an UNVERIFIED manifest — the Downloads section will link ' +
        'to the releases page instead of individual assets.',
    );
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`build-downloads: wrote ${outPath}`);
}

// Run-directly check: `node scripts/build-downloads.mjs` executes main(); `import`ing the module
// (the unit tests) does not. Mirrors scripts/smoke-boot.mjs.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
