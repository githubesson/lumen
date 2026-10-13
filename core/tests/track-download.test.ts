import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setUnauthorizedHandler, type TrackDetail, type TrackListItem } from "../src/api";
import { extensionFromStream, prepareTrackDownload } from "../src/audio-format";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

const track: TrackListItem = { id: "t1", title: "Row Title", artist: "Row Artist", duration_ms: 1 };

function detail(overrides: Partial<TrackDetail> = {}): TrackDetail {
  return {
    id: "t1",
    source: "local",
    title: "Song",
    duration_ms: 1,
    format: "FLAC",
    file_size: 1,
    artists: [
      { id: "a", name: "A", role: "primary" },
      { id: "b", name: "B", role: "featured" },
    ],
    has_cover: true,
    favorited: false,
    ...overrides,
  };
}

describe("prepareTrackDownload", () => {
  it("names the file from the detail and its stored format", async () => {
    vi.spyOn(api, "getTrack").mockResolvedValue(detail());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(prepareTrackDownload(track)).resolves.toMatchObject({
      ext: "flac",
      filename: "A, B - Song.flac",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the stream for an unrecognized format", async () => {
    vi.spyOn(api, "getTrack").mockResolvedValue(detail({ format: "weird" }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { headers: { "content-type": "audio/mpeg" } })),
    );
    await expect(prepareTrackDownload(track)).resolves.toMatchObject({
      ext: "mp3",
      filename: "A, B - Song.mp3",
    });
  });

  it("still names the file from the row when the detail read fails", async () => {
    vi.spyOn(api, "getTrack").mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(prepareTrackDownload(track)).resolves.toEqual({
      detail: null,
      ext: undefined,
      filename: "Row Artist - Row Title",
    });
  });
});

describe("extensionFromStream", () => {
  it("gives up on a stalled HEAD at the request deadline and tries a range", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      init.method === "HEAD"
        ? new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })
        : Promise.resolve(new Response("x", { status: 206, headers: { "content-type": "audio/flac" } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ext = extensionFromStream("t1");
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(ext).resolves.toBe("flac");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tracks/t1/stream",
      expect.objectContaining({ credentials: "include", headers: expect.objectContaining({ Range: "bytes=0-0" }) }),
    );
  });

  it("does not sign the user out when the probe is refused", async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(extensionFromStream("t1")).resolves.toBeUndefined();
    expect(unauthorized).not.toHaveBeenCalled();
  });
});
