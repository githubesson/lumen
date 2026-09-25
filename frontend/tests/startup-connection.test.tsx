import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import StartupConnection from "../src/components/StartupConnection";

const mock = vi.hoisted(() => ({
  status: "loading", error: null as string | null, refresh: vi.fn(), changeServer: vi.fn(),
}));
vi.mock("../src/context/Auth", () => ({ useAuth: () => ({
  status: mock.status, refreshError: mock.error, refresh: mock.refresh,
}) }));

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mock.status = "loading"; mock.error = null;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("keeps server settings usable while a session check is slow", () => {
  render(<StartupConnection onChangeServer={mock.changeServer} />);
  expect(screen.getByText("Checking your session…")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Change server" }));
  expect(mock.changeServer).toHaveBeenCalledOnce();
  act(() => { vi.advanceTimersByTime(3000); });
  expect(screen.getByText(/taking longer than usual/)).toBeTruthy();
  expect(mock.refresh).not.toHaveBeenCalled();
});

it("lets the user retry a failed session check", () => {
  mock.status = "guest";
  mock.error = "Could not connect to your server.";
  render(<StartupConnection />);
  expect(screen.getByText(mock.error)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(mock.refresh).toHaveBeenCalledOnce();
});
