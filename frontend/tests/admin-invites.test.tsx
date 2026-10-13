import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type Invite } from "../src/api";
import { clearResourceCache } from "../src/lib/resourceCache";
import { InvitesAdminSection } from "../src/pages/AdminInvites";

const desktop = vi.hoisted(() => ({ backendUrl: null as string | null }));
vi.mock("../src/lib/platform", async (original) => ({
  ...(await original<typeof import("../src/lib/platform")>()),
  isElectron: () => desktop.backendUrl !== null,
}));
vi.mock("../src/lib/desktopConfig", () => ({
  useDesktopConfig: () => (desktop.backendUrl === null ? null : { backendUrl: desktop.backendUrl }),
}));

const day = 24 * 60 * 60 * 1000;

function invite(overrides: Partial<Invite>): Invite {
  return {
    id: "inv",
    target_role: "user",
    max_uses: 1,
    uses: 0,
    created_at: new Date(Date.now() - day).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(api, "listInvites").mockResolvedValue([]);
  vi.spyOn(api, "createInvite").mockResolvedValue(invite({ id: "new", token: "t".repeat(32) }));
});
afterEach(() => {
  desktop.backendUrl = null;
  cleanup();
  clearResourceCache();
  vi.restoreAllMocks();
});

it("doesn't send max uses the server would quietly turn into 1", async () => {
  render(<InvitesAdminSection />);
  const maxUses = screen.getByLabelText("Max uses");
  const create = screen.getByRole("button", { name: "Create" });

  for (const value of ["0", "-2", ""]) {
    fireEvent.change(maxUses, { target: { value } });
    expect(
      screen.getByText("Max uses must be a whole number from 1 to 2,147,483,647."),
    ).toBeTruthy();
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(create.closest("form")!);
  }
  expect(api.createInvite).not.toHaveBeenCalled();

  fireEvent.change(maxUses, { target: { value: "3" } });
  expect((create as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(create);
  await waitFor(() =>
    expect(api.createInvite).toHaveBeenCalledWith({
      target_role: "user",
      max_uses: 3,
      expires_at: undefined,
    }),
  );
});

it("rejects an expiry in the past", () => {
  render(<InvitesAdminSection />);
  fireEvent.change(screen.getByLabelText("Expires (optional)"), {
    target: { value: "2020-01-01T00:00" },
  });
  expect(screen.getByText("Expiry must be in the future.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it("files expired and used-up invites with the past ones, where they can't be revoked", async () => {
  vi.mocked(api.listInvites).mockResolvedValue([
    invite({ id: "live", max_uses: 5, uses: 2 }),
    invite({ id: "expired", expires_at: new Date(Date.now() - 1000).toISOString() }),
    invite({ id: "spent", uses: 1 }),
  ]);
  render(<InvitesAdminSection />);
  const disclosure = await screen.findByRole("button", { name: /Used, expired and revoked/ });
  expect(within(disclosure).getByText("2")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /^Revoke / })).toHaveLength(1);
  expect(screen.getByText("2 / 5")).toBeTruthy();
  const past = document.getElementById(disclosure.getAttribute("aria-controls")!)!;
  expect(within(past).getByText("expired")).toBeTruthy();
  expect(within(past).getByText("exhausted")).toBeTruthy();
});

it("links the invite to this site on the web", async () => {
  render(<InvitesAdminSection />);
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(
    await screen.findByText(`${window.location.origin}/register?token=${"t".repeat(32)}`),
  ).toBeTruthy();
});

it("links the invite to the configured server on the desktop app, not its local proxy", async () => {
  desktop.backendUrl = "https://music.example.com";
  render(<InvitesAdminSection />);
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(
    await screen.findByText(`https://music.example.com/register?token=${"t".repeat(32)}`),
  ).toBeTruthy();
});

it("makes one invite for a double submit", async () => {
  let finish!: (created: Invite) => void;
  vi.mocked(api.createInvite).mockImplementation(
    () => new Promise((resolve) => { finish = resolve; }),
  );
  render(<InvitesAdminSection />);
  const form = screen.getByRole("button", { name: "Create" }).closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(api.createInvite).toHaveBeenCalledTimes(1);
  finish(invite({ id: "new", token: "t".repeat(32) }));
  expect(await screen.findByText(/register\?token=/)).toBeTruthy();
});

it("says so when the server sends the invite back without its token", async () => {
  vi.mocked(api.createInvite).mockResolvedValue(invite({ id: "new" }));
  render(<InvitesAdminSection />);
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByText(/didn't send its link/)).toBeTruthy();
});
