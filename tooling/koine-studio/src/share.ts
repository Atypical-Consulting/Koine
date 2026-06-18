// Shareable-link support: encode a single .koi model into the URL hash so a link round-trips a
// scratch model to anyone who opens it (docs, bug reports, teaching), like the TypeScript/Rust
// playgrounds. The model is UTF-8 → base64 in the `#model=` fragment; the fragment never leaves
// the browser (it is not sent to the server), so no size/security concerns beyond URL length.
//
// Pure data + window.location only — no DOM, no app state.

const HASH_KEY = 'model';

/** UTF-8-safe base64 encode (btoa only handles Latin-1, so widen through encodeURIComponent). */
function encodeBase64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
}

/** Inverse of {@link encodeBase64}; throws on malformed input (callers guard). */
function decodeBase64(b64: string): string {
  return decodeURIComponent(escape(atob(b64)));
}

/** A full shareable URL (origin + path + `#model=…`) for the given model source. */
export function buildShareUrl(source: string): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#${HASH_KEY}=${encodeBase64(source)}`;
}

/**
 * The model encoded in the current URL hash, or null when there is none / it is malformed. Reads
 * `#model=<base64>` (tolerating other `&`-joined fragment params around it).
 */
export function readModelFromHash(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  for (const part of hash.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) !== HASH_KEY) continue;
    try {
      const decoded = decodeBase64(part.slice(eq + 1));
      return decoded.length ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Remove the model fragment from the URL without reloading or adding a history entry, so a later
 * reload starts clean (restoring the scratch buffer, not re-importing the shared model).
 */
export function clearModelHash(): void {
  try {
    const { origin, pathname, search } = window.location;
    window.history.replaceState(null, '', `${origin}${pathname}${search}`);
  } catch {
    // history unavailable — harmless; the import already happened.
  }
}
