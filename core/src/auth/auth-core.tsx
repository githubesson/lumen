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

export interface AuthState {
  status: "loading" | "guest" | "authed";
  me: Me | null;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  setMe: (me: Me | null) => void;
}

const AuthCtx = createContext<AuthState | null>(null);

/**
 * Platform-agnostic auth provider. Drives the session-cookie auth dance:
 * calls `api.me()` on mount, and exposes login/logout helpers. Reusable
 * on both web (session cookie from the browser jar) and iOS (cookie
 * persisted via `@react-native-cookies/cookies`).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthState["status"]>("loading");

  const refresh = useCallback(async () => {
    try {
      const m = await api.me();
      setMe(m);
      setStatus("authed");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMe(null);
        setStatus("guest");
        return;
      }
      setMe(null);
      setStatus("guest");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const m = await api.login(username, password);
    setMe(m);
    setStatus("authed");
    return m;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setMe(null);
      setStatus("guest");
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ status, me, refresh, login, logout, setMe }),
    [status, me, refresh, login, logout],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
