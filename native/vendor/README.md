# Vendored crates

## `rune/`: Rune's core crate, patched

[Rune](https://github.com/anomalyco/rune) (MIT, `rune/LICENSE`) at upstream rev
`4c72ab576426495e3bfa0696a5b745dd3abba0aa` (`crates/rune`, `dev` on 2026-11-21), the rev
`Cargo.toml` pins. Our `rune` git dependency is routed here by
`[patch."https://github.com/anomalyco/rune"]` in `native/Cargo.toml`; Rune's sibling crates
(`rune-core`, `rune-edit`, `rune-gpu`, `rune-image`, `rune-media`, `rune-motion`, `rune-spell`,
`rune-staging`, `rune-taffy`, `rune-text`, optional `procwatch`) still come from git at the same
rev, so our own `rune-motion` dependency unifies with the one vendored Rune uses.

Because Cargo ignores `[patch]` in dependencies, `native/Cargo.toml` also carries upstream Rune's
six `[patch.crates-io]` entries (`wgpu-hal`, `winit`, `sctk-adwaita`, `parley_engine`,
`accesskit_windows`, `accesskit_macos`), all resolved directly from git at the pinned rev.

Docs: upstream's `crates/rune/README.md` (also in the cargo checkout,
`~/.cargo/git/checkouts/rune-*/4c72ab5/crates/rune/README.md`).

### What was copied, and what was left out

Copied from `crates/rune`: `Cargo.toml`, `build.rs`, `src/`, and the precompiled DX12 shaders
(`shaders/dxbc/*.dxbc`); `LICENSE` from the repo root. Everything `build.rs` or an
`include_bytes!`/`include_str!` outside a test module reads is kept (the `.metallib`s, `.wgsl`s,
cursor `.png`s, and `.dxbc`s). `assets/` is omitted: bundled fallback fonts moved into `rune-text`
and are gated natively by `embedded-fonts`.

Left out, as the build doesn't need them: `README.md`, `examples/`, `tests/`, `assets/`,
`artifacts/`, and the in-source tests (every `src/**/tests/` directory, `*_tests.rs`, `tests.rs`
and the `*_data/` fixtures they read). Each of those modules is declared under `#[cfg(test)]`, so
nothing else changes; `cargo test` in `native/` doesn't run Rune's own tests.

