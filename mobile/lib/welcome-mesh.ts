/**
 * The welcome screen's art is a smooth image drawn through a pixel mesh on the
 * device. The mesh has to land on whole device pixels: baked into the file it
 * would shimmer on any phone that scales the image.
 */

/** Spacing of the mesh, in points. */
const CELL_POINTS = 3;
/** The dark line between cells, as a share of a point. */
const GAP_POINTS = 2 / 3;

export interface WelcomeMesh {
  /** Device pixels from one cell to the next. */
  pitch: number;
  /** Device pixels of dark line along each cell's top and left. */
  gap: number;
}

export function welcomeMesh(pixelRatio: number): WelcomeMesh {
  return {
    pitch: Math.max(2, Math.round(CELL_POINTS * pixelRatio)),
    gap: Math.max(1, Math.round(GAP_POINTS * pixelRatio)),
  };
}

/** The share of the art's height at which the record sits. */
const RECORD_IN_ART = 0.395;
/** The highest share of the view the record may be pushed down to. */
const RECORD_IN_VIEW = 0.46;

export interface WelcomeArtRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the art goes: filling the view and centered sideways. It's pinned to the
 * top unless the view is short, when it slides up to keep the record clear of
 * the fade; the sky above the record is the part it can afford to lose.
 */
export function welcomeArtRect(
  view: { width: number; height: number },
  art: { width: number; height: number },
): WelcomeArtRect {
  const scale = Math.max(view.width / art.width, view.height / art.height);
  const width = art.width * scale;
  const height = art.height * scale;
  return {
    x: (view.width - width) / 2,
    y: Math.min(0, view.height * RECORD_IN_VIEW - height * RECORD_IN_ART),
    width,
    height,
  };
}

/** How tall the fade into the page is, for a hero of this height. */
export function welcomeFadeHeight(heroHeight: number): number {
  return Math.min(240, Math.max(96, Math.round(heroHeight * 0.3)));
}

interface WelcomeArtLoader<Data, Art> {
  Data: { fromURI: (uri: string) => Promise<Data> };
  Image: { MakeImageFromEncoded: (data: Data) => Art | null };
}

/** Reads and decodes the art; null if either step fails, so the caller can fall back. */
export async function loadWelcomeArt<Data, Art>(
  uri: string,
  skia: WelcomeArtLoader<Data, Art>,
): Promise<Art | null> {
  try {
    return skia.Image.MakeImageFromEncoded(await skia.Data.fromURI(uri));
  } catch {
    return null;
  }
}

/**
 * Colors each cell with the average of four samples of the art, then darkens
 * the lines between cells. `density` turns Skia's points back into device pixels.
 */
export const WELCOME_MESH_SHADER = `
uniform shader art;
uniform float density;
uniform float pitch;
uniform float gap;
uniform float lineLight;

half4 main(vec2 pos) {
  vec2 px = pos * density;
  vec2 cell = floor(px / pitch);
  vec2 inCell = px - cell * pitch;
  vec2 center = (cell + 0.5) * pitch / density;
  float spread = pitch / density * 0.25;
  half4 color = (
    art.eval(center + vec2(-spread, -spread)) +
    art.eval(center + vec2(spread, -spread)) +
    art.eval(center + vec2(-spread, spread)) +
    art.eval(center + vec2(spread, spread))
  ) * 0.25;
  float lit = step(gap, inCell.x) * step(gap, inCell.y);
  color.rgb *= mix(lineLight, 1.0, lit);
  return color;
}
`;
