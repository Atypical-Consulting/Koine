// The API-key secret cache and its boot lifecycle live HERE; the crypto (AES-256-GCM, IndexedDB) lives
// in `@/ai/secrets.ts` and is not touched by this module. The key is NEVER written to the plaintext
// localStorage settings blob — it is decrypted once at boot (initSecrets) into the in-memory
// `secretCache` below, so the synchronous Settings API can keep exposing it without leaking it to disk
// in the clear. `doInitSecrets` intentionally rewrites the raw settings blob DIRECTLY (via readRaw/
// writeRaw), bypassing `saveSettings`'s coercers, so a hand-edited blob isn't silently rewritten
// through coercion — only the migrated `aiApiKey` field is removed, everything else round-trips as-is.

import { loadSecret, saveSecret } from '@/ai/secrets';
import { readRaw, writeRaw } from '@/shell/storage';
import { SETTINGS_KEY } from './storage';

/** The secret kept out of the plaintext blob and in the encrypted store; also its key name there. */
const API_KEY_SECRET = 'aiApiKey';

// The decrypted API key, populated once by initSecrets() and updated by saveApiKey()/clearApiKey().
// loadSettings() reads from here (via getCachedApiKey) so the secret never round-trips through localStorage.
let secretCache = '';

// Memoized so repeated calls (and whenSecretsReady) share one decrypt, and so callers can await the
// exact moment secretCache is populated rather than racing the fire-and-forget boot call.
let secretsReady: Promise<void> | null = null;

/**
 * Decrypt the stored API key into the in-memory cache, run once at boot before any AI request.
 * Also performs a one-time migration: a key left in the legacy plaintext settings blob is moved
 * into the encrypted store and scrubbed from the blob. Idempotent — the first call does the work.
 */
export function initSecrets(): Promise<void> {
  if (!secretsReady) secretsReady = doInitSecrets();
  return secretsReady;
}

/** Resolves once the secret cache has been populated (or immediately if never initialized). */
export function whenSecretsReady(): Promise<void> {
  return secretsReady ?? Promise.resolve();
}

async function doInitSecrets(): Promise<void> {
  const raw = readRaw(SETTINGS_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const legacy = typeof parsed?.aiApiKey === 'string' ? parsed.aiApiKey : '';
      if (legacy.length > 0) {
        await saveSecret(API_KEY_SECRET, legacy);
        // Rewrite the blob without the secret (loadSettings injects secretCache below).
        delete parsed.aiApiKey;
        writeRaw(SETTINGS_KEY, JSON.stringify(parsed));
      }
    } catch {
      // malformed blob — nothing to migrate
    }
  }
  secretCache = await loadSecret(API_KEY_SECRET);
}

/** Update and persist the secret API key (encrypted). An empty value clears it. */
export async function saveApiKey(value: string): Promise<void> {
  secretCache = value;
  await saveSecret(API_KEY_SECRET, value);
}

/** Forget the secret API key (memory + encrypted store). */
export async function clearApiKey(): Promise<void> {
  secretCache = '';
  await saveSecret(API_KEY_SECRET, '');
}

/** The current in-memory cached API key. Barrel-private: used by persistence.ts's loadSettings() to
 *  inject the secret without round-tripping it through localStorage; NOT re-exported by the barrel. */
export function getCachedApiKey(): string {
  return secretCache;
}
