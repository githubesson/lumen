import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import PlaylistNew from "../src/pages/PlaylistNew";

const mock = vi.hoisted(() => ({ createPlaylist: vi.fn() }));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: mock,
}));
const playlists = vi.hoisted(() => ({ reload: () => Promise.resolve() }));
vi.mock("../src/context/Playlists", () => ({ usePlaylists: () => playlists }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  render(
    <MemoryRouter>
      <PlaylistNew />
    </MemoryRouter>,
  );
}

it("won't create a playlist with a whitespace-only name", () => {
  renderPage();
  const create = screen.getByRole("button", { name: "Create playlist" }) as HTMLButtonElement;
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "   " } });
  expect(create.disabled).toBe(true);
  fireEvent.submit(create.closest("form")!);
  expect(mock.createPlaylist).not.toHaveBeenCalled();
});

it("sends the name and description trimmed", async () => {
  mock.createPlaylist.mockResolvedValue({ id: "p1" });
  renderPage();
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: " Mix " } });
  fireEvent.change(screen.getByRole("textbox", { name: /Description/ }), {
    target: { value: "  for the road  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create playlist" }));
  await act(async () => {});
  expect(mock.createPlaylist).toHaveBeenCalledWith({
    name: "Mix",
    description: "for the road",
    visibility: "private",
  });
});
