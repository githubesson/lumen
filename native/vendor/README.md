# Vendored crates

## `rune/`: Rune's core crate, patched

[Rune](https://github.com/anomalyco/rune) (MIT, `rune/LICENSE`) at upstream rev
`59f0326b8a12f360736e5ca29a09fad29ad73d71` (`crates/rune`, `dev` on 2026-11-07), the rev
`Cargo.toml` pins. Our
`rune` git dependency is routed here by `[patch."https://github.com/anomalyco/rune"]` in
`native/Cargo.toml`; Rune's other crates (`rune-motion`, `rune-staging`, `rune-taffy`,
`procwatch`) still come from git at the same rev, so our own `rune-motion` dependency unifies
with the one vendored Rune uses.

Docs: upstream's `crates/rune/README.md` (also in the cargo checkout,
`~/.cargo/git/checkouts/rune-*/59f0326/crates/rune/README.md`).

### What was copied, and what was left out

Copied from `crates/rune`: `Cargo.toml`, `src/`, `assets/` (the embedded Inter and IBM Plex Mono
fonts and their licences) and the precompiled DX12 uber shader (`uber.vs.dxbc`, `uber.fs.dxbc`);
`LICENSE` from the repo root. Everything an `include_bytes!`/`include_str!` outside a test
module reads is kept (the `.metallib`s, `.wgsl`s, fonts, `.dxbc`).

Left out, as the build doesn't need them: `README.md`, `examples/`, `tests/`, `artifacts/`, and
the in-source tests (every `src/**/tests/` directory, `*_tests.rs`, `tests.rs` and the
`*_data/` fixtures they read). Each of those modules is declared under `#[cfg(test)]`, so
nothing else changes; `cargo test` in `native/` doesn't run Rune's own tests.

`Cargo.toml` changes (needed to build outside Rune's workspace):

- `edition.workspace`/`license.workspace` → `edition = "2024"`, `license = "MIT"`.
- Path dependencies on sibling crates (`procwatch`, `rune-motion`, `rune-staging`,
  `rune-taffy`) → `git = "https://github.com/anomalyco/rune", rev = "<the rev above>"`.
- `[lints] workspace = true` → the workspace's `[workspace.lints]` tables, inlined, plus
  `dead_code = "allow"`: cargo prints a path dependency's warnings (it hid them for the git
  dependency), and release builds off macOS leave two upstream `tooling/perf_warn` methods
  unused.
- Dropped `[dev-dependencies]` (and their target tables), `[[example]]` and `[[test]]`.

### Bumping Rune

