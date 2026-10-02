// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import {
  lastFMConnectionState,
  useLastFMConnection,
} from "../src/lastfm/use-lastfm-connection";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.spyOn(api, "getLastFMStatus").mockResolvedValue({
    configured: true,
    connected: false,
    pending: false,
  });
  vi.spyOn(api, "connectLastFM").mockResolvedValue({
    authorization_url: "https://last.fm/authorize",
  });
  vi.spyOn(api, "disconnectLastFM").mockResolvedValue(undefined);
  vi.spyOn(api, "waitForLastFMAuthorization").mockImplementation(
    () => new Promise(() => {}),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Last.fm connection lifecycle", () => {
  it("starts native authorization while the browser sheet is still open", async () => {
    const browser = deferred<void>();
    const authorization = deferred<{ username: string }>();
    vi.mocked(api.waitForLastFMAuthorization).mockReturnValue(
      authorization.promise,
    );
    const open = vi.fn(() => browser.promise);
    const { result } = renderHook(() =>
      useLastFMConnection({ openAuthorization: open, pendingBeforeOpen: true }),
    );
    await waitFor(() => expect(result.current.status?.configured).toBe(true));
    let connecting!: Promise<void>;
    await act(async () => {
      connecting = result.current.connect();
    });
    expect(open).toHaveBeenCalledWith("https://last.fm/authorize");
    expect(api.waitForLastFMAuthorization).toHaveBeenCalledOnce();
    expect(result.current.busy).toBe(true);
    await act(async () => {
      authorization.resolve({ username: "listener" });
    });
    expect(result.current.status).toEqual({
      configured: true,
      connected: true,
      pending: false,
      username: "listener",
    });
    await act(async () => {
      browser.resolve();
      await connecting;
    });
    expect(result.current.status?.pending).toBe(false);
    expect(result.current.busy).toBe(false);
    await act(async () => {
      await result.current.disconnect();
    });
    expect(result.current.status).toEqual({
      configured: true,
      connected: false,
      pending: false,
    });
  });

  it("waits for the desktop launcher and reports failure without starting a poll", async () => {
    const open = vi.fn().mockRejectedValue(new Error("Browser unavailable"));
    const { result } = renderHook(() =>
      useLastFMConnection({ openAuthorization: open }),
    );
    await waitFor(() => expect(result.current.status?.configured).toBe(true));
    await act(async () => {
      await result.current.connect();
    });
    // Generic launcher failures use the same safe fallback as both original screens.
    expect(result.current.error).toBe("Could not connect Last.fm.");
    expect(result.current.busy).toBe(false);
    expect(result.current.status?.pending).toBe(false);
    expect(api.waitForLastFMAuthorization).not.toHaveBeenCalled();
  });

  it("aborts polling when hidden and ignores a late authorization response", async () => {
    vi.mocked(api.getLastFMStatus).mockResolvedValue({
      configured: true,
      connected: false,
      pending: true,
    });
    const authorization = deferred<{ username: string }>();
    vi.mocked(api.waitForLastFMAuthorization).mockReturnValue(
      authorization.promise,
    );
    const open = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useLastFMConnection({ enabled, openAuthorization: open }),
      { initialProps: { enabled: false } },
    );
    expect(api.getLastFMStatus).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() =>
      expect(api.waitForLastFMAuthorization).toHaveBeenCalledOnce(),
    );
    const signal = vi.mocked(api.waitForLastFMAuthorization).mock.calls[0][0]
      ?.signal;
    rerender({ enabled: false });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      authorization.resolve({ username: "stale" });
    });
    expect(result.current.status?.connected).toBe(false);
  });
});

describe("Last.fm connection state", () => {
  const base = { configured: true, connected: false, pending: false };

  it("walks the five states", () => {
    expect(lastFMConnectionState(null)).toEqual({
      kind: "checking",
      description: "Checking…",
      error: null,
    });
    expect(lastFMConnectionState({ ...base, configured: false }).kind).toBe(
      "unavailable",
    );
    expect(lastFMConnectionState(base)).toMatchObject({
      kind: "disconnected",
      description: "Send what you play to your Last.fm profile.",
    });
    expect(lastFMConnectionState({ ...base, pending: true })).toMatchObject({
      kind: "pending",
      description: "Waiting for you to approve Lumen on Last.fm.",
    });
    expect(
      lastFMConnectionState({ ...base, connected: true, username: "listener" }),
    ).toMatchObject({ kind: "connected", description: "Scrobbling as listener." });
    expect(
      lastFMConnectionState({ ...base, connected: true }).description,
    ).toBe("Scrobbling as your account.");
  });

  it("prefers the hook's error over the server's last one", () => {
    const status = { ...base, last_error: "Session key revoked." };
    expect(lastFMConnectionState(status).error).toBe("Session key revoked.");
    expect(lastFMConnectionState(status, "Could not connect Last.fm.").error).toBe(
      "Could not connect Last.fm.",
    );
    expect(lastFMConnectionState(base, null).error).toBeNull();
    expect(lastFMConnectionState(base, "").error).toBeNull();
  });
});
