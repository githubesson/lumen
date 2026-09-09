import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import CommandPalette from "../src/components/CommandPalette";

const mock = vi.hoisted(() => ({ search: vi.fn(), close: vi.fn() }));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: { search: mock.search },
}));
vi.mock("../src/context/Auth", () => ({
  useAuth: () => ({ me: { role: "user" }, logout: vi.fn() }),
}));
vi.mock("../src/context/Theme", () => ({
  useTheme: () => ({ theme: "light", toggle: vi.fn() }),
}));
vi.mock("../src/context/Player", () => ({
  usePlayer: () => ({ play: vi.fn() }),
  useRemotePlayback: () => ({}),
}));
vi.mock("../src/components/TrackContextMenu", () => ({
  useTrackContextMenu: () => ({ bind: vi.fn(), close: vi.fn(), menu: null }),
}));

function Location() {
  return <output>{useLocation().search}</output>;
}
beforeEach(() => {
  mock.search.mockReset();
  mock.close.mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function openPalette() {
  render(
    <MemoryRouter>
      <Location />
      <CommandPalette
        open
        onOpenChange={mock.close}
        playlists={[]}
        pendingInvites={0}
        onOpenTweaks={() => {}}
        onOpenUpload={() => {}}
      />
    </MemoryRouter>,
  );
}

it("cancels the old command search when its type changes and preserves input focus", async () => {
  let finish!: (value: unknown) => void;
  mock.search
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue({
      tracks: [],
      albums: [
        {
          id: "tidal:42",
          source: "tidal",
          source_id: "42",
          title: "Remote album",
          has_cover: false,
          track_count: 12,
        },
      ],
      artists: [],
    });
  openPalette();
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "hello" },
  });
  await waitFor(() => expect(mock.search).toHaveBeenCalledTimes(1));
  const signal = mock.search.mock.calls[0][0].signal as AbortSignal;
  fireEvent.click(screen.getByRole("tab", { name: "Albums" }));
  expect(document.activeElement).toBe(screen.getByRole("combobox"));
  await waitFor(() => expect(mock.search).toHaveBeenCalledTimes(2));
  expect(signal.aborted).toBe(true);
  expect(mock.search.mock.lastCall?.[0]).toMatchObject({
    q: "hello",
    type: "album",
  });
  await act(async () => {
    finish({
      tracks: [{ id: "stale", title: "Stale song" }],
      albums: [],
      artists: [],
    });
  });
  expect(screen.queryByText("Stale song")).toBeNull();
  expect(screen.getByText("Remote album")).toBeTruthy();
  fireEvent.click(screen.getByRole("option", { name: /Remote album/ }));
  expect(screen.getByRole("status", { hidden: true }).textContent).toBe(
    "?q=hello&type=album&tidalAlbum=42",
  );
});

it("opens the full search with the selected type", async () => {
  mock.search.mockResolvedValue({ tracks: [], albums: [], artists: [] });
  openPalette();
  fireEvent.click(screen.getByRole("tab", { name: "Artists" }));
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "hello" },
  });
  await waitFor(() => expect(mock.search).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("option", { name: "View all results" }));
  expect(screen.getByRole("status", { hidden: true }).textContent).toBe(
    "?q=hello&type=artist",
  );
});
