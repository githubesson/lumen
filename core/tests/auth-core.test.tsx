// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ReactNode } from "react";
import { ApiError, type Me } from "../src/api";
import { AuthProvider, useAuth } from "../src/auth/auth-core";
import type { Storage } from "../src/storage";

const h = vi.hoisted(() => ({
  me: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      me: h.me,
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
    expect(result.current.status).toBe("loading");

    act(() => result.current.setMe(registeredUser));
    expect(result.current.status).toBe("authed");
    expect(result.current.me).toEqual(registeredUser);
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
    act(() => result.current.setMe(registeredUser));

    await act(async () => {
      rejectInitialRefresh(new ApiError(401, "unauthorized"));
      await Promise.resolve();
    });

    expect(result.current.status).toBe("authed");
    expect(result.current.me).toEqual(registeredUser);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("moves to guest when the current refresh is unauthorized", async () => {
    function Wrapper({ children }: { children: ReactNode }) {
      return <AuthProvider sessionCache={storage}>{children}</AuthProvider>;
    }

    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });

    await act(async () => {
      rejectInitialRefresh(new ApiError(401, "unauthorized"));
      await Promise.resolve();
    });

    expect(result.current.status).toBe("guest");
    expect(result.current.me).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith("auth.me.v1");
  });

  it("moves to guest and clears the cache when given null", () => {
    function Wrapper({ children }: { children: ReactNode }) {
      return <AuthProvider sessionCache={storage}>{children}</AuthProvider>;
    }

    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
    act(() => result.current.setMe(registeredUser));
    act(() => result.current.setMe(null));

    expect(result.current.status).toBe("guest");
    expect(result.current.me).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith("auth.me.v1");
  });
});
