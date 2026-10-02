import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type InviteCheck } from "../src/api";
import Register from "../src/pages/Register";

vi.mock("../src/context/Auth", () => ({ useAuth: () => ({ setMe: vi.fn() }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Register />
    </MemoryRouter>,
  );
}

beforeEach(() => { vi.spyOn(api, "checkInvite"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("doesn't call an invite dead when it couldn't be checked, and can retry", async () => {
  const first = deferred<InviteCheck>();
  const second = deferred<InviteCheck>();
  vi.mocked(api.checkInvite)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  renderAt("/register?token=tok");
  expect(screen.getByText("Checking invite")).toBeTruthy();

  await act(async () => { first.reject(new TypeError("Failed to fetch")); });
  expect(screen.queryByText("Invite unavailable")).toBeNull();
  expect(screen.getByText("Couldn't check invite")).toBeTruthy();
  expect(
    screen.getByText("Couldn't verify this invite. Check your connection and try again."),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByText("Checking invite")).toBeTruthy();
  expect(api.checkInvite).toHaveBeenCalledTimes(2);
  await act(async () => { second.resolve({ valid: true, target_role: "user" }); });
  expect(screen.getByRole("heading", { name: "Create account" })).toBeTruthy();
});

it("reports an invite the server says is unusable", async () => {
  vi.mocked(api.checkInvite).mockResolvedValue({ valid: false });
  renderAt("/register?token=tok");
  expect(await screen.findByText("Invite unavailable")).toBeTruthy();
});

it("reports a missing token without asking the server", () => {
  renderAt("/register");
  expect(screen.getByText("Invite unavailable")).toBeTruthy();
  expect(api.checkInvite).not.toHaveBeenCalled();
});
