import CanvasKitInit from "canvaskit-wasm";
import { describe, expect, it, vi } from "vitest";
import {
  WELCOME_MESH_SHADER,
  loadWelcomeArt,
  welcomeArtRect,
  welcomeFadeHeight,
  welcomeMesh,
} from "../lib/welcome-mesh";

describe("welcomeMesh", () => {
  it("lands on whole device pixels at every screen density", () => {
    expect(welcomeMesh(3)).toEqual({ pitch: 9, gap: 2 });
    expect(welcomeMesh(2)).toEqual({ pitch: 6, gap: 1 });
    expect(welcomeMesh(2.625)).toEqual({ pitch: 8, gap: 2 });
  });
});

describe("welcomeArtRect", () => {
  const art = { width: 660, height: 960 };

  it("fills the width and keeps the sky on a tall view", () => {
    expect(welcomeArtRect({ width: 393, height: 540 }, art)).toEqual({
      x: 0,
      y: 0,
      width: 393,
      height: (960 * 393) / 660,
    });
  });

  it("slides up on a short view, to keep the record out of the fade", () => {
    const rect = welcomeArtRect({ width: 375, height: 380 }, art);
    expect(rect.width).toBeCloseTo(375);
    expect(rect.y).toBeLessThan(0);
    // The record sits at 39.5% of the art.
    expect(rect.y + rect.height * 0.395).toBeCloseTo(380 * 0.46);
  });

  it("fills the height and centers when the view is wider than the art", () => {
    const rect = welcomeArtRect({ width: 300, height: 960 }, art);
    expect(rect).toEqual({ x: -180, y: 0, width: 660, height: 960 });
  });
});

describe("welcomeFadeHeight", () => {
  it("scales with the hero within its limits", () => {
    expect(welcomeFadeHeight(200)).toBe(96);
    expect(welcomeFadeHeight(540)).toBe(162);
    expect(welcomeFadeHeight(1200)).toBe(240);
  });
});

describe("loadWelcomeArt", () => {
  const skia = (decoded: string | null) => ({
    Data: { fromURI: async (uri: string) => `bytes of ${uri}` },
    Image: { MakeImageFromEncoded: () => decoded },
  });

  it("decodes the file at the URI", async () => {
    const decode = vi.fn(() => "image");
    const art = await loadWelcomeArt("file:///night.jpg", {
      Data: skia("").Data,
      Image: { MakeImageFromEncoded: decode },
    });
    expect(art).toBe("image");
    expect(decode).toHaveBeenCalledWith("bytes of file:///night.jpg");
  });

  it("reports a file it can't decode", async () => {
    expect(await loadWelcomeArt("file:///night.jpg", skia(null))).toBeNull();
  });

  it("reports a file it can't read, rather than rejecting", async () => {
    const broken = {
      Data: { fromURI: () => Promise.reject(new Error("no such file")) },
      Image: { MakeImageFromEncoded: () => "image" },
    };
    await expect(loadWelcomeArt("file:///night.jpg", broken)).resolves.toBeNull();
  });
});

describe("the mesh shader, under real Skia", () => {
  async function make() {
    const CK = await CanvasKitInit();
    const errors: string[] = [];
    const effect = CK.RuntimeEffect.Make(WELCOME_MESH_SHADER, (e) => errors.push(e));
    expect(errors).toEqual([]);
    if (!effect) throw new Error("the shader didn't compile");
    return { CK, effect };
  }

  it("takes exactly the uniforms the screen passes", async () => {
    const { effect } = await make();
    const names = Array.from({ length: effect.getUniformCount() }, (_, i) =>
      effect.getUniformName(i),
    );
    // RN Skia throws on a missing uniform, by name.
    expect(new Set(names)).toEqual(
      new Set(["density", ...Object.keys(welcomeMesh(3)), "lineLight"]),
    );
  });

  it("dims a line along each cell's top and left, one mesh period apart", async () => {
    const { CK, effect } = await make();
    const density = 3;
    const { pitch, gap } = welcomeMesh(density);
    const size = pitch * 2;
    const surface = CK.MakeSurface(size, size);
    if (!surface) throw new Error("no surface");
    const canvas = surface.getCanvas();
    canvas.scale(density, density);
    const child = CK.Shader.MakeColor(CK.WHITE, CK.ColorSpace.SRGB);
    const uniforms = [density, pitch, gap, 0.5];
    const order = Array.from({ length: effect.getUniformCount() }, (_, i) =>
      effect.getUniformName(i),
    );
    expect(order).toEqual(["density", "pitch", "gap", "lineLight"]);
    const paint = new CK.Paint();
    paint.setShader(effect.makeShaderWithChildren(uniforms, [child]));
    canvas.drawPaint(paint);
    surface.flush();

    const pixels = canvas.readPixels(0, 0, {
      width: size,
      height: size,
      colorType: CK.ColorType.RGBA_8888,
      alphaType: CK.AlphaType.Premul,
      colorSpace: CK.ColorSpace.SRGB,
    });
    if (!pixels) throw new Error("no pixels");
    const red = (x: number, y: number) => pixels[(y * size + x) * 4];
    const row = Array.from({ length: size }, (_, x) => red(x, pitch - 1));
    const lit = 255;
    // Across a cell's row: `gap` dim pixels, then lit ones, then it repeats.
    expect(row.slice(0, gap).every((v) => v < 140)).toBe(true);
    expect(row.slice(gap, pitch).every((v) => v === lit)).toBe(true);
    expect(row.slice(pitch, pitch + gap).every((v) => v < 140)).toBe(true);
    expect(row.slice(pitch + gap).every((v) => v === lit)).toBe(true);
    // A line across the top of the cell stays dim the whole way.
    expect(red(pitch - 1, 0)).toBeLessThan(140);
  });
});
