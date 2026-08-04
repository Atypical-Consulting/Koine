#!/usr/bin/env node
// ESLint resolved-config parity check (#1924).
//
// The two front-end packages (tooling/koine-studio, tooling/koine-ui) share a set of rule DECISIONS
// that must hold identically across the tree — #998's load-bearing invariant, "a rule is never
// half-enforced across the tree" (it considered and rejected a per-directory ratchet precisely to
// avoid that). Before this check existed, the invariant was held by prose: each config carried its own
// copy of a decision plus a comment telling the next reader to keep it in lock-step with the other.
// An edit to one file and not the other silently violated it and nothing noticed.
//
// This script makes the invariant mechanical. It asks ESLint itself what config it will actually apply
// to a file (`eslint --print-config <file>`, which resolves the whole flat-config cascade including
// every per-file override) and asserts two things:
//
//   1. BASELINE — the resolved config of a representative file per config block, in both packages,
//      matches a committed snapshot. This is what proves a refactor of the config files (e.g. #1924's
//      extraction of the shared module) changed no rule anywhere; afterwards it keeps proving that a
//      change to the shared module doesn't silently drift one consumer.
//   2. PARITY — for the rules both packages have agreed to decide together (SHARED_RULES below), the
//      two packages resolve to the SAME setting for equivalent files. This is the #998 invariant
//      itself, checked directly rather than inferred from the snapshots.
//   3. CONTRACT — tooling/eslint-config's exports load and refuse to be called without the consuming
//      package's `tsconfigRootDir`. That parameter cannot be defaulted inside the shared module (it
//      would resolve to the module's own directory and silently point type-aware linting at the wrong
//      TypeScript program), so the guard that enforces it is worth a test of its own.
//
// Run:
//   node scripts/ci/check-eslint-config-parity.mjs            # verify (CI); non-zero exit on drift
//   node scripts/ci/check-eslint-config-parity.mjs --update    # deliberately re-record the baseline
//
// `--update` is the equivalent of accepting a Verify `.received.txt`: use it when a rule change is
// INTENDED, and review the resulting snapshot diff as part of the change. A non-empty diff you did not
// intend means the config edit did something you didn't mean it to — fix the config, don't re-record.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_DIR = join(REPO_ROOT, 'scripts', 'ci', 'eslint-config-baseline');

// One representative file per config block in each package, so the snapshot covers every branch of the
// cascade rather than just the common path. When a config block is added or its `files:` glob changes,
// add/adjust an entry here — a block with no representative is a block this check cannot see.
const PACKAGES = {
  'koine-studio': {
    dir: 'tooling/koine-studio',
    // `npm run lint` generates this first (the `prelint` hook); --print-config needs it too, since a
    // missing module makes type-aware resolution differ. Generated, git-ignored, excluded from the gate.
    pretasks: [['node', ['scripts/generate-templates.mjs']]],
    files: {
      'base-prod': 'src/main.ts',
      'lifecycle-guard-primitive': 'src/shared/lifecycleGuard.ts', // #1352 selector exemption
      'seq-counter-exempt': 'src/ai/ai.ts', // #1352 Seq-selector exemption
      'sanctioned-md-html': 'src/docs/MdHtml.tsx', // dangerouslySetInnerHTML allow-list
      'permanent-island-editor': 'src/editor/editor.ts', // permanent imperative island
      'permanent-island-diagrams': 'src/diagrams/diagrams-maxgraph.ts',
      'pending-island-settings': 'src/settings/prefs.ts', // pending-migration island
      'pending-island-inspector': 'src/shell/inspector/contextMapPanel.tsx',
      'test-file': 'src/lineBudgets.test.ts',
      'test-file-in-inspector': 'src/shell/inspector/contextMapPanel.test.ts',
      'story-file': 'src/launcher/LauncherPanel.stories.tsx',
      'test-setup': 'src/test-setup.ts',
    },
  },
  'koine-ui': {
    dir: 'tooling/koine-ui',
    pretasks: [],
    files: {
      'base-prod': 'src/index.ts',
      'test-file': 'src/useCommittableField.test.ts',
      'story-file': 'src/components/LeftRail.stories.tsx',
      'test-setup': 'src/test-setup.ts',
    },
  },
};

