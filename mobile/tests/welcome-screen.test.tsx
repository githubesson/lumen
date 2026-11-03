import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import WelcomeScreen from "../app/(auth)/welcome";

const mock = vi.hoisted(() => ({
  push: vi.fn(),
  baseUrl: "https://musicfiles.example:8443",
  presses: new Map<string, () => void>(),
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  ScrollView: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  View: ({
    children,
    accessibilityLabel,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => {
    mock.presses.set(accessibilityLabel, onPress);
    return <button aria-label={accessibilityLabel}>{children}</button>;
  },
  useWindowDimensions: () => ({ width: 393, height: 852, fontScale: 1 }),
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("expo-image", () => ({ Image: () => <img alt="" /> }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34 }),
}));
vi.mock("react-native-reanimated", () => {
  const builder = {
    delay: () => builder,
    duration: () => builder,
    withInitialValues: () => builder,
  };
  return {
    default: {
      View: ({ children }: { children: ReactNode }) => <section>{children}</section>,
    },
    FadeInDown: builder,
  };
});
vi.mock("@music-library/core", () => ({ getBaseUrl: () => mock.baseUrl }));
vi.mock("../components/auth/welcome-art", () => ({ WELCOME_RECORD: 1 }));
vi.mock("../components/auth/welcome-hero", () => ({ WelcomeHero: () => null }));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({
    scheme: "dark",
    color: { bg: "#000", fg: "#fff", fgMuted: "#888", fgSubtle: "#ccc", accent: "#00f", onAccent: "#fff" },
    radius: { md: 10 },
    space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  }),
}));

beforeEach(() => {
  mock.push.mockClear();
  mock.presses.clear();
  mock.baseUrl = "https://musicfiles.example:8443";
});

it("reads the headline as one sentence, whatever sits between its words", () => {
  const html = renderToStaticMarkup(<WelcomeScreen />);
  expect(html).toContain('aria-label="Your music, on your server"');
});

it("names the server this build talks to", () => {
  // React splits the sentence around the value, so compare the text alone.
  const text = renderToStaticMarkup(<WelcomeScreen />).replace(/<!-- -->|<[^>]+>/g, "");
  expect(text).toContain("Lumen plays your library from musicfiles.example on your phone");
});

it("still reads properly when the server isn't configured", () => {
  mock.baseUrl = "not a url";
  const text = renderToStaticMarkup(<WelcomeScreen />).replace(/<!-- -->|<[^>]+>/g, "");
  expect(text).toContain("Lumen plays your library from your server on your phone");
});

it("offers one primary way in and one quiet one", () => {
  renderToStaticMarkup(<WelcomeScreen />);
  expect([...mock.presses.keys()]).toEqual([
    "Sign in",
    "Create an account with an invite",
  ]);
  mock.presses.get("Sign in")?.();
  expect(mock.push).toHaveBeenLastCalledWith("/(auth)/login");
  mock.presses.get("Create an account with an invite")?.();
  expect(mock.push).toHaveBeenLastCalledWith("/(auth)/register");
});
