import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackListItem } from "@music-library/core";
import {
  AlbumSleeve,
  sleeveLayout,
  STACK_BELOW_PX,
  type AlbumSleeveAlbum,
} from "../src/components/library/AlbumSleeve";

const mock = vi.hoisted(() => ({
  player: { play: vi.fn(), toggleShuffle: vi.fn(), shuffle: false },
}));
vi.mock("../src/context/Player", () => ({
  usePlayer: () => mock.player,
  useRemotePlayback: () => ({ targetDevice: null, commandPending: false }),
}));

const track = (id: string, unavailable?: boolean): TrackListItem => ({
  id,
  title: id,
  duration_ms: 1000,
  unavailable,
});

const album: AlbumSleeveAlbum = {
  title: "Record",
  credits: [{ name: "Band", artistId: "ar-band" }, { name: "Guest" }],
  facts: [{ key: "length", label: "Length", value: "3 tracks · 1 min" }],
  tracks: [track("gone", true), track("one"), track("two")],
};

const search = { query: "", setQuery: () => {}, matchCount: 0, totalCount: 0, searchActive: false };

type SleeveProps = Partial<Parameters<typeof AlbumSleeve>[0]>;

/** The sleeve inside a content area that scrolls, as in the app. */
function sleeve(props: SleeveProps = {}) {
  return (
    <MemoryRouter initialEntries={["/library?view=albums&q=rec&album=al-1"]}>
      <div className="content" style={{ overflowY: "auto" }}>
        <AlbumSleeve
          kind="Album"
          onBack={() => {}}
          album={album}
          loadingLabel="Loading album…"
          search={search}
          searchRef={createRef()}
          {...props}
        />
      </div>
    </MemoryRouter>
  );
}

function renderSleeve(props: SleeveProps = {}) {
  return render(sleeve(props));
}

afterEach(() => {
  cleanup();
  mock.player.play.mockReset();
  mock.player.shuffle = false;
});

it("links a credited artist to its page, keeping the library's tab and search", () => {
  renderSleeve();
  expect(screen.getByRole("link", { name: "Band" }).getAttribute("href")).toBe(
    "/library?view=albums&q=rec&artist=ar-band",
  );
  // No library page to open: plain text.
  expect(screen.queryByRole("link", { name: "Guest" })).toBeNull();
  expect(screen.getByText("Guest")).toBeTruthy();
});

