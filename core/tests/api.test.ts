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
