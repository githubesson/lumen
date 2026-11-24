import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApiKey, CreatedApiKey } from "../src/api";
import ApiKeysSetting, { useApiKeySession } from "../src/components/ApiKeysSetting";
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

// Holds the section's session the way SettingsDialog does. `shown` false is
// another section, which unmounts the setting; `open` false is Settings
// closed (and faded out).
function Harness({ shown = true, open = true }: { shown?: boolean; open?: boolean }) {
  const session = useApiKeySession(open, open);
  return shown && open ? <ApiKeysSetting session={session} /> : null;
}

function pendingCreate() {
  let resolve!: (made: CreatedApiKey) => void;
  mock.createApiKey.mockReturnValueOnce(new Promise<CreatedApiKey>((r) => (resolve = r)));
  return (made: CreatedApiKey) => act(async () => resolve(made));
}

async function renderSetting(keys: ApiKey[]) {
  mock.listApiKeys.mockResolvedValue(keys);
  const view = render(<Harness />, { wrapper: ConfirmProvider });
  await act(async () => {});
  return view;
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
  render(<Harness />, { wrapper: ConfirmProvider });
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
  render(<Harness />, { wrapper: ConfirmProvider });
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

it("still shows a new key after another section and back", async () => {
  const view = await renderSetting([used]);
  mock.createApiKey.mockResolvedValue({ ...used, id: "k3", name: "Home Assistant", key: "lumen_SecretRestOfTheKey" });
  fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Home Assistant" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await act(async () => {});
  expect(document.activeElement).toBe(screen.getByLabelText("New key “Home Assistant”"));

  view.rerender(<Harness shown={false} />);
  view.rerender(<Harness />);
  await act(async () => {});
  const shown = screen.getByLabelText("New key “Home Assistant”") as HTMLInputElement;
  expect(shown.value).toBe("lumen_SecretRestOfTheKey");
  // Coming back doesn't pull focus into the section.
  expect(document.activeElement).not.toBe(shown);
});

it("keeps Create locked across sections while a key is being made", async () => {
  const view = await renderSetting([used]);
  const finish = pendingCreate();
  fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Home Assistant" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  view.rerender(<Harness shown={false} />);
  view.rerender(<Harness />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Second" } });
  expect((screen.getByRole("button", { name: "Creating…" }) as HTMLButtonElement).disabled).toBe(true);

  await finish({ ...used, id: "k3", name: "Home Assistant", key: "lumen_SecretRestOfTheKey" });
  expect(mock.createApiKey).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText("New key “Home Assistant”") as HTMLInputElement).value).toBe("lumen_SecretRestOfTheKey");
  // The mount that's showing lists it, though another one made it.
  expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(2);
});

it("drops a key that lands after Settings closed", async () => {
  const view = await renderSetting([used]);
  const finish = pendingCreate();
  fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Home Assistant" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  view.rerender(<Harness open={false} />);
  await finish({ ...used, id: "k3", name: "Home Assistant", key: "lumen_SecretRestOfTheKey" });
  view.rerender(<Harness />);
  await act(async () => {});
  expect(screen.queryByLabelText("New key “Home Assistant”")).toBeNull();
  // Not locked by the create that was dropped.
  fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Second" } });
  expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);
});
