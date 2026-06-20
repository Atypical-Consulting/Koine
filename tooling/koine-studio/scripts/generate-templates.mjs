// Generates src/templates.generated.ts from the repo's top-level `templates/` directory — the
// single validated source of truth for Koine's example domains (issue #101). Each template is a
// folder holding a `template.json` manifest beside one or more `.koi` source files; this script
// reads them and emits `export const TEMPLATES: Template[]` so the studio's welcome gallery and
// example-opening flow consume real, validated templates instead of hand-inlined copies.
//
// The core (collectTemplates / renderManifest) is pure and exported so the vitest suite can drive
// it against a fixture dir; running the file as a script (`node scripts/generate-templates.mjs`)
// resolves the real templates/ dir and writes the generated module. Mirrors build-wasm.mjs's
// import.meta.url path resolution + .mjs style. No deps beyond Node's stdlib.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const studioDir = resolve(here, '..'); // tooling/koine-studio

/**
 * Resolve the repo's top-level `templates/` directory. We walk up from the studio package looking
 * for a `templates/` folder so the lookup is robust to where the package sits (a normal checkout,
 * or a git worktree whose root differs from the main clone). Falls back to repoRoot/templates.
 * @returns {string} absolute path to the templates dir
 */
export function resolveTemplatesDir() {
  let dir = studioDir;
  // Walk up to the filesystem root; the first ancestor that contains a `templates/` dir wins.
  for (;;) {
    const candidate = join(dir, 'templates');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: the historical layout (tooling/koine-studio → repo root → templates).
  return resolve(studioDir, '..', '..', 'templates');
}

/** All `.koi` files under `dir` (recursively), as repo-folder-relative forward-slashed relPaths. */
function koiFilesIn(dir) {
  /** @type {{ relPath: string; contents: string }[]} */
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.koi')) {
        const relPath = relative(dir, full).split(/[\\/]/).join('/');
        out.push({ relPath, contents: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Read every template folder (one with a `template.json`) under `templatesDir`, recursively (so a
 * nested group like `starters/billing` is found), and return the assembled `Template[]`.
 *
 * For each template:
 *   • every manifest field is carried through verbatim,
 *   • `files[]` = every `.koi` in the folder (relPath relative to the folder, forward-slashed),
 *   • `source` = the contents of the manifest's `entryFile` (the file opened first / scratch fallback).
 *
 * Throws if a manifest's `entryFile` names a file that isn't present in its folder (the schema
 * requires entryFile to exist, so a mismatch is a build-time error worth surfacing loudly).
 *
 * @param {string} templatesDir absolute path to a templates/ directory
 * @returns {import('../src/templates').Template[]}
 */
export function collectTemplates(templatesDir) {
  /** @type {import('../src/templates').Template[]} */
  const templates = [];

  const visit = (dir) => {
    const manifestPath = join(dir, 'template.json');
    if (existsSync(manifestPath) && statSync(manifestPath).isFile()) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const files = koiFilesIn(dir);
      const entry = files.find((f) => f.relPath === manifest.entryFile);
      if (!entry) {
        throw new Error(
          `Template "${manifest.id}" (${dir}): entryFile "${manifest.entryFile}" not found among its .koi files ` +
            `(${files.map((f) => f.relPath).join(', ') || 'none'}).`,
        );
      }
      templates.push({
        id: manifest.id,
        name: manifest.name,
        tagline: manifest.tagline,
        description: manifest.description,
        difficulty: manifest.difficulty,
        tags: manifest.tags,
        contexts: manifest.contexts,
        coreAggregate: manifest.coreAggregate,
        entryFile: manifest.entryFile,
        teaches: manifest.teaches,
        icon: manifest.icon,
        source: entry.contents,
        files,
      });
      return; // a template folder is a leaf — don't descend into a template's own subfolders
    }
    // Not a template folder: descend into subdirectories looking for ones that are.
    for (const child of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.isDirectory()) visit(join(dir, child.name));
    }
  };

  visit(templatesDir);

  // Order: starters first (by the difficulty rung), then by name — a stable, learner-friendly order
  // and a deterministic generated file.
  const rung = { starter: 0, beginner: 1, intermediate: 2, advanced: 3 };
  templates.sort((a, b) => {
    const d = (rung[a.difficulty] ?? 9) - (rung[b.difficulty] ?? 9);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  return templates;
}

/** Render the generated TypeScript module source for a `Template[]`. */
export function renderManifest(templates) {
  const header =
    '// AUTO-GENERATED by scripts/generate-templates.mjs from the repo `templates/` directory.\n' +
    '// DO NOT EDIT BY HAND and DO NOT COMMIT — it is git-ignored and regenerated on dev/build/test.\n' +
    "import type { Template } from './templates';\n\n";
  const body = JSON.stringify(templates, null, 2);
  return `${header}export const TEMPLATES: Template[] = ${body};\n`;
}

/** Resolve the real templates dir, collect, and write src/templates.generated.ts. */
export function generate() {
  const templatesDir = resolveTemplatesDir();
  if (!existsSync(templatesDir)) {
    console.error(`ERROR: templates directory not found at ${templatesDir}.`);
    process.exit(1);
  }
  const templates = collectTemplates(templatesDir);
  const outDir = join(studioDir, 'src');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'templates.generated.ts');
  writeFileSync(outFile, renderManifest(templates), 'utf8');
  console.log(`Generated ${relative(studioDir, outFile)} with ${templates.length} template(s) from ${templatesDir}`);
  return outFile;
}

// Run as a script (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generate();
}
