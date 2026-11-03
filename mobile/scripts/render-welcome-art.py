#!/usr/bin/env python3
"""Render the welcome screen's art: a record sliding out of its sleeve, floating
through clouds. Night for dark mode, early morning for light.

The output is deliberately smooth. `components/auth/welcome-hero.tsx` turns it
into a pixel mesh on the device, in exact device pixels, because a mesh baked
into the file would shimmer on any phone that has to scale it.

    python3 scripts/render-welcome-art.py [output dir, default assets/images]

Needs numpy and Pillow. Rerun it only to change the art.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

W, H = 660, 960
SS = 2  # supersampling
RNG = np.random.default_rng(7)

PALETTES = {
    "night": dict(
        sky_stops=[(0.0, "#040716"), (0.22, "#081242"), (0.52, "#10267c"), (0.76, "#0a154e"), (1.0, "#02040f")],
        cloud_shadow="#1c2565",
        cloud_mid="#7c78b8",
        cloud_lit="#f0e1ea",
        cloud_alpha=1.0,
        stars=0.9,
        paper_lit="#f1e8d6",
        paper_shade="#b7ac9c",
        rim="#6d6558",
        ambient=1.0,
    ),
    "morning": dict(
        sky_stops=[(0.0, "#8fb2ea"), (0.3, "#a9c6f2"), (0.62, "#cfe0f8"), (1.0, "#ffffff")],
        cloud_shadow="#b5c4e6",
        cloud_mid="#e4e9f7",
        cloud_lit="#ffffff",
        cloud_alpha=1.0,
        stars=0.0,
        paper_lit="#fbf5e8",
        paper_shade="#d3c8b6",
        rim="#8f8676",
        ambient=1.0,
    ),
}


def rgb(value: str) -> np.ndarray:
    value = value.lstrip("#")
    return np.array([int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)])


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    t = np.asarray(t)
    if t.ndim == 2:
        t = t[..., None]
    return a * (1 - t) + b * t


def value_noise(w: int, h: int, cell: float, rng: np.random.Generator) -> np.ndarray:
    gw, gh = int(w / cell) + 3, int(h / cell) + 3
    grid = rng.random((gh, gw))
    ys, xs = np.mgrid[0:h, 0:w] / cell
    x0, y0 = xs.astype(int), ys.astype(int)
    fx, fy = smooth(0, 1, xs - x0), smooth(0, 1, ys - y0)
    top = grid[y0, x0] * (1 - fx) + grid[y0, x0 + 1] * fx
    bottom = grid[y0 + 1, x0] * (1 - fx) + grid[y0 + 1, x0 + 1] * fx
    return top * (1 - fy) + bottom * fy


def fbm(w: int, h: int, cell: float, rng: np.random.Generator, octaves: int = 5) -> np.ndarray:
    out, amp, total = np.zeros((h, w)), 1.0, 0.0
    for _ in range(octaves):
        out += value_noise(w, h, cell, rng) * amp
        total += amp
        amp *= 0.5
        cell = max(cell / 2, 1.5)
    return out / total


def gradient(stops, h, w):
    pos = np.array([s[0] for s in stops])
    cols = np.stack([rgb(s[1]) for s in stops])
    t = np.arange(h) / (h - 1)
    channels = np.stack([np.interp(t, pos, cols[:, c]) for c in range(3)], -1)
    # A wide box blur irons out the creases at each stop.
    radius = h // 14
    kernel = np.ones(radius * 2 + 1) / (radius * 2 + 1)
    padded = np.pad(channels, ((radius, radius), (0, 0)), mode="edge")
    channels = np.stack([np.convolve(padded[:, c], kernel, mode="valid") for c in range(3)], -1)
    return np.repeat(channels[:, None, :], w, axis=1)


def box_blur(a, radius):
    """Two passes of a summed-area box blur, close enough to a gaussian."""
    for _ in range(2):
        for axis in (0, 1):
            pad = [(radius + 1, radius) if i == axis else (0, 0) for i in range(2)]
            total = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis)
            hi = np.take(total, range(2 * radius + 1, total.shape[axis]), axis=axis)
            lo = np.take(total, range(0, total.shape[axis] - 2 * radius - 1), axis=axis)
            a = (hi - lo) / (2 * radius + 1)
    return a


def cumulus(canvas, cx, base, width, height, pal, seed, puffs=70):
    """A cloud built from many overlapping spheres on a soft, flat base, lit from
    the upper left. The height map is blurred so the puffs melt into each other."""
    h, w = canvas.shape[:2]
    cx, base, width, height = cx * w, base * h, width * w, height * w
    rng = np.random.default_rng(seed)
    ys, xs = np.mgrid[0:h, 0:w].astype(float)
    warp = height * 0.3
    bx = xs + (fbm(w, h, 44 * SS, rng, 3) - 0.5) * warp
    by = ys + (fbm(w, h, 44 * SS, rng, 3) - 0.5) * warp * 0.6
    z = np.zeros((h, w))
    for _ in range(puffs):
        t = rng.uniform(-1, 1)
        dome = max(1 - abs(t) ** 2.2, 0) ** 0.8
        r = height * rng.uniform(0.09, 0.3) * (0.35 + 0.65 * dome)
        px = cx + t * width
        py = base - r * 0.4 - (height - r) * dome * rng.random() ** 1.3
        z = np.maximum(z, np.sqrt(np.maximum(r * r - (bx - px) ** 2 - (by - py) ** 2, 0)))
    wisp = (fbm(w, h, 26 * SS, rng, 3) - 0.5) * height * 0.28
    fade = 1 - smooth(-height * 0.1, height * 0.1, by - base + wisp)
    alpha = smooth(0.0, 2.5 * SS, z) * fade
    soft = box_blur(z, 3 * SS)
    gy, gx = np.gradient(soft)
    nx, ny, nz = -gx, -gy, np.full_like(z, 0.9)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    lit = (nx * -0.5 + ny * -0.72 + nz * 0.48) / length
    rise = np.clip((base - by) / height, 0, 1)
    fine = fbm(w, h, 11 * SS, rng, 3) - 0.5
    tone = np.clip(lit * 0.7 + rise * 0.5 + fine * 0.26, 0, 1)
    col = mix(rgb(pal["cloud_shadow"]), rgb(pal["cloud_mid"]), smooth(0.08, 0.55, tone))
    col = mix(col, rgb(pal["cloud_lit"]), smooth(0.56, 0.98, tone))
    return mix(canvas, col, alpha * pal["cloud_alpha"])


def plane_coords(w, h, center, size, rot_deg, tilt_x, tilt_y):
    """Screen pixels to a tilted plane's coordinates, where 1 unit is `size` px."""
    ys, xs = np.mgrid[0:h, 0:w].astype(float)
    x, y = xs - center[0], ys - center[1]
    r = np.deg2rad(rot_deg)
    ca, sa = np.cos(r), np.sin(r)
    # Inverse perspective: plane (u, v) projects to (u, v) / (1 + tx u + ty v).
    denom = 1 - tilt_x * x / size - tilt_y * y / size
    px, py = x / denom, y / denom
    u = (px * ca + py * sa) / size
    v = (-px * sa + py * ca) / size
    return u, v


