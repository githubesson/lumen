import { beforeEach, expect, it, vi } from "vitest";
import type { TrackListItem } from "@music-library/core";
import { useAlbumDownloadAction } from "../lib/album-download";

// Just enough React to call the hook as a function.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => [initial, () => {}],
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
const auth = vi.hoisted(() => ({ role: "admin" }));
vi.mock("@music-library/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@music-library/core")>()),
  api: {},
  useAuth: () => ({ me: { id: "me", role: auth.role } }),
}));

const tidal = (id: string): TrackListItem => ({
  id: `tidal:${id}`,
  source: "tidal",
  source_id: id,
  title: id,
  duration_ms: 1000,
});

beforeEach(() => {
  auth.role = "admin";
});

it("offers the album with an arrow, and marks queued tracks so the button spins", () => {
  const tracks = [tidal("1"), tidal("2")];
  const idle = useAlbumDownloadAction("77", tracks, 0, () => {});
  expect(idle?.label).toBe("Download album");
  expect(idle?.queued).toBeUndefined();
  const queued = useAlbumDownloadAction("77", tracks, 2, () => {});
  expect(queued?.label).toBe("Downloading · 2 left");
  expect(queued?.queued).toBe(true);
});

it("offers nothing to someone who isn't an admin", () => {
  auth.role = "user";
  expect(useAlbumDownloadAction("77", [tidal("1")], 0, () => {})).toBeUndefined();
});
