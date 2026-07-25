import AsyncStorage from '@react-native-async-storage/async-storage';
import { setBaseUrl } from '@music-library/core';

const SERVER_URL_KEY = 'mlib-server-url';

/**
 * Where the library lives. The web client is served same-origin and the iOS
 * client bakes the URL in at build time; a desktop app is installed from a DMG
 * with no build-time context, so the user supplies it on first launch and it is
 * persisted from then on.
 */
export async function loadServerUrl(): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(SERVER_URL_KEY);
    return stored && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

export async function saveServerUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(SERVER_URL_KEY, url);
}

export async function clearServerUrl(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SERVER_URL_KEY);
  } catch {
    /* ignored */
  }
}

export { normalizeServerUrl } from './normalize-server-url';

/** Reachability probe used before persisting a URL the user just typed. */
export async function probeServerUrl(
  url: string,
  timeoutMs = 8000,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // `/api/auth/me` answers 200 or 401 depending on the session; either proves
    // a Lumen backend is listening, which is all we need before saving.
    const res = await fetch(`${url}/api/auth/me`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 200 || res.status === 401) return { ok: true };
    return {
      ok: false,
      message: `Server answered ${res.status}. Is this a Lumen server?`,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, message: 'Timed out reaching that address.' };
    }
    return { ok: false, message: "Couldn't reach that address." };
  } finally {
    clearTimeout(timer);
  }
}

/** Point core's API client at `url` for the rest of the process. */
export function applyServerUrl(url: string): void {
  setBaseUrl(url);
}
