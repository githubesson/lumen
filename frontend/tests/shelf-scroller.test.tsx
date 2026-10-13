import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ShelfScroller from "../src/components/ShelfScroller";

/** Reports on connect, as the browser's does, and again on `fire()`. */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  constructor(private readonly callback: () => void) {
    FakeResizeObserver.all.push(this);
  }
  observe() {
    this.callback();
  }
  unobserve() {}
  disconnect() {}
  fire() {
    this.callback();
  }
}

// The row's content width; the row shows 400px of it.
let contentWidth = 800;

beforeEach(() => {
  FakeResizeObserver.all = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => contentWidth);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  contentWidth = 800;
});

function renderShelf() {
  return render(
    <ShelfScroller label="Top artists">
      {/* Cards with nothing to click: no page and nothing to play. */}
      {["Kestrel Bay", "Hana Okoro", "Halden Marsh", "Gone", "Marisol Vey"].map((name) => (
        <div key={name} className="card">
          {name}
        </div>
      ))}
    </ShelfScroller>,
  );
}

it("takes keyboard focus while it scrolls, so cards with nothing to tab to can be reached", () => {
  const { container } = renderShelf();
  const row = screen.getByRole("group", { name: "Top artists" });
  expect(row.tabIndex).toBe(0);
  row.focus();
  expect(document.activeElement).toBe(row);
  // The arrows stay pointer shortcuts, out of the tab order.
  const arrows = [...container.querySelectorAll(".shelf-arrow")];
  expect(arrows).toHaveLength(2);
  for (const arrow of arrows) {
    expect(arrow.getAttribute("tabindex")).toBe("-1");
    expect(arrow.getAttribute("aria-hidden")).toBe("true");
  }
  // The fade still says there's more past the edge.
  expect(container.querySelector(".shelf-scroller")!.hasAttribute("data-forward")).toBe(true);
});

it("is no tab stop when every card fits", () => {
  renderShelf();
  const row = screen.getByRole("group", { name: "Top artists" });
  contentWidth = 400;
  act(() => FakeResizeObserver.all.forEach((observer) => observer.fire()));
  expect(row.hasAttribute("tabindex")).toBe(false);
});
