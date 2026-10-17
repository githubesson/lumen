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

// Stands in for the desktop app: merges the options sent onto the saved card.
let stored = card;
function store(changes: Partial<DiscordCardOptions>) {
  stored = { ...stored, ...changes };
  return { ok: true, config: desktop(stored).config, changed: false };
}

beforeEach(() => {
  stored = card;
  mock.update.mockReset();
  mock.update.mockImplementation(async ({ discordCard }) => store(discordCard));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("saves typing once it pauses, and what's left when the section closes", async () => {
  vi.useFakeTimers();
  const view = render(<DiscordCardSettings desktop={desktop(card)} />);
  fireEvent.change(line(1), { target: { value: "{title} — {artist}" } });
  expect(mock.update).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(600); });
  // Only what changed goes out.
  expect(savedCards()).toEqual([{ details: "{title} — {artist}" }]);
  fireEvent.change(line(3), { target: { value: "" } });
  view.unmount();
  expect(savedCards().at(-1)).toEqual({ largeText: "" });
  expect(stored).toEqual({ ...card, details: "{title} — {artist}", largeText: "" });
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
  mock.update.mockImplementationOnce(({ discordCard }) => new Promise((resolve) => {
    land = () => resolve(store(discordCard));
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
  expect(savedCards().at(-1)).toEqual({ cover: false });
  expect(stored).toEqual({ ...card, details: "{artist}", cover: false });
});

it("keeps an earlier view's save when an edit goes out before it lands, and then shows both", async () => {
  // The desktop app writes saves in order, so the earlier one lands first.
  const queue: Array<() => void> = [];
  mock.update.mockImplementation(({ discordCard }) => new Promise((resolve) => {
    queue.push(() => resolve(store(discordCard)));
  }));
  const first = render(<DiscordCardSettings desktop={desktop(card)} />);
  fireEvent.change(line(1), { target: { value: "{artist}" } });
  fireEvent.blur(line(1));
  first.unmount();
  render(<DiscordCardSettings desktop={desktop(card)} />);
  await act(async () => { fireEvent.click(screen.getAllByRole("switch")[0]); });
  await act(async () => { queue.shift()!(); });
  await act(async () => { queue.shift()!(); });
  expect(stored).toEqual({ ...card, details: "{artist}", cover: false });
  expect(line(1).value).toBe("{artist}");
});

it("keeps typing that hasn't saved yet when an older save lands", async () => {
  vi.useFakeTimers();
  const view = render(<DiscordCardSettings desktop={desktop(card)} />);
  fireEvent.change(line(2), { target: { value: "{album}" } });
  view.rerender(<DiscordCardSettings desktop={desktop({ ...card, state: "{title}" })} />);
  expect(line(2).value).toBe("{album}");
});
