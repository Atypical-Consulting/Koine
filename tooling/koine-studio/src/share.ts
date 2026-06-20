// Shareable-link support: encode a single .koi model into the URL hash so a link round-trips a
// scratch model to anyone who opens it (docs, bug reports, teaching), like the TypeScript/Rust
// playgrounds. The model is UTF-8 → base64 in the `#model=` fragment; the fragment never leaves
// the browser (it is not sent to the server), so no size/security concerns beyond URL length.
//
// Pure data + window.location only — no DOM, no app state.

const HASH_KEY = 'model';

/**
 * The on-the-wire shape of a multi-file workspace share. Encoded as JSON in the `#model=` fragment
 * (then base64), so a share link can carry a whole folder, not just one scratch buffer. `v` is a
 * payload version for forward evolution; `files` are relative-path + text pairs; `active` (optional)
 * names which file the recipient should land on.
 */
export interface WorkspaceShare {
  v?: number;
  files: { relPath: string; text: string }[];
  active?: string;
}

/**
 * A decoded share payload. A `single` model is one raw .koi buffer (the original, legacy shape); a
 * `workspace` carries several files. {@link readModelFromHash} disambiguates the two by shape so old
 * single-string links keep opening.
 */
export type SharePayload =
  | { kind: 'single'; text: string }
  | { kind: 'workspace'; files: { relPath: string; text: string }[]; active?: string };

/**
 * UTF-8-safe, URL-safe base64 encode (btoa only handles Latin-1, so widen through
 * encodeURIComponent; then map `+`/`/` to `-`/`_` so the payload survives a URL fragment that
 * passes through form-decoding surfaces — a raw `+` would otherwise be turned into a space).
 */
function encodeBase64(text: string): string {
  return btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_');
}

/** Inverse of {@link encodeBase64}; throws on malformed input (callers guard). */
function decodeBase64(b64: string): string {
  return decodeURIComponent(escape(atob(b64.replace(/-/g, '+').replace(/_/g, '/'))));
}

/** A full shareable URL (origin + path + `#model=…`) for the given single model source. */
export function buildShareUrl(source: string): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#${HASH_KEY}=${encodeBase64(source)}`;
}

/**
 * A full shareable URL carrying a multi-file workspace. The files (and the optional active file) are
 * JSON-serialized under a versioned envelope, then base64-encoded into the same `#model=` fragment so
 * the same reader ({@link readModelFromHash}) round-trips both single and workspace shares.
 */
export function buildWorkspaceShareUrl(
  files: { relPath: string; text: string }[],
  active?: string
): string {
  const { origin, pathname, search } = window.location;
  const payload: WorkspaceShare = { v: 1, files, ...(active !== undefined ? { active } : {}) };
  const encoded = encodeBase64(JSON.stringify(payload));
  return `${origin}${pathname}${search}#${HASH_KEY}=${encoded}`;
}

/**
 * Largest `#model=<base64>` fragment we will hand out as a share link. A base64 workspace payload
 * grows ~4/3 with the source, and browsers / proxies / clipboards start truncating or rejecting very
 * long URLs — so past this cap we refuse to copy a silently-broken link and steer the user to the
 * `.koi` source zip export instead. Tunable; measured against the whole `#model=…` fragment.
 */
export const MAX_SHARE_HASH_LEN = 8000;

/**
 * Build a workspace share URL, but only when its `#model=…` fragment fits within
 * {@link MAX_SHARE_HASH_LEN}; otherwise null. A null result means the workspace is too large to ride
 * in a URL — the caller should offer the `.koi` source zip export rather than copy a broken link.
 */
export function workspaceShareUrlOrNull(
  files: { relPath: string; text: string }[],
  active?: string
): string | null {
  const url = buildWorkspaceShareUrl(files, active);
  const fragment = url.slice(url.indexOf('#'));
  return fragment.length <= MAX_SHARE_HASH_LEN ? url : null;
}

/** True when `value` is a workspace envelope: an object with a `files[]` of `{relPath, text}`. */
function isWorkspaceShape(value: unknown): value is WorkspaceShare {
  if (typeof value !== 'object' || value === null) return false;
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files)) return false;
  return files.every(
    (f) =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as { relPath?: unknown }).relPath === 'string' &&
      typeof (f as { text?: unknown }).text === 'string'
  );
}

/**
 * The share payload encoded in the current URL hash, or null when there is none / it is malformed.
 * Reads `#model=<base64>` (tolerating other `&`-joined fragment params around it) and disambiguates:
 * a workspace envelope (`{ files: [{relPath, text}, …] }`) decodes to `kind: 'workspace'`; anything
 * else — including legacy raw-`.koi` links and JSON that is not a workspace — is the original
 * single-string model (`kind: 'single'`). Never throws.
 */
export function readModelFromHash(): SharePayload | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  for (const part of hash.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) !== HASH_KEY) continue;
    let decoded: string;
    try {
      decoded = decodeBase64(part.slice(eq + 1));
    } catch {
      return null;
    }
    if (!decoded.length) return null;
    // Try to read it as a versioned workspace envelope; if the JSON parse fails or the shape does
    // not match, fall back to treating the whole decoded string as a single raw .koi model. This is
    // what keeps legacy single-string links (and .koi sources that merely happen to be valid JSON)
    // opening as a single model.
    try {
      const parsed: unknown = JSON.parse(decoded);
      if (isWorkspaceShape(parsed)) {
        return parsed.active !== undefined
          ? { kind: 'workspace', files: parsed.files, active: parsed.active }
          : { kind: 'workspace', files: parsed.files };
      }
    } catch {
      // not JSON — fall through to single
    }
    return { kind: 'single', text: decoded };
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