it("plays the list from its first playable track, or a random one with shuffle on", () => {
  renderSleeve();
  fireEvent.click(screen.getByRole("button", { name: "Play all" }));
  expect(mock.player.play).toHaveBeenLastCalledWith(album.tracks[1], album.tracks.slice(1));
  cleanup();

  mock.player.shuffle = true;
  vi.spyOn(Math, "random").mockReturnValue(0.99);
  renderSleeve();
  expect(screen.getByRole("button", { name: "Shuffle" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Play all" }));
  expect(mock.player.play).toHaveBeenLastCalledWith(album.tracks[2], album.tracks.slice(1));
  vi.restoreAllMocks();
});

it("offers the album editor beside Details only when given one", () => {
  const onEdit = vi.fn();
  renderSleeve({ onEdit });
  fireEvent.click(screen.getByRole("button", { name: "Edit album" }));
  expect(onEdit).toHaveBeenCalledTimes(1);
  cleanup();
  renderSleeve();
  expect(screen.queryByRole("button", { name: "Edit album" })).toBeNull();
});

it("holds the page's frame while the album loads", () => {
  const { container } = renderSleeve({ album: null });
  expect(container.querySelector("[aria-busy='true']")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Loading album…");
  // Two title lines, as most titles take in the column.
  expect(container.querySelectorAll("h1 .skeleton-text")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Play all" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Shuffle" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Details")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Select" }).hasAttribute("disabled")).toBe(true);
  // No actions row unless the loaded page will have one.
  expect(container.querySelector(".album-sleeve-more")).toBeNull();
  cleanup();
  const reserved = renderSleeve({ album: null, reserveActions: true });
  expect(reserved.container.querySelector(".album-sleeve-more .skeleton-text")).toBeTruthy();
});

it("puts a quiet link in the Details heading once the album is there", () => {
  const link = <button type="button">Open in library</button>;
  const { container } = renderSleeve({ detailsLink: link });
  // In the heading row, which the loading frame has too, so it moves nothing;
  // not in the actions row.
  const head = container.querySelector(".album-sleeve-details .album-sleeve-details-head");
  expect(head?.textContent).toBe("DetailsOpen in library");
  expect(container.querySelector(".album-sleeve-more")).toBeNull();
  cleanup();
  renderSleeve({ album: null, detailsLink: link });
  expect(screen.queryByRole("button", { name: "Open in library" })).toBeNull();
});

it("stacks below the width threshold and keeps a tall column's bottom reachable", () => {
  const pad = { padTop: 20, viewportHeight: 600 };
  expect(sleeveLayout({ ...pad, contentWidth: STACK_BELOW_PX - 1, columnHeight: 400 }).stacked).toBe(true);
  expect(sleeveLayout({ ...pad, contentWidth: STACK_BELOW_PX, columnHeight: 400 }).stacked).toBe(false);
  // A column that fits stays under the top padding.
  expect(sleeveLayout({ ...pad, contentWidth: 960, columnHeight: 560 }).top).toBe(20);
  // A taller one scrolls until its bottom shows, padded like its top, then sticks.
  expect(sleeveLayout({ ...pad, contentWidth: 960, columnHeight: 700 }).top).toBe(20 + 600 - 700 - 40);
  expect(sleeveLayout({ padTop: 20, viewportHeight: null, contentWidth: 960, columnHeight: 700 }).top).toBe(20);
});

describe("laid out from its measurements", () => {
  class FakeResizeObserver {
    static last: FakeResizeObserver | null = null;
    targets = new Set<Element>();
    constructor(private readonly callback: () => void) {
      FakeResizeObserver.last = this;
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
    fire() {
      this.callback();
    }
  }

  beforeEach(() => vi.stubGlobal("ResizeObserver", FakeResizeObserver));
  afterEach(() => vi.unstubAllGlobals());

  const setSize = (el: HTMLElement, prop: "clientWidth" | "clientHeight" | "offsetHeight", value: number) =>
    Object.defineProperty(el, prop, { configurable: true, value });

  it("sets the column's offset from a first, unscrolled visit on, and stacks when narrow", () => {
    // A first visit: the loading frame doesn't overflow the content area.
    const { container, rerender } = render(sleeve({ album: null }));
    const view = container.querySelector<HTMLElement>(".album-sleeve")!;
    const side = container.querySelector<HTMLElement>(".album-sleeve-side")!;
    const area = container.querySelector<HTMLElement>(".content")!;
    const observer = FakeResizeObserver.last!;
    // The content area is watched even so, for its height.
    expect(observer.targets.has(area)).toBe(true);

    view.style.padding = "20px";
    setSize(view, "clientWidth", 1000);
    setSize(area, "clientHeight", 600);
    setSize(side, "offsetHeight", 480);
    observer.fire();
    expect(view.hasAttribute("data-stacked")).toBe(false);
    expect(view.style.getPropertyValue("--sleeve-top")).toBe("20px");

    // The album lands and the column grows past the content area.
    rerender(sleeve());
    setSize(side, "offsetHeight", 700);
    observer.fire();
    expect(view.style.getPropertyValue("--sleeve-top")).toBe("-120px");

    // 1000px less 40px of padding is wide enough; 40px less isn't.
    setSize(view, "clientWidth", STACK_BELOW_PX + 40 - 1);
    observer.fire();
    expect(view.hasAttribute("data-stacked")).toBe(true);
    setSize(view, "clientWidth", STACK_BELOW_PX + 40);
    observer.fire();
    expect(view.hasAttribute("data-stacked")).toBe(false);
  });
});
