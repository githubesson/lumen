// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type TidalAuthPoll, type TidalAuthStart } from "../src/api";
import { useTidalDeviceLogin } from "../src/tidal/use-tidal-device-login";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const ACCOUNT = { id: "acc-1", user_id: "1234", removable: true };

function started(overrides: Partial<TidalAuthStart> = {}): TidalAuthStart {
  return {
    flow_id: "flow-1",
    verification_url: "link.tidal.com/ABCDE",
    user_code: "ABCDE",
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(api, "startTidalAuth").mockResolvedValue(started());
  vi.spyOn(api, "waitForTidalAuthorization").mockImplementation(
    () => new Promise(() => {}),
  );
  vi.spyOn(api, "removeTidalAccount").mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TIDAL device login", () => {
  it("opens the normalized page with the caller's context and reports the linked account", async () => {
    const poll = deferred<TidalAuthPoll>();
    vi.mocked(api.waitForTidalAuthorization).mockReturnValue(poll.promise);
    const openVerification = vi.fn().mockResolvedValue({ ok: true });
    const onLinked = vi.fn();
    const onAccountsChanged = vi.fn();
    const { result } = renderHook(() =>
      useTidalDeviceLogin<string>({ openVerification, onLinked, onAccountsChanged }),
    );

    let opened!: boolean;
    await act(async () => {
      opened = await result.current.start("reserved-tab");
    });
    expect(opened).toBe(true);
    expect(openVerification).toHaveBeenCalledWith(
      "https://link.tidal.com/ABCDE",
      "reserved-tab",
    );
    expect(result.current.flow?.flow_id).toBe("flow-1");
    expect(result.current.starting).toBe(false);
    const [flowId, options] = vi.mocked(api.waitForTidalAuthorization).mock.calls[0];
    expect(flowId).toBe("flow-1");
    // Five minutes to expiry, plus the grace period.
    expect(options?.timeoutMs).toBeGreaterThan(300_000);
    expect(options?.timeoutMs).toBeLessThanOrEqual(305_000);

    await act(async () => {
      poll.resolve({ state: "linked", account: ACCOUNT });
    });
    expect(result.current.flow).toBeNull();
    expect(result.current.notice).toBe("TIDAL account 1234 linked.");
    expect(result.current.error).toBeNull();
    expect(onLinked).toHaveBeenCalledOnce();
    expect(onAccountsChanged).toHaveBeenCalledOnce();
  });

  it("reports a refused sign-in and stops waiting", async () => {
    vi.mocked(api.waitForTidalAuthorization).mockResolvedValue({ state: "denied" });
    const onAccountsChanged = vi.fn();
    const { result } = renderHook(() =>
      useTidalDeviceLogin({
        openVerification: vi.fn().mockResolvedValue(undefined),
        onAccountsChanged,
      }),
    );
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(result.current.error).toBe("TIDAL sign-in denied."));
    expect(result.current.flow).toBeNull();
    expect(result.current.notice).toBeNull();
    expect(onAccountsChanged).not.toHaveBeenCalled();
  });

  it("shows the server's reason when a login can't start, without opening anything", async () => {
    vi.mocked(api.startTidalAuth).mockRejectedValue(
      new ApiError(502, "hifi-api unavailable"),
    );
    const openVerification = vi.fn();
    const { result } = renderHook(() => useTidalDeviceLogin({ openVerification }));
    let opened!: boolean;
    await act(async () => {
      opened = await result.current.start();
    });
    expect(opened).toBe(false);
    expect(result.current.error).toBe("hifi-api unavailable");
    expect(result.current.starting).toBe(false);
    expect(result.current.flow).toBeNull();
    expect(openVerification).not.toHaveBeenCalled();
    expect(api.waitForTidalAuthorization).not.toHaveBeenCalled();
  });

  it("keeps waiting when the page didn't open, so it can be reopened", async () => {
    const openVerification = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "The browser blocked the authorization window." })
      .mockRejectedValueOnce(new Error("sheet already open"))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useTidalDeviceLogin({ openVerification }));

    let opened!: boolean;
    await act(async () => {
      opened = await result.current.start();
    });
    expect(opened).toBe(false);
    expect(result.current.error).toBe("The browser blocked the authorization window.");
    expect(result.current.flow?.flow_id).toBe("flow-1");
    expect(api.waitForTidalAuthorization).toHaveBeenCalledOnce();

    // A rejection is a platform failure with no user-facing reason.
    await act(async () => {
      opened = await result.current.reopen();
    });
    expect(opened).toBe(false);
    expect(result.current.error).toBe("Could not open the TIDAL sign-in page.");

    await act(async () => {
      opened = await result.current.reopen();
    });
    expect(opened).toBe(true);
    expect(result.current.error).toBeNull();
    expect(openVerification).toHaveBeenLastCalledWith(
      "https://link.tidal.com/ABCDE",
      undefined,
    );
  });

  it("ignores a second start while one is in flight", async () => {
    const pending = deferred<TidalAuthStart>();
    vi.mocked(api.startTidalAuth).mockReturnValue(pending.promise);
    const { result } = renderHook(() =>
      useTidalDeviceLogin({ openVerification: vi.fn().mockResolvedValue(undefined) }),
    );
    let first!: Promise<boolean>;
    let second!: boolean;
    await act(async () => {
      first = result.current.start();
      second = await result.current.start();
    });
    expect(second).toBe(false);
    expect(result.current.starting).toBe(true);
    await act(async () => {
      pending.resolve(started());
      await first;
    });
    expect(api.startTidalAuth).toHaveBeenCalledOnce();
  });

  it("doesn't open a page for a screen that closed while the login started", async () => {
    const pending = deferred<TidalAuthStart>();
    vi.mocked(api.startTidalAuth).mockReturnValue(pending.promise);
    const openVerification = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTidalDeviceLogin({ openVerification }),
    );
    let starting!: Promise<boolean>;
    act(() => {
      starting = result.current.start();
    });
    unmount();
    pending.resolve(started());
    await expect(starting).resolves.toBe(false);
    expect(openVerification).not.toHaveBeenCalled();
    expect(api.waitForTidalAuthorization).not.toHaveBeenCalled();
  });

  it("aborts the wait on unmount and ignores its late answer", async () => {
    const poll = deferred<TidalAuthPoll>();
    vi.mocked(api.waitForTidalAuthorization).mockReturnValue(poll.promise);
    const onLinked = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTidalDeviceLogin({
        openVerification: vi.fn().mockResolvedValue(undefined),
        onLinked,
      }),
    );
    await act(async () => {
      await result.current.start();
    });
    const signal = vi.mocked(api.waitForTidalAuthorization).mock.calls[0][1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      poll.resolve({ state: "linked", account: ACCOUNT });
    });
    expect(onLinked).not.toHaveBeenCalled();
  });

  it("treats a poll that hit the request deadline as a failure, not a cancellation", async () => {
    const timedOut = new Error("The operation was aborted.");
    timedOut.name = "AbortError";
    vi.mocked(api.waitForTidalAuthorization).mockRejectedValue(timedOut);
    const { result } = renderHook(() =>
      useTidalDeviceLogin({ openVerification: vi.fn().mockResolvedValue(undefined) }),
    );
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() =>
      expect(result.current.error).toBe("Could not complete TIDAL sign-in."),
    );
    expect(result.current.flow).toBeNull();
  });

  it("keeps an unlinked account busy until the status has refreshed", async () => {
    const refresh = deferred<void>();
    const onAccountsChanged = vi.fn(() => refresh.promise);
    const { result } = renderHook(() =>
      useTidalDeviceLogin({ openVerification: vi.fn(), onAccountsChanged }),
    );
    let unlinking!: Promise<void>;
    await act(async () => {
      unlinking = result.current.unlink(ACCOUNT);
    });
    expect(api.removeTidalAccount).toHaveBeenCalledWith("acc-1");
    expect(result.current.unlinkingId).toBe("acc-1");
    expect(result.current.notice).toBe("TIDAL account unlinked.");
    await act(async () => {
      refresh.resolve();
      await unlinking;
    });
    expect(result.current.unlinkingId).toBeNull();
  });

  it("reports a failed unlink, but not a failed refresh as one", async () => {
    vi.mocked(api.removeTidalAccount).mockRejectedValueOnce(
      new ApiError(500, "internal error"),
    );
    const onAccountsChanged = vi.fn().mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() =>
      useTidalDeviceLogin({ openVerification: vi.fn(), onAccountsChanged }),
    );
    await act(async () => {
      await result.current.unlink(ACCOUNT);
    });
    expect(result.current.error).toBe("internal error");
    expect(result.current.notice).toBeNull();
    expect(onAccountsChanged).not.toHaveBeenCalled();
    expect(result.current.unlinkingId).toBeNull();
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();

    await act(async () => {
      await result.current.unlink(ACCOUNT);
    });
    expect(onAccountsChanged).toHaveBeenCalledOnce();
    expect(result.current.error).toBeNull();
    expect(result.current.notice).toBe("TIDAL account unlinked.");
  });
});
