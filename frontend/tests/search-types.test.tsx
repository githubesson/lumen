import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Page, SearchResult } from "../src/api";
import Library from "../src/pages/Library";

const mock = vi.hoisted(() => ({
  search: vi.fn(),
  more: null as (() => void) | null,
}));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: { searchPage: mock.search },
}));
vi.mock("../src/context/Player", () => ({
  usePlayer: () => ({ play: vi.fn() }),
}));
vi.mock("../src/components/TrackList", () => ({
  default: ({ tracks }: { tracks: { title: string }[] }) => (
    <div>
      {tracks.map((track) => (
        <span key={track.title}>{track.title}</span>
      ))}
    </div>
  ),
}));
vi.mock("../src/pages/library/LibraryDetail", () => ({
  AlbumDetailView: ({ onBack }: { onBack: () => void }) => (
    <button onClick={onBack}>Back to results</button>
  ),
  ArtistDetailView: () => null,
  TidalAlbumDetailView: ({
    id,
    onBack,
  }: {
    id: string;
    onBack: () => void;
  }) => (
    <>
      <span>Remote album {id}</span>
      <button onClick={onBack}>Back to results</button>
    </>
  ),
}));

beforeEach(() => {
  mock.search.mockReset();
  mock.more = null;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        mock.more = () =>
          callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const album = {
  type: "album",
  item: {
    id: "tidal:42",
    source: "tidal",
    source_id: "42",
    title: "Found album",
    has_cover: false,
    is_compilation: false,
    duration_ms: 0,
    track_count: 12,
  },
} satisfies SearchResult;
const page = (items: SearchResult[], nextOffsets = {}): Page<SearchResult> => ({
  items,
  total: items.length,
  nextOffsets,
});

it("switches types without accepting stale results or carrying previous cursors", async () => {
  let finish!: (page: Page<SearchResult>) => void;
  mock.search
    .mockReturnValueOnce(
      new Promise<Page<SearchResult>>((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce(page([album], { tidal_album: 25 }))
    .mockResolvedValueOnce(page([]));
  render(
    <MemoryRouter initialEntries={["/library?q=hello"]}>
      <Library />
    </MemoryRouter>,
  );
  await act(async () => {});
  const firstSignal = mock.search.mock.calls[0][0].signal as AbortSignal;
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: "Albums" }));
  });
  expect(firstSignal.aborted).toBe(true);
  expect(mock.search.mock.calls[1][0]).toMatchObject({
    q: "hello",
    type: "album",
    offset: 0,
  });
  expect(mock.search.mock.calls[1][0].searchOffsets).toBeUndefined();
  await act(async () => {
    finish(
      page([
        {
          type: "track",
          item: {
            id: "stale",
            title: "Stale song",
            duration_ms: 0,
            has_cover: false,
            favorited: false,
            source: "local",
          },
        },
      ]),
    );
  });
  expect(screen.queryByText("Stale song")).toBeNull();
  expect(screen.getByText("Found album")).toBeTruthy();
  await act(async () => {
    mock.more?.();
  });
  expect(mock.search.mock.calls[2][0]).toMatchObject({
    type: "album",
    searchOffsets: { tidal_album: 25 },
  });
});

it("opens remote albums and keeps the query and filter when returning", async () => {
  mock.search.mockResolvedValue(page([album]));
  render(
    <MemoryRouter initialEntries={["/library?q=hello&type=album"]}>
      <Library />
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Found album/ }));
  });
  expect(screen.getByText("Remote album 42")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Back to results" }));
  });
  expect(screen.getByRole("searchbox").getAttribute("value")).toBe("hello");
  expect(
    screen.getByRole("tab", { name: "Albums" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(mock.search.mock.lastCall?.[0]).toMatchObject({
    q: "hello",
    type: "album",
  });
});

it("uses explicit remote artwork even when the local cover flag is false", async () => {
  mock.search.mockResolvedValue(
    page([
      {
        ...album,
        item: { ...album.item, cover_url: "/api/tidal/cover?url=fixture" },
      },
    ]),
  );
  const { container } = render(
    <MemoryRouter initialEntries={["/library?q=hello&type=album"]}>
      <Library />
    </MemoryRouter>,
  );
  await act(async () => {});
  expect(container.querySelector(".card-art img")?.getAttribute("src")).toBe(
    "/api/tidal/cover?url=fixture",
  );
});

it("does not confirm an empty search while a stream failed, and retries", async () => {
  mock.search
    .mockResolvedValueOnce({
      ...page([]),
      warnings: ["TIDAL album search is unavailable."],
    })
    .mockResolvedValueOnce(page([]));
  render(
    <MemoryRouter initialEntries={["/library?q=hello"]}>
      <Library />
    </MemoryRouter>,
  );
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toBe(
    "TIDAL album search is unavailable.",
  );
  expect(screen.queryByText("No matching results.")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry search" }));
  });
  expect(screen.getByText("No matching results.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