def rounded_box(u, v, half, radius):
    qx, qy = np.abs(u) - half + radius, np.abs(v) - half + radius
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - radius


def record(u, v, cx, ambient, seed):
    """A black disc whose grooves catch one bow tie of light, with an amber label."""
    rng = np.random.default_rng(seed)
    du, dv = u - cx, v
    r = np.hypot(du, dv) / 0.92
    th = np.arctan2(dv, du)
    col = np.zeros(u.shape + (3,))
    col[...] = rgb("#0b0b10")

    # Bands of grooves, split by the smooth gaps between tracks.
    grooves = 0.5 + 0.5 * np.sin(r * 300)
    gaps = np.minimum.reduce([np.abs(r - g) for g in (0.5, 0.62, 0.76, 0.88)])
    in_gap = 1 - smooth(0.004, 0.013, gaps)
    base = 0.055 + grooves * 0.035
    col += base[..., None] * np.array([0.9, 0.95, 1.1])

    # The bow tie of light any record shows under one lamp, with a faint second
    # lobe that picks up a little color.
    lamp = -1.05
    ray = np.power(np.abs(np.cos(th - lamp)), 26)
    side = np.power(np.abs(np.cos(th - lamp - 0.62)), 48)
    body = (0.7 + 0.3 * grooves) * (1 - in_gap * 0.75) * (1 - smooth(0.34, 0.5, 1 - r) * 0)
    col += (ray * body * 0.92)[..., None] * np.array([0.86, 0.91, 1.0])
    col += (side * body * 0.34)[..., None] * np.array([0.72, 0.62, 1.0])
    col += (in_gap * 0.045)[..., None]

    # Edge bevel.
    bevel = smooth(0.965, 0.985, r) * (1 - smooth(0.992, 1.0, r))
    light = np.power(np.abs(np.cos(th - lamp)), 3)
    col += (bevel * (0.08 + 0.5 * light))[..., None] * np.array([0.85, 0.9, 1.0])

    # Dead wax and label.
    wax = smooth(0.37, 0.385, r) * (1 - smooth(0.43, 0.45, r))
    col = mix(col, rgb("#101015"), wax * 0.75)
    label = 1 - smooth(0.365, 0.374, r)
    amber = mix(rgb("#ff9a2e"), rgb("#c6410b"), smooth(0.02, 0.38, r))
    shine = np.power(np.abs(np.cos(th - lamp)), 8)
    amber = mix(amber, rgb("#ffd98a"), shine * 0.62)
    ring = (1 - smooth(0.003, 0.012, np.abs(r - 0.315))) * 0.6
    amber = mix(amber, rgb("#7e2406"), ring)
    speck = fbm(u.shape[1], u.shape[0], 5, rng, 2) - 0.5
    amber = np.clip(amber + speck[..., None] * 0.08, 0, 1)
    col = mix(col, amber, label)

    # Spindle hole.
    hole = 1 - smooth(0.034, 0.042, r)
    col = mix(col, rgb("#120a05"), hole)

    mask = 1 - smooth(0.996, 1.004, r)
    return np.clip(col * ambient, 0, 1), mask, r


