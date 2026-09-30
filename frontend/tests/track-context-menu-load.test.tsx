import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTrackContextMenu } from "../src/lib/useTrackContextMenu";

vi.mock("../src/components/TrackContextMenu", () => ({ default: () => <div role="menu">Track menu</div> }));
afterEach(cleanup);

const track = { id: "track", title: "Song", duration_ms: 1000 };
function Row() {
  const { bind, menu } = useTrackContextMenu();
  return (
    <>
      <div onContextMenu={bind(track)}>Song row</div>
      {menu}
    </>
  );
}

// Runs first: the menu chunk hasn't loaded yet in this module instance.
it("drops a first open that was dismissed while the menu chunk loaded", async () => {
  render(<Row />);
  fireEvent.contextMenu(screen.getByText("Song row"));
  fireEvent.keyDown(window, { key: "Escape" });
  await act(async () => {});
  expect(screen.queryByRole("menu")).toBeNull();
});

it("opens once loaded, and immediately after that", async () => {
  render(<Row />);
  fireEvent.contextMenu(screen.getByText("Song row"));
  await act(async () => {});
  expect(screen.getByRole("menu")).toBeTruthy();
});
