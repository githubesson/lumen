import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, type Me } from "../api";
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

  const refresh = useCallback(async () => {
    try {
      const m = await api.me();
      setMeState(m);
      setStatus("authed");
      persistMe(m);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // The server explicitly rejected the session — it is dead.
        persistMe(null);
        setMeState(null);
        setStatus("guest");
        return;
      }
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
      if (cached) {
        setMeState(cached);
        setStatus("authed");
      } else {
        setMeState(null);
        setStatus("guest");
      }
    }
  }, [persistMe, sessionCache]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  // Same signature as the raw state setter, but keeps the cache in sync.
  const setMe = useCallback(
    (m: Me | null) => {
      setMeState(m);
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
