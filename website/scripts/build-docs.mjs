// Generates Koine's "living documentation" (Mermaid-in-Markdown) from the Shop demo
// model and syncs it into the Starlight content collection at
// website/src/content/docs/reference/domain/ so the docs site renders it.
//
// Run via `npm run build:docs`; invoked automatically by predev/prebuild alongside
// build-wasm and og-image. The output directory is .gitignored — it is regenerated
// from the compiler on every build, exactly like the wasm bundle and OG card.
//
// What it does:
//   1. Shells out to the Koine CLI:  build <model> --target docs --out <tmp>
//      The docs emitter writes plain Markdown (with Mermaid code fences) under a
//      `docs/` subfolder, one file per bounded context plus index/context-map/etc.
//   2. Rewrites each file for Starlight:
//        - lifts the leading `# Heading` into YAML frontmatter (title + description)
//          so it satisfies the docsSchema (title is required);
//        - rewrites intra-doc `./Foo.md` links to Starlight slug URLs
//          (/Koine/reference/domain/foo/);
//        - renames index.md -> the section landing page.
//   3. Writes the result into src/content/docs/reference/domain/.
//
// Mermaid: GitHub renders ```mermaid fences natively. Starlight does NOT by default,
// but the fences are left intact and degrade to a readable code block; a Mermaid
// rendering plugin can be added later without changing this script.
//
// Cross-platform (Windows/Linux CI). No deps beyond Node's stdlib.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const websiteDir = resolve(here, '..');
const repoRoot = resolve(websiteDir, '..');

// The model compiled into living docs. The Shop demo is the canonical six-context model.
const model = join(repoRoot, 'demo', 'Shop.Domain', 'Models');
// Scratch directory for the raw emitter output (outside the content tree).
const tmpOut = join(websiteDir, '.koine-docs');
// Where Starlight reads the synced pages from. Mirrored in astro.config.mjs sidebar.
const contentDir = join(websiteDir, 'src', 'content', 'docs', 'reference', 'domain');
// Slug prefix used to rewrite intra-doc links (base + collection path).
const slugPrefix = '/Koine/reference/domain/';

// 1. Run the CLI docs emitter into a clean scratch dir.
rmSync(tmpOut, { recursive: true, force: true });
mkdirSync(tmpOut, { recursive: true });
console.log(`> dotnet run --project src/Koine.Cli -- build ${model} --target docs --out ${tmpOut}`);
execFileSync(
  'dotnet',
  ['run', '--project', join(repoRoot, 'src', 'Koine.Cli'), '--', 'build', model, '--target', 'docs', '--out', tmpOut],
  { stdio: 'inherit', cwd: repoRoot },
);

// The emitter writes under a `docs/` subfolder.
const emitted = join(tmpOut, 'docs');
if (!existsSync(emitted)) {
  console.error(`\nERROR: docs emitter produced no output at ${emitted}.`);
  process.exit(1);
}

// 2/3. Transform each Markdown file into a Starlight page and write it out.
rmSync(contentDir, { recursive: true, force: true });
mkdirSync(contentDir, { recursive: true });

const yamlEscape = (s) => s.replace(/"/g, '\\"');

// Strip Markdown emphasis/links from a heading so it makes a clean frontmatter title.
const plainText = (s) =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/[*_`]/g, '') // emphasis / code
    .trim();

const files = readdirSync(emitted).filter((f) => f.endsWith('.md'));
let written = 0;

for (const file of files) {
  const raw = readFileSync(join(emitted, file), 'utf8');
  const lines = raw.split(/\r?\n/);

  // Pull the first `# Heading` for the title; remove it from the body.
  let title = basename(file, '.md');
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#\s+(.*)$/);
    if (m) {
      title = plainText(m[1]);
      bodyStart = i + 1;
      break;
    }
  }

  // First non-empty paragraph after the heading becomes the description. A paragraph
  // may be soft-wrapped across several source lines, so collect until a blank line.
  let description = '';
  for (let i = bodyStart; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) {
      if (description) break;
      continue;
    }
    if (t.startsWith('#') || t.startsWith('```') || t.startsWith('|') || t.startsWith('-')) break;
    description = description ? `${description} ${plainText(t)}` : plainText(t);
  }

  let body = lines.slice(bodyStart).join('\n').replace(/^\n+/, '');

  // Rewrite intra-doc links: [text](./Foo.md) -> [text](/Koine/reference/domain/foo/)
  body = body.replace(/\]\(\.\/([A-Za-z0-9._-]+)\.md\)/g, (_m, name) => {
    const slug = name.toLowerCase();
    return `](${slugPrefix}${slug}/)`;
  });

  // index.md becomes the section landing page.
  const outName = file === 'index.md' ? 'index.md' : file;

  const fm =
    `---\n` +
    `title: "${yamlEscape(title)}"\n` +
    (description ? `description: "${yamlEscape(description)}"\n` : '') +
    `editUrl: false\n` +
    `sidebar:\n  hidden: false\n` +
    `---\n\n`;

  writeFileSync(join(contentDir, outName), fm + body + '\n');
  written++;
}

console.log(`\nKoine living docs synced: ${written} pages -> ${contentDir}`);