// The rules both packages decide together. Each is a decision recorded somewhere — an ADR, or a
// convention argued in the configs' headers — not merely a rule that happens to agree today. Adding a
// rule here is a statement that the two packages must never diverge on it.
const SHARED_RULES = [
  // ADR 0005 close-out addendum (#1827): exempt, and the exemption is void the moment the two promise
  // rules below stop being 'error' — which is exactly why all three are checked together.
  '@typescript-eslint/require-await',
  // ADR 0005's standing condition (#997): these two carry the safety intent require-await would have.
  '@typescript-eslint/no-floating-promises',
  '@typescript-eslint/no-misused-promises',
  // The tree-wide `_name` convention for a deliberately-unused binding (#1821).
  '@typescript-eslint/no-unused-vars',
  // Declaration-merging interfaces in each package's vitest-axe.d.ts (#1720).
  '@typescript-eslint/no-empty-object-type',
];

// Files whose resolved config must agree across packages for the SHARED_RULES. Keyed by the snapshot
// key both packages define — prod code, tests, and stories, since #997 put the promise rules over all
// three and a package-scoped override is precisely the drift this catches.
const PARITY_KEYS = ['base-prod', 'test-file', 'story-file', 'test-setup'];

/**
 * `--print-config` output is almost snapshot-ready, but two parts are not portable:
 *   - `parserOptions.tsconfigRootDir` is an absolute path (machine-specific);
 *   - `parser` and `plugins` embed exact package versions ("…@8.65.0"), so a routine dependency bump
 *     would fail this check for a reason that has nothing to do with rule parity.
 * Normalize both away. The snapshot keeps WHICH parser/plugins are active, and the full rule map —
 * that is the semantic surface this check exists to pin.
 */
