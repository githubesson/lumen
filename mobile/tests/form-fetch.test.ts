import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@music-library/core";
import { formFetch } from "../lib/form-fetch";

const h = vi.hoisted(() => ({
  present: new Set<string>(),
  unparseable: new Set<string>(),
  fetch: vi.fn(async (..._args: unknown[]) => new Response("{}")),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    constructor(private uri: string) {
      if (h.unparseable.has(uri)) throw new Error("invalid URI");
    }
    get exists() {
      return h.present.has(this.uri);
    }
  },
}));
vi.mock("whatwg-fetch", () => ({ fetch: h.fetch }));

type Part = { uri: string; name?: string } | { string: string };

/** A FormData shaped like React Native's, which lists its parts. */
function form(...parts: Part[]): FormData {
  return Object.assign(new FormData(), { getParts: () => parts });
}

describe("formFetch", () => {
  beforeEach(() => {
    h.present.clear();
    h.unparseable.clear();
    h.fetch.mockClear();
  });

  it("sends uploads whose files are on the device through React Native's fetch", async () => {
    h.present.add("file:///cache/cover.jpg");
    const init = { method: "PUT", body: form({ string: "x" }, { uri: "file:///cache/cover.jpg", name: "cover.jpg" }) };

    await formFetch("/api/albums/a1/cover", init);
    expect(h.fetch).toHaveBeenCalledWith("/api/albums/a1/cover", init);
  });

  it("refuses an upload whose file has gone, instead of sending a request iOS never answers", async () => {
    const init = { method: "POST", body: form({ uri: "file:///cache/IMG_1.jpg", name: "IMG_1.jpg" }) };

    const err = await formFetch("/api/tracks/t1/story-background", init).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("IMG_1.jpg is no longer on this device. Choose it again.");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("leaves URIs it can't check to React Native", async () => {
    h.unparseable.add("file:///odd");
    await formFetch("/api/library/upload", {
      method: "POST",
      body: form({ uri: "ph://asset-id" }, { uri: "file:///odd" }),
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
