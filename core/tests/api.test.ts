import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  resolveCoverUrl,
  setBaseUrl,
  setUnauthorizedHandler,
} from "../src/api";

describe("API unauthorized handling", () => {
  afterEach(() => {
    setUnauthorizedHandler(null);
    setBaseUrl("");
    vi.unstubAllGlobals();
  });

  it("lets the auth refresh own unauthorized /me responses", async () => {
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn(async () =>
      new Response("unauthorized", { status: 401 }),
    );
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.me()).rejects.toMatchObject({ status: 401 });

    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("still reports unauthorized responses from other endpoints", async () => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    setUnauthorizedHandler(onUnauthorized);

    await expect(api.listInvites()).rejects.toMatchObject({ status: 401 });

    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

describe("cover URL resolution", () => {
  afterEach(() => {
    setBaseUrl("");
  });

  it("makes backend proxy paths absolute for native image loaders", () => {
    setBaseUrl("https://music.example/");

    expect(resolveCoverUrl("/api/covers/remote?url=tidal")).toBe(
      "https://music.example/api/covers/remote?url=tidal",
    );
  });

  it("preserves absolute upstream artwork URLs", () => {
    setBaseUrl("https://music.example");

    expect(resolveCoverUrl("https://resources.tidal.com/cover.jpg")).toBe(
      "https://resources.tidal.com/cover.jpg",
    );
  });
});

describe("TIDAL account management", () => {
  afterEach(() => {
    vi.useRealTimers();
    setBaseUrl("");
    vi.unstubAllGlobals();
  });

  it("starts and polls an encoded device-auth flow", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            flow_id: "flow/with/slashes",
            verification_url: "https://link.tidal.com/example",
            expires_at: "2026-08-13T12:00:00Z",
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ state: "pending" }));
    vi.stubGlobal("fetch", fetchMock);

    const flow = await api.startTidalAuth();
    await expect(api.pollTidalAuth(flow.flow_id)).resolves.toEqual({
      state: "pending",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/tidal/auth",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/tidal/auth/flow%2Fwith%2Fslashes",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("removes an encoded account id", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.removeTidalAccount("account/id");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/tidal/accounts/account%2Fid",
      expect.objectContaining({ method: "DELETE", credentials: "include" }),
    );
  });

  it("waits until device authorization leaves the pending state", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ state: "pending" }))
      .mockResolvedValueOnce(
        Response.json({
          state: "linked",
          account: { id: "account-1", user_id: "42", removable: true },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = api.waitForTidalAuthorization("flow-1", {
      intervalMs: 500,
    });
    await vi.advanceTimersByTimeAsync(500);

    await expect(resultPromise).resolves.toMatchObject({
      state: "linked",
      account: { user_id: "42" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
