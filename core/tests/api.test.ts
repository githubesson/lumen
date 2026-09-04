import { advanceAuthGeneration } from "../src/api-transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  createTrackShareLink,
  getPublicTrackShare,
  resolveCoverUrl,
  setBaseUrl,
  setUnauthorizedHandler,
} from "../src/api";

describe("share snippet requests", () => {
  afterEach(() => {
    setBaseUrl("");
    vi.unstubAllGlobals();
  });

  it("sends the selected duration when creating a link", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      url: "https://lumen.test/share/track/1?t=12&d=75&sig=x",
      start_sec: 12,
      duration_sec: 75,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createTrackShareLink("track/id", 12.9, 75.9);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tracks/track%2Fid/share?t=12&d=75",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("preserves legacy public links that have no duration field", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await getPublicTrackShare("track-1", 12, "legacy-signature");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/public/share/track/track-1?t=12&sig=legacy-signature",
      expect.any(Object),
    );
  });

  it("sends duration when resolving a new public link", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await getPublicTrackShare("track-1", 12, "signature", 75);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/public/share/track/track-1?t=12&sig=signature&d=75",
      expect.any(Object),
    );
  });
});

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

describe("search continuation and library sort", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("continues only the nonexhausted source using its own offset", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ tracks: [{ id: "local-1" }, { id: "tidal:1" }], next_offsets: { tidal: 50 } }))
      .mockResolvedValueOnce(Response.json({ tracks: [{ id: "tidal:2" }], next_offsets: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await api.searchTracksPage({ q: "song", limit: 50 });
    const second = await api.searchTracksPage({ q: "song", limit: 50, offset: first.items.length, searchOffsets: first.nextOffsets });
    const url = new URL(fetchMock.mock.calls[1][0], "https://test.invalid");
    expect(url.searchParams.get("sources")).toBe("tidal");
    expect(url.searchParams.get("tidal_offset")).toBe("50");
    expect(url.searchParams.has("local_offset")).toBe(false);
    expect(second.nextOffsets).toEqual({});
    expect(second.total).toBe(3);
  });
  it("sends the sort choice with every page request", async () => {
    const fetchMock = vi.fn(async () => Response.json([], { headers: { "X-Total-Count": "101" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.listTracksPage({ limit: 100, offset: 100, sort: "title" });
    expect(fetchMock).toHaveBeenCalledWith("/api/tracks?limit=100&offset=100&sort=title", expect.any(Object));
  });
});


describe("stale unauthorized responses", () => {
  afterEach(() => { setUnauthorizedHandler(null); vi.unstubAllGlobals(); });
  it("does not expire a newer session when an old request returns 401", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(r => { resolve = r; })));
    const expired = vi.fn();
    setUnauthorizedHandler(expired);
    const request = api.listInvites();
    advanceAuthGeneration();
    resolve(new Response("unauthorized", { status: 401 }));
    await expect(request).rejects.toMatchObject({ status: 401 });
    expect(expired).not.toHaveBeenCalled();
  });
  it("leaves login/logout rejection handling to their own auth transition", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const expired = vi.fn();
    setUnauthorizedHandler(expired);
    await expect(api.login("user", "wrong")).rejects.toMatchObject({ status: 401 });
    await expect(api.logout()).rejects.toMatchObject({ status: 401 });
    expect(expired).not.toHaveBeenCalled();
  });
});
