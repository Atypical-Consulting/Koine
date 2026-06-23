// Pure, testable core of the "Generate Project" feature: turn the emitter's flat list of files
// into a downloadable, ready-to-build project archive. This module knows nothing about the DOM,
// the LSP transport, or the host — the wizard (generateProjectWizard.ts) supplies the emitted
// files and a destination via the Platform.saveZip seam, and these helpers do the bundling.
import JSZip from 'jszip';
import type { EmitFile, EmitPreviewResult } from '@/lsp/lsp';

// A C#/namespace-friendly project identifier: a leading letter or underscore, then letters,
// digits, underscores, or dots. Drives the zip root folder, the .csproj filename, and (for the
// synthesized project file) the implied root namespace.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** True when `name` is a usable project/namespace identifier. */
export function isValidProjectName(name: string): boolean {
  return NAME_RE.test(name);
}

/**
 * Coerce arbitrary text into a valid project name: trim, replace every disallowed character with
 * `_`, prefix `_` when it would otherwise start with a digit, and fall back to `KoineProject`
 * when nothing usable remains. Always returns a string satisfying {@link isValidProjectName}.
 */
export function sanitizeProjectName(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return 'KoineProject';
  let s = trimmed.replace(/[^A-Za-z0-9_.]/g, '_');
  if (!/^[A-Za-z_]/.test(s)) s = '_' + s;
  return s;
}

/**
 * Derive a default project name from the emitted files: the first segment of the first path that
 * actually has a directory (the emitter groups model output under a context/namespace folder, e.g.
 * `Billing/Orders/Order.cs`), sanitized. Top-level files such as the TypeScript emitter's
 * `runtime.ts` / `tsconfig.json` are skipped — using one would yield a nonsense name like
 * `runtime.ts`. Falls back to `KoineProject` when nothing is namespaced.
 */
export function defaultProjectName(files: readonly EmitFile[]): string {
  const seg = files.map((f) => f.path).find((p) => p.includes('/'))?.split('/')[0];
  return seg ? sanitizeProjectName(seg) : 'KoineProject';
}

/**
 * A minimal SDK-style C# project file mirroring the repo's Directory.Build.props (net10.0, nullable
 * + implicit usings + latest lang version), with no package references — emitted Koine C# is
 * self-contained. Returned at `<name>/<name>.csproj` so it lands at the archive root next to the
 * generated source tree.
 */
export function synthesizeCsproj(projectName: string): EmitFile {
  const contents = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <LangVersion>latest</LangVersion>
  </PropertyGroup>
</Project>
`;
  return { path: `${projectName}/${projectName}.csproj`, contents };
}

export interface BuildOptions {
  /** Project name; becomes the archive's root folder. Should satisfy {@link isValidProjectName}. */
  projectName: string;
  /** Add a synthesized `<name>/<name>.csproj` (C# target only). */
  includeCsproj: boolean;
  /** Ubiquitous-language glossary markdown to include as `<name>/glossary.md`; omitted when empty. */
  glossary?: string | null;
}

/**
 * Bundle the emitted files into a zip, preserving each file's relative path under a single
 * project-named root folder, optionally adding the synthesized `.csproj` and a glossary. Returns
 * the archive bytes (the browser wraps them in a Blob to download; the desktop writes them to a
 * picked path). Throws on any emitted path containing `..` — defense in depth, even though emitter
 * paths are already relative and safe.
 */
export async function buildProjectZip(files: readonly EmitFile[], opts: BuildOptions): Promise<Uint8Array> {
  const root = opts.projectName;
  const zip = new JSZip();
  for (const f of files) {
    // Reject a `..` path SEGMENT (traversal) — not any substring `..`, which would wrongly reject a
    // legitimate name like `My..Context`.
    if (f.path.split('/').some((s) => s === '..')) throw new Error(`unsafe path in emitted file: ${f.path}`);
    zip.file(`${root}/${f.path}`, f.contents);
  }
  if (opts.includeCsproj) {
    const csproj = synthesizeCsproj(root);
    zip.file(csproj.path, csproj.contents);
  }
  if (opts.glossary && opts.glossary.trim()) {
    zip.file(`${root}/glossary.md`, opts.glossary);
  }
  return zip.generateAsync({ type: 'uint8array' });
}

/**
 * Whether a preview result can be turned into a project: emit must have succeeded (no `error`),
 * produced at least one file, and the chosen name must be valid. Mirrors how the existing preview
 * pane treats `error`/empty `files` as the authoritative "nothing usable was emitted" signal.
 */
export function canGenerate(result: Pick<EmitPreviewResult, 'files' | 'error'>, projectName: string): boolean {
  if (result.error) return false;
  if (!result.files || result.files.length === 0) return false;
  return isValidProjectName(projectName);
}