`Cargo.toml` changes (needed to build outside Rune's workspace):

- `edition.workspace`/`license.workspace` → `edition = "2024"`, `license = "MIT"`.
- `{ workspace = true }` external dependencies → exact version and feature specs from upstream's
  root `Cargo.toml`.
- Path dependencies on sibling crates (`procwatch`, `rune-core`, `rune-edit`, `rune-gpu`,
  `rune-image`, `rune-media`, `rune-motion`, `rune-spell`, `rune-staging`, `rune-taffy`,
  `rune-text`) → `git = "https://github.com/anomalyco/rune", rev = "<the rev above>"`.
- `[lints] workspace = true` → the workspace's `[workspace.lints]` tables, inlined, plus
  `dead_code = "allow"` (cargo prints a path dependency's warnings).
- Dropped `[dev-dependencies]` (and their target tables), `[[example]]` and `[[test]]`.

### Bumping Rune

1. In a clone of Rune, check out the old rev, copy over it every file of `vendor/rune/src`
   that differs or is new (the test files left out stay upstream's), and commit: that commit is
   our patches. Cherry-pick it onto the new rev (or audit each `Lumen patch` hook directly);
   retire any patch upstream has since solved.
2. Copy the result's `crates/rune` as above (same exclusions, no empty folders), update
   `vendor/rune/Cargo.toml` for standalone building, and set the rev in `vendor/rune/Cargo.toml`
   and `native/Cargo.toml` (`rune`, `rune-motion`, `[dev-dependencies] rune`, and
   `[patch.crates-io]`). Keep `rust-toolchain.toml` in step with Rune's.
3. Check: `cargo build`, `cargo test`, `cargo build --release --target x86_64-pc-windows-gnu`,
   `RUNE_PARTIAL=verify` in a live window, and reference scenes' `--snap` renders against the
   previous build and Chromium references (`tools/sweep.mjs`); explain each change from upstream's
   changelog (`changelog/unreleased/`).

#### Bump history

- **`59f0326` → `4c72ab5` (2026-11-21):**
  - **Retired two Lumen patches:** Windows steady-present hold (`STEADY` removed upstream in
    `2026-11-13-windows-no-steady.md`) and the native `embedded-fonts` gate (fonts moved to
    `rune-text` and gated natively in `2026-11-12-binary-backends-fonts.md`).
  - **Dependency & binary wins:** Linux D-Bus switched from `zbus 6` + `tokio` to `zbus 5.19` +
    `async-io` (unifying with Lumen's MPRIS and `accesskit_unix` and dropping `tokio` entirely);
    Windows dropped the Vulkan fallback (`ash`), ICU4X CJK word dictionaries (uses Windows'
    `icu.dll`), and `keys-overlay` (cutting stripped Windows `lumen.exe` by ~13 MB, from 61.7 MB
    `dist` down to 48.7 MB even in non-LTO `release`). `tooling` stays enabled on `rune` so
    release builds keep `--snap`/`--tree`/`--script` for CI and `tools/sweep.mjs`.
  - **Visual improvements:** Upstream switched default text on Windows/Linux to `WindfoilChromium`
    (`2026-11-09-text-windfoil-default.md`), made exact line heights and 1/64 px text widths/origins
    default (`2026-11-08-exact-lines-default.md`, `2026-11-14-text-exact-origin.md`,
    `2026-11-14-text-width-64.md`), aligned resting SVG icons and hairline strokes with Chromium
    (`2026-11-11-icon-grid.md`, `2026-11-11-icon-hairline.md`, `2026-11-12-icon-rect.md`), and
    moved uber/backdrop/corner shaders to exact `@builtin(position)` pixel centres
    (`2026-11-20-shader-exact-pixel-center.md`). Every one of 17 tested scenes with Chromium
    references improved against Chromium by 0.04–0.71 points (>32/255), with zero regressions.
- **`4ca6835` → `59f0326` (2026-11-07):** brought DirectWrite text on Windows, borders drawn over
  fill and snapped to device pixels, and luminance-keyed Linux gamma with smoothing off.

### Patches

Every hook in an upstream file carries a `Lumen patch` comment; `grep -rn "Lumen patch"`
finds them all.

#### Rounded clips settle per corner instead of opening layers

An instance carries one clip rectangle whose corners may round. Upstream drops a rounded mask
only when the clip lies wholly in one of the mask's central strips; any other clip that isn't
exactly the mask opens an offscreen layer (an Rgba16Float target, its own render pass, then a
composite), and so does an element that rounds its own clip inside another rounded clip. In
Lumen that put the whole main panel (`main`, rounded inside the window's rounded `app`) and
the whole page (the scroll viewport, cut below the topbar) into layers every frame, plus one
per track row (a `clip_rounded(0.0)` column). Scrolling the Tracks list drew 10–16 layers a
frame, two of them window-sized.

`src/runtime/paint/round_clip.rs` (new) settles each corner of a mask against the rectangle
the element and its subtree paint in: the clip, narrowed by the element's own rounded clip.
A corner whose square that rectangle misses, or whose arc it clears by the shader's half-pixel
antialiasing (`clip_alpha` in `clip.wgsl`), becomes square; a corner it shares keeps its arc,
now on the rectangle itself. Only an arc that crosses the rectangle elsewhere still opens the
layer. Rounded rectangles are convex, so clearing an arc is a farthest-point test on the
rectangle's own corner arc.

Hooks in upstream files:

- `src/runtime/paint.rs`: `pub(super) mod round_clip`.
- `src/runtime/paint/build/layers.rs`: `settle_rounds` replaces the central-strip `strip_round_mask`
  calls before the backdrop blur.

#### Cross-platform partial window redraws (with transparent-window clear & Windows `Present1`)

Upstream added Windows-only partial frames (`render/damaged.rs` + `window/win32/damage.rs`), but
its clearing quad uses the premultiplied-alpha draw pipeline (which cannot clear Lumen's
`transparent: true`, `[0, 0, 0, 0]` clear-colour window), skips partial redraws whenever a frame
contains blurred layers (lyrics) or backdrop blurs (command palette), and does not run on Linux or
macOS.

`src/render/partial.rs` (new) gives each window on every platform a canvas texture that keeps the
last frame's pixels. Each frame compares its instances with the last frame's (reusing the previous
frame's cached `Analysis`, and skipping analysis and copying on byte-identical frames with no
dirty image atlas rows). The screen areas of what was added, removed or changed (using upstream's
WGSL-derived `Instance::damage_quad_bounds`), a changed layer marker's whole scope, and images
whose atlas rows were rewritten are gathered into up to 8 rectangles. Each rectangle is cleared
with a dedicated `BlendState` = replace shader (correctly clearing transparent pixels) and redrawn
under a scissor with every instance in order. `ActivePass` keeps every nested scissor inside it
(including across owned backdrop-blur splits), and the canvas is then copied into the drawable. On
Windows, `Partial::draw` also feeds its dirty rectangles into `prepared.present_rect` so DX12
presents via `Present1` dirty rects (tracking `configure::generation` in `Partial`'s key so a fresh
or rebound swap chain always presents whole first).

An instance inside layers reaches the screen through each one: blurred layers spread damage by
their blur's reach and turned layers turn it, so damage inside them stays local. A backdrop blur
that damage reaches joins the damage and redraws as one rectangle on an owned pass. Only what
can't be bounded draws whole: compositors, native surfaces/materials, effect slots, cached
subtrees, new/resized/reconfigured canvases, glyph atlas resets, and damage over 85% of the window.

`RUNE_PARTIAL=off` draws every frame whole; `verify` also draws each partial frame whole and
reports any differing pixel; `stats` prints per-second partial-redraw statistics.

Hooks in upstream files:

- `src/render.rs`: `pub(crate) mod partial`.
- `src/render/instance.rs`: expose `Instance::damage_quad_bounds` on all platforms (not only Windows).
- `src/render/pass.rs`: `OpenPass::bound`, `ActivePass::bounded`; `set_scissor`, `scissor` and the
  pass a backdrop split re-opens stay inside the damage bound.
- `src/window/surface/win.rs`, `src/window/host/create.rs`, `src/window/win32/cpu_frame.rs`:
  `Win::partial`, created with the window, reset on `Host::reattach` (new GPU device), and
  invalidated on `Host::rebind_alpha`.
- `src/window/host/render.rs`: capture `image_dirty` before `upload_images`; non-compositor frames
  draw through `Partial::draw` (bypassing upstream's Windows `l.native.damage` to avoid a second
  retained canvas, and wiring `Partial`'s rects to Windows `Present1`); compositor frames
  invalidate the canvas.

#### Return activates a focused element link

Return went to a focused rich-text link, a `focus_highlight` row or a list item, but not to an
element with `role("link")` (a sidebar nav item, a breadcrumb, Home's "Jump back in" cover): Tab
drew its ring, and Return pressed the window's default button instead, or nothing.
`RuntimeCore::takes_return` now counts `role == "link"` too.

Hooks in upstream files:

- `src/runtime/input/focus.rs`: `takes_return`.

#### Wayland: poll past a frame the compositor never answers

A Wayland compositor may stop sending frame callbacks to a window it doesn't show (another
workspace, hidden or minimised) without reporting it occluded, so winit never delivers the redraw
asked for. Upstream's `TimerFrame::stalled` now handles due timers on covered Wayland surfaces,
but `AppHandle::wake` (used by MPRIS and media keys) still asks for a frame without polling until
that frame arrives. `src/window/redraw_watch.rs` (new) notes when a frame asked for a wake or
timer goes unanswered; once it is 250 ms overdue, the host polls without it, once at that deadline
and then at each wake and due timer, as for a hidden window, while still asking for the frame.
Each of those polls also drops the runtime's loop wake (`RuntimeCore::drop_loop_wake`), so an
on-screen loop (e.g. a spinner) doesn't poll at ~60 Hz while hidden. The first frame that arrives
clears the watch. Only Wayland arms the watch.

Hooks in upstream files:

- `src/window.rs`: `mod redraw_watch`.
- `src/window/host.rs`: `Host::redraw_watch`.
- `src/window/host/any_host.rs`: `new_events_in_turn` runs the overdue frame's poll and takes the
  hidden path while overdue (dropping the loop wake), and timer frames arm the watch;
  `wake_deadline` wakes for it.
- `src/runtime/motion/timer_wake.rs`: `RuntimeCore::drop_loop_wake`.
- `src/window/host/lifecycle.rs`: `poll_hidden` polls a shown window whose frame is overdue
  (dropping the loop wake); `drain`'s `WakeWork::Paint` arms the watch.
- `src/window/host/events.rs`: `RedrawRequested` clears it.

#### Empty blurred-layer elision in `end_layer`

`src/render/instance.rs` (`end_layer`): elides empty non-cached layer scopes
(`primitives + videos == 0 && scope.params[3] == 0.0`) even when `blur > 0.0` (e.g. off-screen
blurred lyrics lines) or blend/turn/cutout/clip is set, since an empty layer composites
transparent black.
