import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import Breadcrumbs from "../src/components/shell/Breadcrumbs";

afterEach(cleanup);

function Probe() {
  const location = useLocation();
  const type = useNavigationType();
  return <output aria-label="where">{`${type} ${location.pathname}${location.search}`}</output>;
}

function show(entries: string[]) {
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Breadcrumbs playlists={[]} />
      <Probe />
    </MemoryRouter>,
  );
}

it.each([
  ["/library?view=albums&q=rec&album=al-1", "/library?view=albums&q=rec"],
  ["/library?artist=ar-1", "/library"],
  ["/library?q=x&type=artist&tidalArtist=ta-1&artistName=Band", "/library?q=x&type=artist"],
  ["/library?tidalArtist=ta-1&tidalAlbum=tal-1", "/library"],
])("on %s the Library crumb links back to %s", (entry, href) => {
  show([entry]);
  const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(trail).getByRole("link", { name: "Library" }).getAttribute("href")).toBe(href);
});

it.each(["/library", "/library?view=albums&q=rec", "/library?view=albums&album="])(
  "on the list (%s) Library is the current crumb, not a link",
  (entry) => {
    show([entry]);
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(trail).queryByRole("link", { name: "Library" })).toBeNull();
    expect(within(trail).getByText("Library").getAttribute("aria-current")).toBe("page");
  },
);

it("goes back to the list in place, so browser Back skips the album page", () => {
  show(["/home", "/library?q=rec&album=al-1"]);
  fireEvent.click(screen.getByRole("link", { name: "Library" }));
  expect(screen.getByRole("status", { name: "where" }).textContent).toBe("REPLACE /library?q=rec");
});