def sleeve(u, v, pal, seed):
    """A worn card sleeve: lit from the upper left, with the disc's ring pressed in."""
    rng = np.random.default_rng(seed)
    half = 1.0
    d = rounded_box(u, v, half, 0.012)
    mask = 1 - smooth(-0.002, 0.004, d)
    light = np.clip(0.66 - (u * 0.34 + v * 0.42), 0, 1)
    col = mix(rgb(pal["paper_shade"]), rgb(pal["paper_lit"]), smooth(0.0, 0.95, light))

    h, w = u.shape
    fiber = fbm(w, h, 8, rng, 3) - 0.5
    col = np.clip(col + fiber[..., None] * 0.05, 0, 1)

    # Ring wear from the disc inside.
    rr = np.hypot(u + 0.02, v) / 0.92
    ring = 1 - smooth(0.0, 0.03, np.abs(rr - 0.985))
    arc = 0.5 + 0.5 * np.cos(np.arctan2(v, u) + 2.1)
    col = mix(col, rgb(pal["paper_lit"]) * 1.03, ring * 0.4 * arc)
    col = mix(col, rgb(pal["paper_shade"]) * 0.78, ring * 0.36 * (1 - arc))

    # The app icon's waveform, printed on the front like a label's mark.
    bars = (0.2, 0.46, 0.3, 0.74, 1.0, 0.56, 0.86, 0.38, 0.62, 0.24, 0.12)
    ink = np.zeros_like(u)
    pitch, half_width = 0.112, 0.04
    for i, tall in enumerate(bars):
        bx = (i - (len(bars) - 1) / 2) * pitch
        bar_half = tall * 0.46
        dx = np.abs(u - bx)
        dy = np.maximum(np.abs(v) - bar_half, 0)
        ink = np.maximum(ink, 1 - smooth(half_width - 0.006, half_width + 0.006, np.hypot(dx, dy)))
    # A printed mark wears through a little, like everything else on the sleeve.
    grain = smooth(0.34, 0.5, fbm(w, h, 7, rng, 2))
    col = mix(col, rgb("#17204f"), ink * (0.8 + 0.2 * grain))

    # The fold on the closed side, and the lip of the open one.
    fold = 1 - smooth(0.0, 0.035, np.abs(u + 0.955))
    col = mix(col, rgb(pal["paper_shade"]) * 0.8, fold * 0.42)
    lip = 1 - smooth(0.0, 0.05, half - u)
    col = mix(col, rgb(pal["paper_shade"]) * 0.76, lip * 0.5)
    # Paler, scuffed corners and edges, where a much-played sleeve wears first.
    wear = 1 - smooth(-0.05, 0.0, d)
    worn = smooth(-0.07, -0.005, d) * smooth(0.45, 0.62, fbm(w, h, 18, rng, 3))
    col = mix(col, rgb(pal["paper_lit"]) * 1.06, worn * (1 - wear * 0) * 0.5)
    return np.clip(col, 0, 1), mask, d


