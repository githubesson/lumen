import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, setUnauthorizedHandler, type Me } from "../api";
import { advanceAuthGeneration } from "../api-transport";
import type { Storage } from "../storage";

export interface AuthState {
  status: "loading" | "guest" | "authed";
  me: Me | null;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  setMe: (me: Me | null) => void;
}

const AuthCtx = createContext<AuthState | null>(null);

/** Where the last-known session is cached for offline launches. */
const ME_CACHE_KEY = "auth.me.v1";
const SIGNED_OUT_KEY = "auth.signed-out.v1";

/**
 * Platform-agnostic auth provider. Drives the session-cookie auth dance:
 * calls `api.me()` on mount, and exposes login/logout helpers. Reusable
 * on both web (session cookie from the browser jar) and iOS (cookie
 * persisted via `@react-native-cookies/cookies`).
 *
 * `sessionCache` (optional) makes auth offline-resilient: the last-known `Me`
 * is cached there, and `refresh()` falls back to it when `api.me()` fails for
 * any reason other than an explicit 401 — only the server rejecting the
 * session proves it dead. Without it (web), any failure resolves to guest.
 */
export function AuthProvider({
  children,
  sessionCache,
  intentStorage = sessionCache,
  clearSession,
}: {
  children: ReactNode;
  sessionCache?: Storage;
  intentStorage?: Storage;
  clearSession?: () => Promise<unknown>;
}) {
  const [me, setMeState] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthState["status"]>("loading");

  const writes = useRef(Promise.resolve());
  const persistMe = useCallback((m: Me | null) => {
    writes.current = writes.current.then(async () => {
      if (m) await sessionCache?.setItem(ME_CACHE_KEY, JSON.stringify(m));
      else await sessionCache?.removeItem(ME_CACHE_KEY);
    }).catch(() => {});
  }, [sessionCache]);
  const signedOut = useRef(false);
  const transitioning = useRef(false);
  const pendingLogout = useRef<Promise<void> | null>(null);
  const mutations = useRef(Promise.resolve());


  // A refresh already in flight is shared rather than duplicated, and every
  // result is checked against the latest token before it writes state — two
  // concurrent refreshes used to race, and the loser could overwrite newer
  // state with its own stale answer.
  const inFlightRef = useRef<Promise<void> | null>(null);
  const refreshTokenRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const invalidate = useCallback(() => {
    refreshTokenRef.current += 1;
    inFlightRef.current = null;
    advanceAuthGeneration();
    return refreshTokenRef.current;
  }, []);

  const runRefresh = useCallback(async () => {
    if (transitioning.current) return;
    const token = ++refreshTokenRef.current;
    const isCurrent = () => mountedRef.current && token === refreshTokenRef.current;
    let intent: string | null | undefined;
    try {
      await writes.current;
      intent = await intentStorage?.getItem(SIGNED_OUT_KEY);
    } catch {
      // An unreadable intent cannot prove it is safe to recover a cookie.
      if (isCurrent()) { setMeState(null); setStatus("guest"); }
      return;
    }
    try {
      if (!isCurrent()) return;
      if (signedOut.current || intent === "1") {
        signedOut.current = true;
        setMeState(null);
        setStatus("guest");
        return;
      }
      const m = await api.me();
      if (!isCurrent()) return;
      setMeState(m);
      setStatus("authed");
      persistMe(m);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Ignore a response from a refresh that started before login or
        // registration established a newer session. Only the current refresh
        // can prove that the current session is dead.
        if (!isCurrent()) return;
        persistMe(null);
        setMeState(null);
        setStatus("guest");
        return;
      }
      if (!isCurrent()) return;
      // Network error, proxy 5xx, timeout: fall back to the cached session so
      // an offline cold launch stays signed in.
      let cached: Me | null = null;
      try {
        const raw = await sessionCache?.getItem(ME_CACHE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Me;
          if (parsed && typeof parsed === "object") cached = parsed;
        }
      } catch {
        // Unreadable/corrupt cache — treat as no cached session.
      }
      if (!isCurrent()) return;
      if (cached) {
        setMeState(cached);
        setStatus("authed");
      } else {
        setMeState(null);
        setStatus("guest");
      }
    }
  }, [persistMe, sessionCache, intentStorage]);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current;
    const pending = runRefresh().finally(() => {
      if (inFlightRef.current === pending) inFlightRef.current = null;
    });
    inFlightRef.current = pending;
    return pending;
  }, [runRefresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Central 401 hook: any request anywhere that gets a 401 drops the cached
  // session, instead of each of ~100 call sites handling expiry ad hoc.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      persistMe(null);
      invalidate();
      transitioning.current = false;
      if (!mountedRef.current) return;
      setMeState(null);
      setStatus("guest");
    });
    return () => setUnauthorizedHandler(null);
  }, [persistMe, invalidate]);

  // Serialize cookie-changing requests as well as guarding React state:
  // an older login response must never install a cookie after logout finishes.
  const login = useCallback((username: string, password: string) => {
    const token = invalidate();
    transitioning.current = true;
    const pending = mutations.current.then(async () => {
      const m = await api.login(username, password);
      if (token !== refreshTokenRef.current || !mountedRef.current) return m;
      await writes.current;
      await intentStorage?.removeItem(SIGNED_OUT_KEY);
      if (token !== refreshTokenRef.current || !mountedRef.current) return m;
      signedOut.current = false;
      setMeState(m);
      setStatus("authed");
      persistMe(m);
      return m;
    }).finally(() => {
      if (token === refreshTokenRef.current) transitioning.current = false;
    });
    mutations.current = pending.then(() => {}, () => {});
    return pending;
  }, [persistMe, intentStorage, invalidate]);

  const logout = useCallback(() => {
    if (pendingLogout.current) return pendingLogout.current;
    const token = invalidate();
    transitioning.current = true;
    const pending = mutations.current.then(async () => {
      let durable = false;
      await writes.current;
      try {
        if (intentStorage) {
          await intentStorage.setItem(SIGNED_OUT_KEY, "1");
          durable = true;
        }
      } catch { /* Require successful server revocation if storage is unavailable. */ }
      try {
        await api.logout();
      } catch (error) {
        if (!durable && !(error instanceof ApiError && error.status === 401)) throw error;
      }
      signedOut.current = true;
      try { await clearSession?.(); } catch { /* Revocation or durable intent still protects the session. */ }
      if (token !== refreshTokenRef.current || !mountedRef.current) return;
      setMeState(null);
      setStatus("guest");
      persistMe(null);
    }).finally(() => {
      if (pendingLogout.current === pending) pendingLogout.current = null;
      if (token === refreshTokenRef.current) transitioning.current = false;
    });
    pendingLogout.current = pending;
    mutations.current = pending.catch(() => {});
    return pending;
  }, [persistMe, intentStorage, clearSession, invalidate]);

  // Adopt a user returned by a request that also established the session (for
  // example registration). Keep identity, status, and the offline cache atomic
  // so callers do not need a second /me request just to become authenticated.
  const setMe = useCallback(
    (m: Me | null) => {
      // A pre-session refresh may still be in flight while registration returns.
      // Invalidate it so its older /me result cannot overwrite this new session.
      invalidate();
      transitioning.current = false;
      signedOut.current = !m;
      writes.current = writes.current.then(async () => {
        if (m) await intentStorage?.removeItem(SIGNED_OUT_KEY);
        else await intentStorage?.setItem(SIGNED_OUT_KEY, "1");
      }).catch(() => {});
      setMeState(m);
      setStatus(m ? "authed" : "guest");
      persistMe(m);
    },
    [persistMe, intentStorage, invalidate],
  );

  const value = useMemo<AuthState>(
    () => ({ status, me, refresh, login, logout, setMe }),
    [status, me, refresh, login, logout, setMe],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
