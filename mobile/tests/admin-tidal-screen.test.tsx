import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError, type TidalStatus } from "@music-library/core";
import AdminTidalScreen from "../app/(tabs)/(settings)/admin-tidal";

type QueryState = { data?: unknown; isLoading?: boolean; error?: unknown };
const mock = vi.hoisted(() => ({ status: {} as QueryState }));
vi.mock("react-native", () => ({
  ActivityIndicator: () => <i>spinner</i>,
  Alert: { alert: vi.fn() },
  Pressable: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-router", () => ({ Stack: { Screen: () => null } }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-haptics", () => ({}));
vi.mock("expo-web-browser", () => ({}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) =>
    options.queryKey.includes("tidal-auto-download") ? {} : mock.status,
  useQueryClient: () => ({}),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@music-library/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@music-library/core")>()),
  api: {},
  useTidalDeviceLogin: () => ({
    flow: null,
    starting: false,
    unlinkingId: null,
    error: null,
    notice: null,
  }),
}));
vi.mock("../components/header-buttons", () => ({ HeaderIconButton: () => null }));
vi.mock("../components/primitives", () => ({
  Card: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SectionLabel: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({
    color: {},
    space: { sm: 8, md: 12, lg: 16, xl: 24 },
    radius: { sm: 6, md: 10 },
  }),
}));

function status(overrides: Partial<TidalStatus> = {}): TidalStatus {
  return {
    connected: true,
    management_supported: true,
    accounts: [],
    ...overrides,
  };
}

beforeEach(() => {
  mock.status = {};
});

it("says nothing about accounts while the status loads", () => {
  mock.status = { isLoading: true };
  const html = renderToStaticMarkup(<AdminTidalScreen />);
  expect(html).toContain("Checking proxy…");
  expect(html).not.toContain("No account linked");
  expect(html).not.toContain("hifi-api extension");
});

it("shows only the load error when the status failed to load", () => {
  mock.status = { isLoading: false, error: new ApiError(500, "proxy unreachable") };
  const html = renderToStaticMarkup(<AdminTidalScreen />);
  expect(html).toContain("proxy unreachable");
  expect(html).toContain("Proxy offline");
  expect(html).not.toContain("No account linked");
  expect(html).not.toContain("hifi-api extension");
});

it("explains a proxy without account controls and an empty account list", () => {
  mock.status = { isLoading: false, data: status({ management_supported: false }) };
  const html = renderToStaticMarkup(<AdminTidalScreen />);
  expect(html).toContain("Proxy online");
  expect(html).toContain("No account linked");
  expect(html).toContain("hifi-api extension");
});

it("labels linked accounts by id and source", () => {
  mock.status = {
    isLoading: false,
    data: status({
      accounts: [{ id: "a1", user_id: "12345", removable: true }],
    }),
  };
  const html = renderToStaticMarkup(<AdminTidalScreen />);
  expect(html).toContain("Account 12345");
  expect(html).toContain("Managed by Lumen");
  expect(html).not.toContain("No account linked");
});
