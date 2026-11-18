import { beforeEach, expect, it, vi } from "vitest";
import type { SearchAlbum, TrackListItem } from "@music-library/core";
import { useLibraryMoreBy, useTidalMoreBy } from "../lib/album-more-by";

const q = vi.hoisted(() => ({
  options: undefined as { queryKey: unknown[]; enabled?: boolean; staleTime?: number } | undefined,
  data: undefined as unknown,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: (fn: () => unknown) => fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: NonNullable<typeof q.options>) => {
    q.options = options;
    return { data: options.enabled ? q.data : undefined };
  },
}));
vi.mock("@music-library/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@music-library/core")>()),
  api: {},
  useAuth: () => ({ me: { id: "me" } }),
}));

beforeEach(() => {
  q.options = undefined;
  q.data = undefined;
});

const track = (album: number): TrackListItem => ({
  id: `t${album}`,
  title: "x",
  duration_ms: 1000,
  album_id: `a${album}`,
  album_title: `Album ${album}`,
});

it("waits for the page's end before asking for the artist's tracks, then lists the other albums", () => {
  q.data = Array.from({ length: 20 }, (_, i) => track(i));
  expect(useLibraryMoreBy("artist", "a3", false)).toEqual([]);
  expect(q.options?.enabled).toBe(false);
  const releases = useLibraryMoreBy("artist", "a3", true);
  expect(q.options?.enabled).toBe(true);
  expect(q.options?.queryKey).toEqual(["user", "me", "artist-tracks", "artist"]);
  expect(q.options?.staleTime).toBe(5 * 60 * 1000);
  expect(releases).toHaveLength(12);
  expect(releases.map((release) => release.id)).not.toContain("a3");
});

it("asks nothing without an artist page", () => {
  useLibraryMoreBy(undefined, "a1", true);
  expect(q.options?.enabled).toBe(false);
});

const tidal = (id: string, title: string): SearchAlbum => ({
  id: `tidal:${id}`,
  source: "tidal",
  source_id: id,
  title,
  is_compilation: false,
  track_count: 10,
  duration_ms: 40 * 60_000,
  has_cover: true,
  release_year: 2020,
});

it("names the TIDAL artist and lists their other releases, without this one", () => {
  q.data = { artist: { name: "Dua Lipa" }, albums: [tidal("1", "Future Nostalgia"), tidal("2", "Radical Optimism")], tracks: [] };
  const more = useTidalMoreBy("77", "1");
  expect(q.options?.queryKey).toEqual(["user", "me", "tidal-artist", "77"]);
  expect(more.name).toBe("Dua Lipa");
  expect(more.releases.map((release) => release.source_id)).toEqual(["2"]);
});

it("keeps the releases when the artist profile is missing", () => {
  q.data = { albums: [tidal("1", "Future Nostalgia"), tidal("2", "Radical Optimism")], tracks: [] };
  const more = useTidalMoreBy("77", "1");
  expect(more.name).toBe("");
  expect(more.releases).toHaveLength(1);
});