function normalize(config) {
  const stripVersion = (s) => (typeof s === 'string' ? s.replace(/@\d+\.\d+\.\d+.*$/, '') : s);
  const lang = config.languageOptions ?? {};
  return {
    linterOptions: config.linterOptions,
    language: config.language,
    languageOptions: {
      sourceType: lang.sourceType,
      ecmaVersion: lang.ecmaVersion,
      parser: stripVersion(lang.parser),
      parserOptions: { ...lang.parserOptions, tsconfigRootDir: '<package-root>' },
    },
    plugins: Array.isArray(config.plugins) ? config.plugins.map(stripVersion) : config.plugins,
    // Sort so a reordering of the config blocks that leaves every rule identical is not reported as
    // drift — the check is about the RESOLVED decisions, not the authoring order that produced them.
    rules: Object.fromEntries(Object.entries(config.rules ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function printConfig(pkgDir, file) {
  const cwd = join(REPO_ROOT, pkgDir);
  let raw;
  try {
    raw = execFileSync('npx', ['eslint', '--print-config', file], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // A config that cannot even be RESOLVED is the loudest possible failure of this check's premise,
    // so report it as a finding rather than crashing the run with a raw stack trace.
    const detail = (err.stderr || err.message || '').toString().trim().split('\n').slice(-3).join('\n      ');
    throw new Error(`eslint --print-config failed in ${pkgDir} for ${file}:\n      ${detail}`);
  }
  return normalize(JSON.parse(raw));
}

const update = process.argv.includes('--update');
const failures = [];
const resolved = {}; // pkg -> key -> normalized config

for (const [pkg, spec] of Object.entries(PACKAGES)) {
  for (const [cmd, args] of spec.pretasks) {
    execFileSync(cmd, args, { cwd: join(REPO_ROOT, spec.dir), stdio: 'ignore' });
  }
  resolved[pkg] = {};
  for (const [key, file] of Object.entries(spec.files)) {
    const abs = join(REPO_ROOT, spec.dir, file);
    if (!existsSync(abs)) {
      // A representative that no longer exists silently stops covering its config block, so this is a
      // hard failure rather than a skip.
      failures.push(`${pkg}/${key}: representative file ${file} does not exist — update PACKAGES.`);
      continue;
    }
    resolved[pkg][key] = printConfig(spec.dir, file);
  }
}

// ── 1. Baseline ───────────────────────────────────────────────────────────────────────────────────
if (update) {
  rmSync(BASELINE_DIR, { recursive: true, force: true });
}
for (const [pkg, configs] of Object.entries(resolved)) {
  const dir = join(BASELINE_DIR, pkg);
  if (update) mkdirSync(dir, { recursive: true });
  for (const [key, config] of Object.entries(configs)) {
    const path = join(dir, `${key}.json`);
    const actual = `${JSON.stringify(config, null, 2)}\n`;
    if (update) {
      writeFileSync(path, actual);
      continue;
    }
    if (!existsSync(path)) {
      failures.push(`${pkg}/${key}: no baseline at ${path} — run with --update to record it.`);
      continue;
    }
    const expected = readFileSync(path, 'utf8');
    if (expected !== actual) {
      const exp = JSON.parse(expected);
      const changed = [...new Set([...Object.keys(exp.rules), ...Object.keys(config.rules)])]
        .filter((r) => JSON.stringify(exp.rules[r]) !== JSON.stringify(config.rules[r]))
        .map((r) => `      ${r}: ${JSON.stringify(exp.rules[r])} -> ${JSON.stringify(config.rules[r])}`);
      failures.push(
        `${pkg}/${key}: resolved config differs from the committed baseline.\n` +
          (changed.length
            ? `    rules changed:\n${changed.join('\n')}`
            : '    rules are identical; a non-rule field (parser/plugins/parserOptions) changed.'),
      );
    }
  }
}

// Guard against a stale baseline directory outliving its representative (a renamed key would otherwise
// leave an orphan snapshot that nothing checks).
if (!update && existsSync(BASELINE_DIR)) {
  for (const pkg of readdirSync(BASELINE_DIR)) {
    if (!resolved[pkg]) {
      failures.push(`baseline/${pkg}: snapshot directory has no matching entry in PACKAGES.`);
      continue;
    }
    for (const f of readdirSync(join(BASELINE_DIR, pkg))) {
      const key = f.replace(/\.json$/, '');
      if (!(key in resolved[pkg])) {
        failures.push(`baseline/${pkg}/${f}: orphan snapshot — no representative named "${key}".`);
      }
    }
  }
}

// ── 2. Cross-package parity ───────────────────────────────────────────────────────────────────────
const pkgNames = Object.keys(PACKAGES);
for (const key of PARITY_KEYS) {
  const [first, ...rest] = pkgNames;
  for (const other of rest) {
    const a = resolved[first]?.[key];
    const b = resolved[other]?.[key];
    if (!a || !b) continue; // a missing representative is already reported above
    for (const rule of SHARED_RULES) {
      const av = JSON.stringify(a.rules[rule]);
      const bv = JSON.stringify(b.rules[rule]);
      if (av !== bv) {
        failures.push(
          `parity/${key}: "${rule}" is half-enforced across the tree — ` +
            `${first}=${av ?? 'unset'} but ${other}=${bv ?? 'unset'}. ` +
            'Shared rule decisions belong in tooling/eslint-config, changed once for both packages.',
        );
      }
    }
  }
}

// ── 3. Shared-module contract ─────────────────────────────────────────────────────────────────────
{
  const shared = await import('@atypical/eslint-config');
  const exports_ = ['typeCheckedPreset', 'promiseSafetyGate', 'reactHooksGate'];
  for (const name of exports_) {
    if (typeof shared[name] !== 'function') {
      failures.push(`contract: @atypical/eslint-config does not export a "${name}" function.`);
      continue;
    }
    // Every export must REFUSE a missing tsconfigRootDir rather than quietly defaulting it.
    for (const bad of [undefined, '', null, 42]) {
      let threw = false;
      try {
        shared[name](bad);
      } catch {
        threw = true;
      }
      if (!threw) {
        failures.push(
          `contract: ${name}(${JSON.stringify(bad)}) did not throw — tsconfigRootDir must be required, ` +
            'never defaulted, or type-aware linting silently targets the wrong program.',
        );
      }
    }
    const blocks = shared[name]('/tmp/some-consumer');
    if (!Array.isArray(blocks) || blocks.length === 0) {
      failures.push(`contract: ${name}() must return a non-empty flat-config array to be spread.`);
      continue;
    }
    for (const block of blocks) {
      const root = block.languageOptions?.parserOptions?.tsconfigRootDir;
      if (root !== '/tmp/some-consumer') {
        failures.push(`contract: ${name}() ignored the caller's tsconfigRootDir (got ${String(root)}).`);
      }
    }
  }
}

if (update) {
  console.log(`Recorded ESLint config baseline under ${BASELINE_DIR.replace(`${REPO_ROOT}/`, '')}.`);
  if (failures.length) {
    console.error('\nBaseline recorded, but the shared-module contract check FAILED:\n');
    for (const f of failures) console.error(`  - ${f}\n`);
    process.exit(1);
  }
  process.exit(0);
}
if (failures.length) {
  console.error('ESLint config parity check FAILED:\n');
  for (const f of failures) console.error(`  - ${f}\n`);
  console.error(
    'If a rule change was INTENDED, re-record with:\n' +
      '  node scripts/ci/check-eslint-config-parity.mjs --update\n' +
      'and review the snapshot diff as part of the change.',
  );
  process.exit(1);
}
const count = Object.values(resolved).reduce((n, c) => n + Object.keys(c).length, 0);
console.log(
  `ESLint config parity OK: ${count} resolved configs match the baseline; ` +
    `${SHARED_RULES.length} shared rules agree across ${pkgNames.length} packages.`,
);
