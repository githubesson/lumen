import { useEffect } from "react";
import { useTheme } from "../context/Theme";

export interface AccentOKLCH {
  l: number;
  c: number;
  h: number;
}

function srgbToLinear(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function rgbToOklch(r: number, g: number, b: number): AccentOKLCH {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const b_ = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  const c = Math.sqrt(a * a + b_ * b_);
  let h = (Math.atan2(b_, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

async function extractAccent(src: string, signal: AbortSignal): Promise<AccentOKLCH | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.loading = "eager";

    const onAbort = () => {
      img.src = "";
      resolve(null);
    };
    if (signal.aborted) return resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });

    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const size = 32;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;

        let best: AccentOKLCH | null = null;
        let bestScore = -Infinity;
        let fallback: AccentOKLCH | null = null;
        let fallbackScore = -Infinity;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];
          if (a < 200) continue;
          const { l, c, h } = rgbToOklch(r, g, b);
          if (l < 0.15 || l > 0.92) continue;
          const score = c * (1 - Math.abs(l - 0.55));
          if (c >= 0.08 && score > bestScore) {
            bestScore = score;
            best = { l, c, h };
          }
          if (score > fallbackScore) {
            fallbackScore = score;
            fallback = { l, c, h };
          }
        }
        resolve(best ?? fallback);
      } catch {
        resolve(null);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    };
    img.onerror = () => {
      signal.removeEventListener("abort", onAbort);
      resolve(null);
    };
    img.src = src;
  });
}

function clampAccent(raw: AccentOKLCH, theme: "light" | "dark"): AccentOKLCH {
  const targetL = theme === "dark" ? 0.72 : 0.62;
  const targetC = theme === "dark" ? 0.17 : 0.18;
  const l = Math.max(targetL - 0.04, Math.min(targetL + 0.04, raw.l || targetL));
  const c = Math.max(0.08, Math.min(targetC + 0.04, raw.c || targetC));
  return { l, c, h: raw.h };
}

export function useAccentFromCover(coverSrc: string | null | undefined) {
  const { theme, glow, setAccent, resetAccent } = useTheme();
  useEffect(() => {
    // When the user disabled ambient glow, stay on the default accent instead
    // of re-tinting everything from the album cover.
    if (!glow || !coverSrc) {
      resetAccent();
      return;
    }
    const ctrl = new AbortController();
    void extractAccent(coverSrc, ctrl.signal).then((raw) => {
      if (ctrl.signal.aborted) return;
      if (!raw) {
        resetAccent();
        return;
      }
      const c = clampAccent(raw, theme);
      setAccent(c.l, c.c, c.h);
    });
    return () => ctrl.abort();
  }, [coverSrc, theme, glow, setAccent, resetAccent]);
}
