import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { TrackDetail } from "@music-library/core";
import TrackEditScreen from "../app/(tabs)/(library,browse)/track/edit";

const mock = vi.hoisted(() => ({
  role: "admin",
  track: undefined as TrackDetail | undefined,
}));
vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: "t1" }),
  useRouter: () => ({ back: vi.fn() }),
}));
vi.mock("expo-haptics", () => ({}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mock.track, isLoading: false, isError: false }),
}));
vi.mock("@music-library/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@music-library/core")>()),
  api: {},
  useAuth: () => ({ me: { id: "user", role: mock.role } }),
}));
vi.mock("../components/buttons", () => ({ PrimaryButton: () => <button>Save changes</button> }));
vi.mock("../components/form-field", () => ({
  FormError: () => null,
  FormField: ({ label, children }: { label: string; children: ReactNode }) => (
    <label>
      {label}
      {children}
    </label>
  ),
  FormTextInput: ({ value }: { value: string }) => <input value={value} readOnly />,
}));
vi.mock("../components/header-buttons", () => ({ HeaderSaveButton: () => null }));
vi.mock("../components/empty-state", () => ({
  EmptyState: ({ message }: { message?: string }) => <p>{message}</p>,
  retryAction: () => undefined,
}));
vi.mock("../theme/theme", () => ({ useTheme: () => ({ color: { bg: "black" }, space: { lg: 24, md: 16 } }) }));

function detail(overrides: Partial<TrackDetail>): TrackDetail {
  return {
    id: "t1",
    source: "local",
    title: "Song",
    duration_ms: 1,
    format: "flac",
    file_size: 1,
    artists: [{ id: "a", name: "Artist", role: "primary" }],
    has_cover: false,
    favorited: false,
    ...overrides,
  };
}

beforeEach(() => {
  mock.role = "admin";
});

it("shows the form for a library track", () => {
  mock.track = detail({});
  const html = renderToStaticMarkup(<TrackEditScreen />);
  expect(html).toContain("Save changes");
});

it("explains instead of offering a form for a TIDAL track", () => {
  mock.track = detail({ id: "tidal:1", source: "tidal" });
  const html = renderToStaticMarkup(<TrackEditScreen />);
  expect(html).toContain("Only tracks in the library can be edited.");
  expect(html).not.toContain("Save changes");
});

it("explains instead of offering a form to a non-admin", () => {
  mock.role = "user";
  mock.track = detail({});
  const html = renderToStaticMarkup(<TrackEditScreen />);
  expect(html).toContain("Only admins can edit track metadata.");
  expect(html).not.toContain("Save changes");
});
