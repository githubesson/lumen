import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TidalArtistResults } from "../src/pages/library/SearchResults";

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
vi.mock("../src/pages/library/EntityCards", () => ({
  AlbumCard: ({ album }: { album: { title: string } }) => (
    <div>{album.title}</div>
  ),
  ArtistCard: () => null,
}));

beforeEach(() => {
  mock.artist.mockReset();
});
afterEach(cleanup);
const empty = { albums: [], tracks: [] };
const show = async () => {
  const view = render(
    <TidalArtistResults
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

it("aborts artist requests when leaving the screen", async () => {
  mock.artist.mockReturnValue(new Promise(() => {}));
  const view = await show();
  const signal = mock.artist.mock.calls[0][1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});
