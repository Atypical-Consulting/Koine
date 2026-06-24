// Map a download filename's extension to its save metadata (#271): the dialog title + filter label for the
// desktop save dialog, and the MIME type for the browser Blob. `Platform.saveZip` writes arbitrary single-file
// bytes (not just `.zip` — it's the diagram-export save path too), so the two host save paths derive their
// dialog/MIME from this ONE table rather than hardcoding zip, which keeps them from drifting on the supported
// formats and stops a `.png`/`.svg`/`.puml` export from showing a "Zip archive" filter or an `application/zip`
// blob. Unknown extensions fall back to a generic single file.

export interface SaveMeta {
  /** Save-dialog window title (desktop host). */
  title: string;
  /** Human-readable label for the file-type filter (desktop host). */
  filterName: string;
  /** Lower-cased file extension without the dot (e.g. `png`); `''` when the name carries none. */
  ext: string;
  /** Blob MIME type for the browser download. */
  mime: string;
}

const TABLE: Record<string, { title: string; filterName: string; mime: string }> = {
  zip: { title: 'Save generated project', filterName: 'Zip archive', mime: 'application/zip' },
  svg: { title: 'Save diagram', filterName: 'SVG image', mime: 'image/svg+xml' },
  png: { title: 'Save diagram', filterName: 'PNG image', mime: 'image/png' },
  puml: { title: 'Save diagram', filterName: 'PlantUML source', mime: 'text/plain' },
};

/** Resolve the {@link SaveMeta} for a suggested filename by its extension. */
export function saveMetaFor(defaultName: string): SaveMeta {
  const dot = defaultName.lastIndexOf('.');
  const ext = dot >= 0 ? defaultName.slice(dot + 1).toLowerCase() : '';
  const known = TABLE[ext];
  return {
    title: known?.title ?? 'Save file',
    filterName: known?.filterName ?? 'File',
    ext,
    mime: known?.mime ?? 'application/octet-stream',
  };
}
