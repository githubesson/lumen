import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMiniPlayerMode } from "../src/components/player/useMiniPlayerMode";

const platform = vi.hoisted(() => ({
  canSetMiniPlayer: () => true,
  getMiniPlayerPanelAnchor: vi.fn(async () => "top" as const),
  setMiniPlayerMode: vi.fn(async (on: boolean) => ({ ok: true, miniPlayer: on })),
  setMiniPlayerPanel: vi.fn(async (open: boolean) => ({ ok: true, open, anchor: "top" as const })),
}));
vi.mock("../src/lib/platform", () => platform);
vi.mock("../src/context/LyricsPanel", () => ({
  useLyricsPanel: () => ({ open: false, setOpen: () => {} }),
}));

afterEach(cleanup);

it("closes a panel through its own toggle only", async () => {
  const { result } = renderHook(() => useMiniPlayerMode());
  await act(() => result.current.toggleMiniPlayerMode());
  expect(result.current.miniPlayerMode).toBe(true);
  act(() => result.current.panelToggle("error").onToggle());
  await waitFor(() => expect(result.current.panel).toBe("error"));

  // Another panel's close leaves this one up.
  act(() => result.current.panelToggle("queue").close());
  expect(result.current.panelToggle("error").open).toBe(true);

  act(() => result.current.panelToggle("error").close());
  expect(result.current.panelToggle("error").open).toBe(false);
  await waitFor(() => expect(result.current.panel).toBeNull());
  expect(platform.setMiniPlayerPanel).toHaveBeenLastCalledWith(false);

  // Again once it's shut: nothing to do.
  platform.setMiniPlayerPanel.mockClear();
  act(() => result.current.panelToggle("error").close());
  expect(result.current.panelToggle("error").open).toBe(false);
  expect(platform.setMiniPlayerPanel).not.toHaveBeenCalled();
});
