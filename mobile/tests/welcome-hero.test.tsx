import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  make: vi.fn(),
  // Stands in for the effect that decodes the art, which a server render skips.
  art: null as null | { width: () => number; height: () => number },
  shader: undefined as undefined | Record<string, unknown>,
  image: undefined as undefined | Record<string, unknown>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T) =>
      mock.art ? [{ art: mock.art, failed: false }, () => {}] : actual.useState(initial),
  };
});

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
  Canvas: ({ children }: { children: ReactNode }) => <canvas>{children}</canvas>,
  Fill: ({ children }: { children: ReactNode }) => <>{children}</>,
  ImageShader: (props: Record<string, unknown>) => {
    mock.image = props;
    return null;
  },
  Shader: ({ children, ...props }: { children: ReactNode }) => {
    mock.shader = props;
    return <>{children}</>;
  },
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
  mock.art = null;
  mock.shader = undefined;
  mock.image = undefined;
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

it("draws the art through the mesh, clamped so cut-off edge cells stay opaque", async () => {
  const effect = {};
  mock.make.mockReturnValue(effect);
  mock.art = { width: () => 660, height: () => 960 };
  expect(await render()).toContain("<canvas");
  expect(mock.shader).toEqual({
    source: effect,
    uniforms: { density: 3, pitch: 9, gap: 2, lineLight: 0.6 },
  });
  expect(mock.image).toMatchObject({ image: mock.art, tx: "clamp", ty: "clamp", fit: "fill" });
});
