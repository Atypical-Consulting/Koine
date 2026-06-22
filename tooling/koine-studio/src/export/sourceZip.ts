// Pure, testable core of the "Export .koi source" feature: turn the open `.koi` documents into a
// downloadable source archive. Like generateProject.ts, this module knows nothing about the DOM,
// the LSP transport, or the host — ide.ts supplies the open buffers' relative paths + text and a
// destination via the Platform.saveZip seam, and this helper does the bundling.
import JSZip from 'jszip';

/** One source document to archive: its path relative to the workspace root and its text. */
export interface SourceFile {
  /** Path relative to the workspace root, e.g. `Billing/Order.koi`. Becomes the in-zip path under `root`. */
  relPath: string;
  /** Raw `.koi` source text. */
  text: string;
}

export interface SourceZipOptions {
  /** Becomes the archive's single root folder (e.g. the opened folder's name, sanitized). */
  root: string;
}

/**
 * Bundle the given `.koi` sources into a zip, preserving each file's relative path under a single
 * `root` folder. Returns the archive bytes (the browser wraps them in a Blob to download; the
 * desktop writes them to a picked path). Throws on any path containing a `..` SEGMENT — defense in
 * depth, mirroring {@link buildProjectZip}, even though workspace-relative paths are already safe.
 */
export async function buildSourceZip(files: readonly SourceFile[], opts: SourceZipOptions): Promise<Uint8Array> {
  const root = opts.root;
  const zip = new JSZip();
  for (const f of files) {
    // Reject a `..` path SEGMENT (traversal) — not any substring `..`, which would wrongly reject a
    // legitimate name like `My..Context.koi`.
    if (f.relPath.split('/').some((s) => s === '..')) throw new Error(`unsafe path in source file: ${f.relPath}`);
    zip.file(`${root}/${f.relPath}`, f.text);
  }
  return zip.generateAsync({ type: 'uint8array' });
}
