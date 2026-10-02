import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TidalArtistDetailView } from "../src/pages/library/ArtistDetail";

const mock = vi.hoisted(() => ({ artist: vi.fn() }));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: { getTidalArtist: mock.artist },
}));
vi.mock("../src/components/TrackList", () => ({
  default: ({ tracks }: { tracks: { title: string }[] }) => (
    <div>{tracks.map((t) => t.title).join(", ")}</div>
  ),
}));
vi.mock("../src/context/Player", () => ({
  usePlayer: () => ({
    play: vi.fn(),
    toggle: vi.fn(),
    toggleShuffle: vi.fn(),
    current: null,
    isPlaying: false,
    shuffle: false,
  }),
  useRemotePlayback: () => ({
    targetDevice: null,
    commandPending: false,
  }),
}));

beforeEach(() => {
  mock.artist.mockReset();
});
afterEach(cleanup);
const empty = { albums: [], tracks: [] };
const show = async () => {
  const view = render(
    <TidalArtistDetailView
      id="123"
      name="Artist"
      onBack={() => {}}
      onOpenAlbum={() => {}}
    />,
  );
  await act(async () => {});
  return view;
};

it("shows total failure and retries to a confirmed empty result", async () => {
  mock.artist
    .mockRejectedValueOnce(new Error("upstream"))
    .mockResolvedValueOnce(empty);
  await show();
  expect(screen.getByRole("alert").textContent).toBe("Couldn't load artist.");
  expect(screen.queryByText("No releases found.")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry artist" }));
  });
  expect(mock.artist).toHaveBeenCalledTimes(2);
  expect(screen.getByText("No releases found.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("preserves partial results through a failed retry and clears warnings after recovery", async () => {
  mock.artist
    .mockResolvedValueOnce({
      albums: [{ id: "tidal:1", title: "Available album" }],
      tracks: [],
      warnings: ["Couldn't load singles and EPs."],
    })
    .mockRejectedValueOnce(new Error("upstream"))
    .mockResolvedValueOnce({
      albums: [
        { id: "tidal:1", title: "Available album" },
        { id: "tidal:2", title: "Recovered single" },
      ],
      tracks: [],
    });
  await show();
  expect(screen.getByText("Available album")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe(
    "Couldn't load singles and EPs.",
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry artist" }));
  });
  expect(screen.getByText("Available album")).toBeTruthy();
  expect(screen.getByText("Couldn't load artist.")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry artist" }));
  });
  expect(screen.getByText("Recovered single")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry artist" })).toBeNull();
});

it("does not label incomplete empty results as empty and disables an active retry", async () => {
  let finish!: (result: typeof empty) => void;
  mock.artist
    .mockResolvedValueOnce({ ...empty, warnings: ["Couldn't load albums."] })
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
  await show();
  expect(screen.queryByText("No releases found.")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry artist" }));
  });
  expect(
    (screen.getByRole("button", { name: "Retrying…" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryByText("No releases found.")).toBeNull();
  await act(async () => {
    finish(empty);
  });
  expect(screen.getByText("No releases found.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("replaces the link name and cover fallback with the loaded profile", async () => {
  const track = { id: "tidal:t1", title: "Hit", duration_ms: 1000, cover_url: "/track-cover.jpg" };
  mock.artist
    .mockResolvedValueOnce({ ...empty, tracks: [track] })
    .mockResolvedValueOnce({
      ...empty,
      tracks: [track],
      artist: { name: "Profile Name", cover_url: "/api/covers/remote?url=artist" },
    });
  const avatar = () =>
    document.querySelector(".artist-hero-avatar img")?.getAttribute("src");
  const heading = () => screen.getByRole("heading", { level: 1 }).textContent;

  const first = await show();
  expect(heading()).toBe("Artist");
  expect(avatar()).toBe("/track-cover.jpg");
  first.unmount();

  await show();
  expect(heading()).toBe("Profile Name");
  expect(avatar()).toBe("/api/covers/remote?url=artist");
});

it("previews five popular tracks and files releases newest first by kind", async () => {
  mock.artist.mockResolvedValueOnce({
    tracks: Array.from({ length: 7 }, (_, i) => ({
      id: `tidal:t${i + 1}`,
      title: `Track ${i + 1}`,
      duration_ms: 1000,
    })),
    albums: [
      { id: "tidal:1", title: "Old album", release_year: 2020, track_count: 12, duration_ms: 45 * 60_000 },
      { id: "tidal:2", title: "New single", release_year: 2024, track_count: 1, duration_ms: 3 * 60_000 },
      { id: "tidal:3", title: "Long EP-sized", release_year: 2022, track_count: 5, duration_ms: 34 * 60_000 },
      { id: "tidal:4", title: "Short EP", release_year: 2022, track_count: 5, duration_ms: 18 * 60_000 },
    ],
  });
  const view = await show();
  const cards = () =>
    [...view.container.querySelectorAll(".card")].map(
      (card) =>
        `${card.querySelector(".card-title")?.textContent} | ${card.querySelector(".card-sub")?.textContent}`,
    );
  expect(screen.getByText("Track 1, Track 2, Track 3, Track 4, Track 5")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "See more" }));
  expect(screen.getByText(/, Track 7$/)).toBeTruthy();
  expect(cards()).toEqual([
    "New single | 2024 · Single",
    "Long EP-sized | 2022 · Album",
    "Short EP | 2022 · EP",
    "Old album | 2020 · Album",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Singles and EPs" }));
  expect(cards()).toEqual(["New single | 2024 · Single", "Short EP | 2022 · EP"]);
});

it("drops a release filter that a retry makes unavailable", async () => {
  const lp = { id: "tidal:1", title: "LP", release_year: 2020, track_count: 12, duration_ms: 45 * 60_000 };
  const single = { id: "tidal:2", title: "Single", release_year: 2024, track_count: 1, duration_ms: 3 * 60_000 };
  mock.artist
    .mockResolvedValueOnce({ albums: [lp, single], tracks: [], warnings: ["Couldn't load top songs."] })
    .mockResolvedValueOnce({ albums: [lp], tracks: [] });
  const view = await show();
  const titles = () =>
    [...view.container.querySelectorAll(".card-title")].map((title) => title.textContent);
  fireEvent.click(screen.getByRole("button", { name: "Singles and EPs" }));
  expect(titles()).toEqual(["Single"]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry artist" }));
  });
  expect(screen.queryByRole("button", { name: "Singles and EPs" })).toBeNull();
  expect(titles()).toEqual(["LP"]);
});

it("aborts artist requests when leaving the screen", async () => {
  mock.artist.mockReturnValue(new Promise(() => {}));
  const view = await show();
  const signal = mock.artist.mock.calls[0][1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});
