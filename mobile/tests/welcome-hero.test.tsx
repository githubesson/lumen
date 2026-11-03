import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ make: vi.fn() }));

vi.mock("react-native", () => ({
  Image: { resolveAssetSource: () => ({ uri: "file:///art.jpg" }) },
  PixelRatio: { get: () => 3 },
  StyleSheet: { absoluteFill: {}, create: <T,>(styles: T) => styles },
  useWindowDimensions: () => ({ width: 393, height: 852 }),
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-image", () => ({ Image: () => <img alt="plain art" /> }));
vi.mock("react-native-reanimated", () => {
  const builder = { duration: () => builder };
  return {
    default: {
      View: ({ children }: { children: ReactNode }) => <section>{children}</section>,
    },
    FadeIn: builder,
  };
});
vi.mock("@shopify/react-native-skia", () => ({
  Canvas: () => <canvas />,
  Fill: () => null,
  FilterMode: {},
  ImageShader: () => null,
  MipmapMode: {},
  Shader: () => null,
  Skia: { RuntimeEffect: { Make: mock.make } },
}));
vi.mock("../components/auth/welcome-art", () => ({
  WELCOME_NIGHT: 1,
  WELCOME_MORNING: 2,
}));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({ scheme: "dark", color: { bg: "#000000" } }),
  withAlpha: (color: string) => color,
}));

beforeEach(() => {
  vi.resetModules();
  mock.make.mockReset();
});

async function render() {
  const { WelcomeHero } = await import("../components/auth/welcome-hero");
  return renderToStaticMarkup(<WelcomeHero height={540} />);
}

it("shows the plain art when this device's Skia refuses the mesh", async () => {
  mock.make.mockImplementation(() => {
    throw new Error("Error in SKSL");
  });
  expect(await render()).toContain('alt="plain art"');
});

it("waits for the art without flashing the plain image", async () => {
  mock.make.mockReturnValue({});
  const html = await render();
  expect(html).not.toContain("plain art");
  expect(html).not.toContain("<canvas");
});

it("compiles the mesh once, however many times the hero renders", async () => {
  mock.make.mockReturnValue({});
  await render();
  await render();
  expect(mock.make).toHaveBeenCalledTimes(1);
});
