import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApiKey } from "../src/api";
import ApiKeysSetting from "../src/components/ApiKeysSetting";
import { ConfirmProvider } from "../src/context/Confirm";
import { clearResourceCache } from "../src/lib/resourceCache";

const mock = vi.hoisted(() => ({
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
}));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: mock,
}));
vi.mock("../src/context/Auth", () => ({
  useAuth: () => ({ me: { id: "u1", username: "esson", role: "user", must_reset_password: false } }),
}));

beforeEach(() => {
  // jsdom has no layout; the Select scrolls its active option into view.
  Element.prototype.scrollIntoView = vi.fn();
  // Each test starts from no list, not the last test's cached one.
  clearResourceCache();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const used: ApiKey = {
  id: "k1",
  name: "Stats script",
  prefix: "lumen_AbCdEf",
  created_at: "2026-11-01T10:00:00Z",
  last_used_at: "2026-11-20T10:00:00Z",
  expires_at: null,
};
const expired: ApiKey = {
  id: "k2",
  name: "Old backup job",
  prefix: "lumen_ZyXwVu",
  created_at: "2025-01-01T10:00:00Z",
  last_used_at: null,
  expires_at: "2025-02-01T10:00:00Z",
};

async function renderSetting(keys: ApiKey[]) {
  mock.listApiKeys.mockResolvedValue(keys);
  render(<ApiKeysSetting />, { wrapper: ConfirmProvider });
  await act(async () => {});
}

it("lists keys by name and prefix, marking only the expired one", async () => {
  await renderSetting([used, expired]);
  expect(screen.getByText("Stats script")).toBeTruthy();
  expect(screen.getByText("lumen_AbCdEf…")).toBeTruthy();
  expect(screen.getAllByText("Expired")).toHaveLength(1);
  expect(screen.getByText(/Never used/)).toBeTruthy();
});

it("shows a new key once, to copy, and lists it without the key", async () => {
  await renderSetting([used]);
  mock.createApiKey.mockResolvedValue({
    ...used,
    id: "k3",
    name: "Home Assistant",
    prefix: "lumen_Secret",
    created_at: "2026-11-24T10:00:00Z",
    last_used_at: null,
    expires_at: "2027-02-22T10:00:00Z",
    key: "lumen_SecretRestOfTheKey",
  });
  const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "  Home Assistant " } });
  fireEvent.click(screen.getByLabelText("Expiry"));
  fireEvent.click(await screen.findByRole("option", { name: "Expires in 90 days" }));
  fireEvent.click(create);
  await act(async () => {});

  expect(mock.createApiKey).toHaveBeenCalledWith({ name: "Home Assistant", expires_in_days: 90 });
  const shown = screen.getByLabelText("New key “Home Assistant”") as HTMLInputElement;
  expect(shown.value).toBe("lumen_SecretRestOfTheKey");
  expect((screen.getByLabelText("Key name") as HTMLInputElement).value).toBe("");
  // Newest first, and the list row shows only the prefix.
  const names = screen.getAllByRole("button", { name: "Revoke" });
  expect(names).toHaveLength(2);
  expect(screen.getByText("lumen_Secret…")).toBeTruthy();
});

it("revokes a key after the confirm", async () => {
  await renderSetting([used, expired]);
  mock.deleteApiKey.mockResolvedValue(undefined);
  fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]);
  const dialog = await screen.findByRole("alertdialog", { name: "Revoke this API key?" });
  expect(within(dialog).getByText("Stats script")).toBeTruthy();
  expect(mock.deleteApiKey).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
  await act(async () => {});
  expect(mock.deleteApiKey).toHaveBeenCalledWith("k1");
  // The closing dialog still names it; the list doesn't.
  expect(screen.queryByText("lumen_AbCdEf…")).toBeNull();
  expect(screen.getByText("lumen_ZyXwVu…")).toBeTruthy();
});

it("loads the whole list when a key is made before it arrived", async () => {
  mock.listApiKeys.mockRejectedValueOnce(new Error("offline"));
  render(<ApiKeysSetting />, { wrapper: ConfirmProvider });
  await act(async () => {});
  expect(screen.getByText("Couldn't load your API keys.")).toBeTruthy();

  const made: ApiKey = { ...used, id: "k3", name: "Home Assistant", prefix: "lumen_Secret", last_used_at: null };
  mock.createApiKey.mockResolvedValue({ ...made, key: "lumen_SecretRestOfTheKey" });
  mock.listApiKeys.mockResolvedValue([made, used, expired]);
  fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Home Assistant" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await act(async () => {});

  // Not the new key alone: every key, from a fresh load.
  expect(mock.listApiKeys).toHaveBeenCalledTimes(2);
  expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(3);
  expect(screen.getByText("lumen_AbCdEf…")).toBeTruthy();
});

it("keeps the whole list when a key is made while the list is still loading", async () => {
  let resolveFirst!: (keys: ApiKey[]) => void;
  mock.listApiKeys.mockReturnValueOnce(
    new Promise<ApiKey[]>((resolve) => {
      resolveFirst = resolve;
    }),
  );
  render(<ApiKeysSetting />, { wrapper: ConfirmProvider });
  await act(async () => {});

  const made: ApiKey = { ...used, id: "k3", name: "Home Assistant", prefix: "lumen_Secret", last_used_at: null };
  mock.createApiKey.mockResolvedValue({ ...made, key: "lumen_SecretRestOfTheKey" });
  mock.listApiKeys.mockResolvedValue([made, used, expired]);
  fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Home Assistant" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await act(async () => {});
  // The first load, from before the key, lands late: it mustn't win.
  await act(async () => resolveFirst([used]));

  expect(mock.listApiKeys).toHaveBeenCalledTimes(2);
  expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(3);
});
