// Selects the platform backend for the current host. Detection is by Tauri's injected globals;
// anything else (a plain browser tab) gets the WASM-backed browser backend. The chosen platform
// is cached so the whole app shares one instance.
import type { Platform } from './types';
import { TauriPlatform } from './tauri';
import { BrowserPlatform } from './browser';

export type { KoiFile, LspTransport, Platform, SourceDoc } from './types';

/** True when running inside the Tauri desktop shell (v2 injects `__TAURI_INTERNALS__`). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

let cached: Platform | null = null;

/** The platform backend for this host (Tauri desktop or browser), created once. */
export function getPlatform(): Platform {
  if (!cached) {
    cached = isTauri() ? new TauriPlatform() : new BrowserPlatform();
  }
  return cached;
}