def render_scene(name: str) -> np.ndarray:
    pal = PALETTES[name]
    w, h = W * SS, H * SS
    canvas = gradient(pal["sky_stops"], h, w)

    # A few faint stars up high, one mesh cell each once they reach the phone.
    if pal["stars"] > 0:
        count = 18
        sx, sy = RNG.integers(0, w, count), (RNG.random(count) ** 1.5 * h * 0.5).astype(int)
        sb = RNG.random(count)
        ys, xs = np.mgrid[0:h, 0:w].astype(float)
        star = np.zeros((h, w))
        for x, y, b in zip(sx, sy, sb):
            r = 2.4 * SS
            x0, x1 = max(x - 12, 0), min(x + 12, w)
            y0, y1 = max(y - 12, 0), min(y + 12, h)
            star[y0:y1, x0:x1] += np.exp(-(((xs[y0:y1, x0:x1] - x) ** 2 + (ys[y0:y1, x0:x1] - y) ** 2) / (r * r))) * (0.2 + b * 0.6)
        canvas = mix(canvas, rgb("#dfe5ff"), np.clip(star * pal["stars"], 0, 1))

    # A cloud far off behind the record.
    canvas = cumulus(canvas, 0.88, 0.125, 0.21, 0.09, pal, 11, puffs=70)

    # The record and sleeve, tilted like something falling slowly through the air.
    center = (w * 0.395, h * 0.395)
    size = w * 0.205
    plane = dict(rot_deg=-16, tilt_x=0.05, tilt_y=-0.04)
    u, v = plane_coords(w, h, center, size, **plane)

    # Card thickness: the same outline, nudged down and right, in shadow.
    tu, tv = plane_coords(w, h, (center[0] + 2.0 * SS, center[1] + 3.0 * SS), size, **plane)
    _, edge_mask, _ = sleeve(tu, tv, pal, 21)
    canvas = mix(canvas, rgb(pal["rim"]), edge_mask)

    disc, disc_mask, _ = record(u, v, 1.42, pal["ambient"], 31)
    canvas = mix(canvas, disc, disc_mask)

    paper, paper_mask, _ = sleeve(u, v, pal, 21)
    # The sleeve's edge shades the disc just where it comes out.
    shade = (1 - smooth(0.0, 0.16, u - 1.0)) * disc_mask * (1 - paper_mask)
    canvas = mix(canvas, np.zeros(3), shade * 0.55)
    canvas = mix(canvas, paper, paper_mask)

    # Clouds in front, so the record sits inside the scene.
    canvas = cumulus(canvas, 0.07, 0.668, 0.33, 0.105, pal, 5, puffs=120)
    canvas = cumulus(canvas, 0.92, 0.75, 0.44, 0.21, pal, 8, puffs=150)

    img = Image.fromarray((np.clip(canvas, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")
    return np.asarray(img.resize((W, H), Image.LANCZOS))


def render_badge(size: int = 108) -> np.ndarray:
    """The label's record, front on, small enough to sit inside the headline."""
    s = size * 4
    ys, xs = np.mgrid[0:s, 0:s].astype(float)
    u, v = (xs - s / 2) / (s / 2) * 0.92, (ys - s / 2) / (s / 2) * 0.92
    col, mask, _ = record(u, v, 0.0, 1.0, 41)
    # Larger label than the real proportion: at 30pt this has to read as amber.
    r = np.hypot(u, v) / 0.92
    th = np.arctan2(v, u)
    amber = mix(rgb("#ff9a2e"), rgb("#c6410b"), smooth(0.02, 0.52, r))
    amber = mix(amber, rgb("#ffd98a"), np.power(np.abs(np.cos(th + 1.05)), 8) * 0.62)
    label = 1 - smooth(0.5, 0.515, r)
    col = mix(col, amber, label)
    col = mix(col, rgb("#120a05"), 1 - smooth(0.07, 0.085, r))
    rgba = np.dstack([np.clip(col, 0, 1), mask])
    img = Image.fromarray((rgba * 255 + 0.5).astype(np.uint8), "RGBA")
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "assets/images")
    out.mkdir(parents=True, exist_ok=True)
    for name in ("night", "morning"):
        Image.fromarray(render_scene(name)).save(out / f"welcome-{name}.jpg", quality=92, subsampling=0)
    render_badge().save(out / "welcome-record.png", optimize=True)


if __name__ == "__main__":
    main()
