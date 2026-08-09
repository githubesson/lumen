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
}: {
  children: ReactNode;
  sessionCache?: Storage;
}) {
  const [me, setMeState] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthState["status"]>("loading");

  const persistMe = useCallback(
    (m: Me | null) => {
      // Best-effort: an unwritable cache only degrades offline launches.
      if (m) void sessionCache?.setItem(ME_CACHE_KEY, JSON.stringify(m)).catch(() => {});
      else void sessionCache?.removeItem(ME_CACHE_KEY).catch(() => {});
    },
    [sessionCache],
  );

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

  const runRefresh = useCallback(async () => {
    const token = ++refreshTokenRef.current;
    const isCurrent = () => mountedRef.current && token === refreshTokenRef.current;
    try {
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
  }, [persistMe, sessionCache]);

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
      refreshTokenRef.current += 1;
      if (!mountedRef.current) return;
      setMeState(null);
      setStatus("guest");
    });
    return () => setUnauthorizedHandler(null);
  }, [persistMe]);

  const login = useCallback(
    async (username: string, password: string) => {
      const m = await api.login(username, password);
      setMeState(m);
      setStatus("authed");
      persistMe(m);
      return m;
    },
    [persistMe],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setMeState(null);
      setStatus("guest");
      persistMe(null);
    }
  }, [persistMe]);

  // Adopt a user returned by a request that also established the session (for
  // example registration). Keep identity, status, and the offline cache atomic
  // so callers do not need a second /me request just to become authenticated.
  const setMe = useCallback(
    (m: Me | null) => {
      // A pre-session refresh may still be in flight while registration returns.
      // Invalidate it so its older /me result cannot overwrite this new session.
      refreshTokenRef.current += 1;
      inFlightRef.current = null;
      setMeState(m);
      setStatus(m ? "authed" : "guest");
      persistMe(m);
    },
    [persistMe],
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
