// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ReactNode } from "react";
import { ApiError, type Me } from "../src/api";
import { AuthProvider, useAuth } from "../src/auth/auth-core";
import type { Storage } from "../src/storage";

const h = vi.hoisted(() => ({
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      me: h.me,
      login: h.login,
      logout: h.logout,
    },
  };
});

const registeredUser: Me = {
  id: "registered-user",
  username: "new-user",
  role: "user",
  must_reset_password: false,
};

const staleUser: Me = {
  id: "stale-user",
  username: "stale-user",
  role: "admin",
  must_reset_password: false,
};

describe("AuthProvider setMe", () => {
  let resolveInitialRefresh!: (me: Me) => void;
  let rejectInitialRefresh!: (error: unknown) => void;
  let storage: Storage;

  beforeEach(() => {
    h.me.mockReset();
    h.login.mockReset().mockResolvedValue(registeredUser);
    h.logout.mockReset().mockResolvedValue(undefined);
    h.me.mockImplementation(
      () =>
        new Promise<Me>((resolve, reject) => {
          resolveInitialRefresh = resolve;
          rejectInitialRefresh = reject;
        }),
    );
    storage = {
      getItem: vi.fn(async () => null),
      setItem: vi.fn(async () => {}),
      removeItem: vi.fn(async () => {}),
    };
  });

  it("adopts a registered user atomically and ignores an older refresh", async () => {
    function Wrapper({ children }: { children: ReactNode }) {
      return <AuthProvider sessionCache={storage}>{children}</AuthProvider>;
    }

    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
    await act(async () => {});
    expect(result.current.status).toBe("loading");

    act(() => result.current.setMe(registeredUser));
    expect(result.current.status).toBe("authed");
    expect(result.current.me).toEqual(registeredUser);
    await act(async () => {});
    expect(storage.setItem).toHaveBeenCalledWith(
      "auth.me.v1",
      JSON.stringify(registeredUser),
    );

    await act(async () => {
      resolveInitialRefresh(staleUser);
      await Promise.resolve();
    });
    expect(result.current.status).toBe("authed");
    expect(result.current.me).toEqual(registeredUser);
  });

  it("ignores an older refresh that rejects after registration", async () => {
    function Wrapper({ children }: { children: ReactNode }) {
      return <AuthProvider sessionCache={storage}>{children}</AuthProvider>;
    }

    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
    await act(async () => {});
    act(() => result.current.setMe(registeredUser));

    await act(async () => {
      rejectInitialRefresh(new ApiError(401, "unauthorized"));
      await Promise.resolve();
    });

    expect(result.current.status).toBe("authed");
    expect(result.current.me).toEqual(registeredUser);
    expect(storage.removeItem).not.toHaveBeenCalledWith("auth.me.v1");
  });

  it("moves to guest when the current refresh is unauthorized", async () => {
    function Wrapper({ children }: { children: ReactNode }) {
      return <AuthProvider sessionCache={storage}>{children}</AuthProvider>;
    }

    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
    await act(async () => {});

    await act(async () => {
      rejectInitialRefresh(new ApiError(401, "unauthorized"));
      await Promise.resolve();
    });

    expect(result.current.status).toBe("guest");
    expect(result.current.me).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith("auth.me.v1");
  });

  it("moves to guest and clears the cache when given null", async () => {
    function Wrapper({ children }: { children: ReactNode }) {
      return <AuthProvider sessionCache={storage}>{children}</AuthProvider>;
    }

    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
    await act(async () => {});
    act(() => result.current.setMe(registeredUser));
    await act(async () => result.current.setMe(null));

    expect(result.current.status).toBe("guest");
    expect(result.current.me).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith("auth.me.v1");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("auth transitions", () => {
  let kv: Map<string, string>;
  let storage: Storage;
  beforeEach(() => {
    kv = new Map();
    storage = {
      async getItem(key) { return kv.get(key) ?? null; },
      async setItem(key, value) { kv.set(key, value); },
      async removeItem(key) { kv.delete(key); },
    };
    h.me.mockReset().mockResolvedValue(staleUser);
    h.login.mockReset().mockResolvedValue(registeredUser);
    h.logout.mockReset().mockResolvedValue(undefined);
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <AuthProvider sessionCache={storage}>{children}</AuthProvider>;
  }

  it("ignores a /me response that arrives after login", async () => {
    const old = deferred<Me>();
    h.me.mockReturnValueOnce(old.promise);
    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
    await act(async () => {});
    await act(async () => { await result.current.login("new", "password"); });
    await act(async () => old.resolve(staleUser));
    expect(result.current.me).toEqual(registeredUser);
    expect(JSON.parse(kv.get("auth.me.v1")!)).toEqual(registeredUser);
  });

  it("ignores an outstanding refresh after logout", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
    await act(async () => {});
    const old = deferred<Me>();
    h.me.mockReturnValueOnce(old.promise);
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.refresh(); });
    await act(async () => {});
    await act(async () => result.current.logout());
    await act(async () => { old.resolve(staleUser); await refresh; });
    expect(result.current.status).toBe("guest");
    expect(kv.has("auth.me.v1")).toBe(false);
  });

  it("preserves offline logout across refresh and cold launch despite a surviving cookie", async () => {
    const first = renderHook(() => useAuth(), { wrapper: Wrapper });
    await act(async () => {});
    h.logout.mockRejectedValueOnce(new TypeError("offline"));
    await act(async () => first.result.current.logout());
    expect(first.result.current.status).toBe("guest");
    await act(async () => first.result.current.refresh());
    first.unmount();
    const second = renderHook(() => useAuth(), { wrapper: Wrapper });
    await act(async () => {});
    expect(second.result.current.status).toBe("guest");
    expect(h.me).toHaveBeenCalledTimes(1);
    await act(async () => { await second.result.current.login("new", "password"); });
    expect(second.result.current.me).toEqual(registeredUser);
    expect(kv.has("auth.signed-out.v1")).toBe(false);
  });

  it("revokes the cookie only after a preceding login request finishes", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
    await act(async () => {});
    const delayedLogin = deferred<Me>();
    h.login.mockReturnValueOnce(delayedLogin.promise);
    let login!: Promise<Me>;
    let logout!: Promise<void>;
    act(() => { login = result.current.login("new", "password"); });
    await act(async () => {});
    act(() => { logout = result.current.logout(); });
    await act(async () => {});
    expect(h.logout).not.toHaveBeenCalled();
    await act(async () => { delayedLogin.resolve(registeredUser); await login; await logout; });
    expect(h.logout).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("guest");
  });

  it("keeps the current identity if neither storage nor server can complete logout", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
    await act(async () => {});
    storage.setItem = async () => { throw new Error("storage unavailable"); };
    h.logout.mockRejectedValueOnce(new TypeError("offline"));
    await act(async () => { await expect(result.current.logout()).rejects.toThrow("offline"); });
    expect(h.logout).toHaveBeenCalledOnce();
    expect(result.current.me).toEqual(staleUser);
  });
});