1. In a clone of Rune, check out the old rev, copy over it every file of `vendor/rune/src`
   that differs or is new (the test files left out stay upstream's), and commit: that commit is
   our patches. Cherry-pick it onto the new rev; git merges the hooks, and a conflict is
   usually upstream moving the code a hook sits in (in `59f0326`, `Host::try_create` moved
   from `src/window.rs` to `src/window/create.rs`).
2. Copy the result's `crates/rune` as above (same exclusions, no empty folders), merge the
   `Cargo.toml` changes into the new manifest (`git merge-file` with the old upstream manifest
   as the base), and set the rev in `vendor/rune/Cargo.toml` and `native/Cargo.toml`
   (`rune`, `rune-motion`). Keep `rust-toolchain.toml` in step with Rune's.
3. Check: `cargo build`, `cargo test`, `cargo build --release --target x86_64-pc-windows-gnu`,
   and every reference scene's `--snap` render against the previous build's (`tools/sweep.mjs`);
   explain each change from upstream's changelog (`changelog/unreleased/`).

The bump to `59f0326` (from `4ca6835`) brought DirectWrite text on Windows, which the app now
uses (it had forced CoreText-style smoothing there to approach Chromium's weight), and borders
drawn over the fill and snapped to device pixels. On Linux, text with smoothing off now raises
glyph coverage to an exponent keyed to the text's luminance, as Chromium's grayscale text does
on Windows: light text on dark draws heavier. Against the Linux Chromium reference shots that
cost the dark scenes about 0.07 points of pixels past 32/255 on average (light scenes ±0.01).

### Patches

Every hook in an upstream file carries a `Lumen patch` comment; `grep -rn "Lumen patch"`
finds them all.

#### Windows: the steady present hold starts on input only

On Windows, a window keeps presenting at the display's rate for a second after a change
(`STEADY` in `src/window/draw.rs`), so G-SYNC/FreeSync in windowed mode don't swing the
refresh rate (and some panels' brightness) on a hover's lone presents. Upstream restarted
that hold on every frame that drew something new. The player's elapsed time changes once a
second, so while music played the window never rested: a full-window render and present at
the monitor's refresh rate (27% GPU in Task Manager on a Windows desktop). Now only user input (pointer,
wheel, keys, touch, IME, pinch) starts or extends the hold. Changes from timers, live values
and other threads present once, as on the other platforms. Measured with the Windows logic
enabled on Linux (Xvfb, 60 Hz): playing with the mouse idle went from ~64 presents a second
to 2; paused or idle stays at 0.

Hooks in upstream files (all `#[cfg(target_os = "windows")]`):

- `src/window/win.rs`: `Win::steady_input` replaces `Win::steady_frame`;
  `src/window/create.rs` initialises it.
- `src/window/events.rs`: `handle_window_event` sets it for input events.
- `src/window/draw.rs`: the `steady` block starts the hold from it, and the hold's redraw no
  longer marks a held frame.

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
rectangle's own corner arc. The module's tests cover the cases above (they don't run here, as
Rune's in-source tests are left out; run them by copying the module into a scratch crate).

Renders of every scene, scrolled variants, and scales 1.25 and 1.5 match the unpatched build
to within 2/255 per channel. The differences are the composite rounding of the layers that
are gone. The app's content viewport now also clips its bottom-left corner with the
padding-box radius (`ui::kit::scroll_area_clipped`), as `.main`'s `overflow: hidden` does.
That's what keeps the page out of a layer, and it brings that corner closer to the Electron
reference. Scrolling Tracks under lavapipe: offscreen memory 11.8 MB → 0.3 MB a frame, GPU
time a frame about 38% lower.

Hooks in upstream files:

- `src/runtime.rs`: `mod round_clip`.
- `src/runtime/paint/build.rs`: `settle_rounds` replaces the central-strip loop before the
  backdrop blur.

#### Windows redraw only what changed

Upstream renders every pixel of the window each frame, so a cover fading in, a hover or the
clock ticking costs a whole-window render. A page of covers loading (each fades in over
180 ms, as the web's `.cover-art-img` does) drives that at the display's rate for seconds.
`src/render/partial.rs` (new) gives each window a canvas texture that keeps the last frame's
pixels. Each frame compares its instances with the last frame's, keeping their order. The
damage is the screen areas of what was added, removed or changed (per kind, as `base_vs`
grows its quad, inside the clip), a changed layer marker's whole scope, and images whose atlas
rows were rewritten. It is kept as up to 8 rectangles: pairs merge when their hull wastes
under 64×64 px, or the least wasteful pair while there are more than 8. Each rectangle is
cleared and redrawn under a scissor with every instance in order. `ActivePass` keeps every
nested scissor inside it, and the canvas is then copied into the drawable. A frame that
changes nothing only copies.

An instance inside layers reaches the screen through each of them. A blurred layer spreads
it by its blur's reach and a turned layer turns it, so damage inside them stays local (the
lyrics' blurred lines, rotated spinners and tooltip tips). A backdrop blur samples what is
under it. When damage reaches that region, the region joins the damage and the frame
redraws as one rectangle on an owned pass, which the blur can split to copy its backdrop.
`ActivePass::scissor` and the split's re-opened pass stay inside the damage, so a blur the
damage doesn't reach draws nothing there. Only what can't be bounded draws whole:
compositors, native surfaces and materials, effect slots and cached subtrees, none of which
Lumen uses. So do a new canvas, a changed key (size, format, clear colour, blending, scale),
a glyph atlas page starting over, and damage over 85% of the window (a dialog's scrim, a
page's entrance fade, scrolling).

`RUNE_PARTIAL=off` draws every frame whole as upstream does. `verify` also draws each partial
frame whole and prints any pixel that differs. `stats` prints, each second, how frames were
drawn and how many windows' worth of pixels they redrew. In verify mode, windowed runs under
Xvfb/lavapipe matched a full redraw on every partial frame (404, 120 of them with several
rectangles). The runs covered the Albums grid loading 962 generated covers and scrolling, the
Tracks list scrolling, and a tour of tooltips, row hovers, a context menu, playback, the
lyrics view, Settings, the palette's backdrop blur, search and navigation. Screenshots of
the presented window are identical with it on and off. Over that tour the frames redrew 31%
of what whole frames would have. On the Albums load, GPU time went down 43% over the run, and
quiet frames cost under 1 ms instead of 7–12 ms (lavapipe).

Hooks in upstream files:

- `src/render.rs`: `pub(crate) mod partial`.
- `src/render/pass.rs`: `ActivePass::bounded`; `set_scissor`, `scissor` and the pass a
  backdrop split re-opens stay inside the damage.
- `src/window/win.rs`, `src/window/create.rs`: `Win::partial`, created with the window (the
  GPU device lives and dies with it).
- `src/window/draw.rs`: the image atlas rows a frame rewrites are taken before
  `upload_images`; the non-compositor branch draws through `Partial::draw`, falling back to
  `Renderer::draw`; the compositor branch invalidates the canvas.
- `src/window.rs` (`surface_config`): the drawable takes `COPY_DST` where the surface allows
  it, so the canvas is copied in rather than drawn.
