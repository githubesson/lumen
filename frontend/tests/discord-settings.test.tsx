import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiscordCardSettings } from "../src/components/DiscordSettings";
import type { DesktopSettingsState } from "../src/components/DesktopSettings";
import type { DesktopConfig, DiscordCardOptions } from "../src/contracts/desktop";

const mock = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../src/lib/desktopConfig", () => ({ updateDesktopConfig: mock.update }));
vi.mock("../src/context/Player", () => ({
  usePlayer: () => ({ current: null, isPlaying: false }),
  usePlayerTime: () => ({ currentTime: 0, duration: 0 }),
}));
vi.mock("../src/context/Auth", () => ({ useAuth: () => ({ me: { username: "maya" } }) }));

const card: DiscordCardOptions = {
  details: "{title}", state: "{artist}", largeText: "{album}",
  statusName: "app", cover: true, playState: true, showPaused: true,
};

function desktop(discordCard: DiscordCardOptions) {
  const config = { backendUrl: "", discordEnabled: true, alwaysOnTop: false, fh6RadioEnabled: false, fh6GameDir: "", fh6BridgePort: 1, discordCard } satisfies DesktopConfig;
  return { config } as unknown as DesktopSettingsState;
}
const line = (n: number) => screen.getByRole("textbox", { name: `Line ${n}` }) as HTMLInputElement;
const savedCards = () => mock.update.mock.calls.map(([patch]) => patch.discordCard);

beforeEach(() => {
  mock.update.mockReset();
  mock.update.mockImplementation(async (patch) => ({ ok: true, config: patch, changed: false }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("saves typing once it pauses, and what's left when the section closes", async () => {
  vi.useFakeTimers();
  const view = render(<DiscordCardSettings desktop={desktop(card)} />);
  fireEvent.change(line(1), { target: { value: "{title} — {artist}" } });
  expect(mock.update).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(600); });
  expect(savedCards()).toEqual([{ ...card, details: "{title} — {artist}" }]);
  fireEvent.change(line(3), { target: { value: "" } });
  view.unmount();
  expect(savedCards().at(-1)).toEqual({ ...card, details: "{title} — {artist}", largeText: "" });
});

it("shows why a save failed, including one the desktop app threw on", async () => {
  mock.update.mockResolvedValueOnce({ ok: false, error: "Disk is full" });
  render(<DiscordCardSettings desktop={desktop(card)} />);
  await act(async () => { fireEvent.click(screen.getAllByRole("switch")[0]); });
  expect(screen.getByText("Disk is full")).toBeTruthy();
  mock.update.mockRejectedValueOnce(new Error("config.json is read-only"));
  await act(async () => { fireEvent.click(screen.getAllByRole("switch")[0]); });
  expect(screen.getByText("config.json is read-only")).toBeTruthy();
});

it("takes up a save that lands after the section remounts, so the next edit keeps it", async () => {
  let land!: () => void;
  mock.update.mockImplementationOnce((patch) => new Promise((resolve) => {
    land = () => resolve({ ok: true, config: patch, changed: false });
  }));
  const first = render(<DiscordCardSettings desktop={desktop(card)} />);
  fireEvent.change(line(1), { target: { value: "{artist}" } });
  fireEvent.blur(line(1));
  first.unmount();
  // Back before the save answered: the store still has the old card.
  const second = render(<DiscordCardSettings desktop={desktop(card)} />);
  expect(line(1).value).toBe("{title}");
  await act(async () => { land(); });
  second.rerender(<DiscordCardSettings desktop={desktop({ ...card, details: "{artist}" })} />);
  expect(line(1).value).toBe("{artist}");
  await act(async () => { fireEvent.click(screen.getAllByRole("switch")[0]); });
  expect(savedCards().at(-1)).toEqual({ ...card, details: "{artist}", cover: false });
});

it("keeps typing that hasn't saved yet when an older save lands", async () => {
  vi.useFakeTimers();
  const view = render(<DiscordCardSettings desktop={desktop(card)} />);
  fireEvent.change(line(2), { target: { value: "{album}" } });
  view.rerender(<DiscordCardSettings desktop={desktop({ ...card, state: "{title}" })} />);
  expect(line(2).value).toBe("{album}");
});
