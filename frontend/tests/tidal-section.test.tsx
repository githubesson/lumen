import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type TidalStatus } from "../src/api";
import { clearResourceCache } from "../src/lib/resourceCache";
import { TidalSection } from "../src/pages/admin/TidalSection";

vi.mock("../src/pages/admin/TidalAutoDownloadCard", () => ({ TidalAutoDownloadCard: () => null }));

const status = (overrides: Partial<TidalStatus>): TidalStatus => ({
  connected: true,
  management_supported: true,
  accounts: [],
  ...overrides,
});

beforeEach(() => {
  vi.spyOn(api, "tidalStatus");
});
afterEach(() => {
  cleanup();
  clearResourceCache();
  vi.restoreAllMocks();
});

it("claims nothing about accounts or the extension when the status fails to load", async () => {
  vi.mocked(api.tidalStatus).mockRejectedValue(new Error("offline"));
  render(<TidalSection roots={[]} />);
  expect(await screen.findByText("Failed to load TIDAL status.")).toBeTruthy();
  expect(screen.queryByText(/require the Lumen hifi-api extension/)).toBeNull();
  expect(screen.queryByText(/No TIDAL account is linked/)).toBeNull();
  expect((screen.getByRole("button", { name: "Link account" }) as HTMLButtonElement).disabled).toBe(true);
});

it("says no account is linked only once a status says so", async () => {
  let answer!: (s: TidalStatus) => void;
  vi.mocked(api.tidalStatus).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
  render(<TidalSection roots={[]} />);
  expect(screen.getByText("checking")).toBeTruthy();
  expect(screen.queryByText(/No TIDAL account is linked/)).toBeNull();
  answer(status({}));
  expect(await screen.findByText(/No TIDAL account is linked/)).toBeTruthy();
  expect(screen.getByText("proxy online")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Link account" }) as HTMLButtonElement).disabled).toBe(false);
});

it("explains the extension when a loaded status lacks account controls", async () => {
  vi.mocked(api.tidalStatus).mockResolvedValue(status({ management_supported: false }));
  render(<TidalSection roots={[]} />);
  expect(await screen.findByText(/require the Lumen hifi-api extension/)).toBeTruthy();
  expect(screen.queryByText(/No TIDAL account is linked/)).toBeNull();
});

it("names linked accounts and where they come from", async () => {
  vi.mocked(api.tidalStatus).mockResolvedValue(status({
    accounts: [
      { id: "a", user_id: "123", removable: true },
      { id: "b", user_id: "", removable: false },
    ] as TidalStatus["accounts"],
  }));
  render(<TidalSection roots={[]} />);
  expect(await screen.findByText("Account 123")).toBeTruthy();
  expect(screen.getByText("Managed by Lumen")).toBeTruthy();
  expect(screen.getByText("Account unknown")).toBeTruthy();
  expect(screen.getByText("Configured by environment")).toBeTruthy();
});
