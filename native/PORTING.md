# Porting the frontend to Rune

`native/` is Lumen's desktop client rebuilt with [Rune](https://github.com/anomalyco/rune)
(a GPU-drawn Rust UI framework). The goal is a 1:1, pixel-for-pixel copy of the
Electron app in `frontend/` with full feature parity, Windows first.

## Ground rules

- **The web app is the spec.** Port behaviour from the React component and its CSS rule by
  rule: sizes, paddings, gaps, radii, colours, font sizes and weights, hover/active/disabled
  states, transitions, copy (every string verbatim), keyboard behaviour, empty, loading and
  error states. When in doubt, read the CSS, then check the reference screenshot.
- **One module per web component or page**, named after it, with a doc comment naming the
  file it ports (`//! \`TrackList.tsx\` (\`library.css\`)`). Keep Rust files under ~800 lines.
- Strings, labels and help texts match the web app exactly (including `…` and `·`).
- Never hand-write or invent song lyrics or other copyrighted text; lyrics only come from the
  server.

## Layout of the crate

| Path | What |
| --- | --- |
| `src/app.rs` | `App` state, root view, `poll`, scenes, `AppSpec` |
| `src/route.rs` | `Location` (path + query, like the web URL) and `History` |
| `src/theme.rs` | Tokens from `tokens.css` (`Theme`, `Palette`, `color_mix`) |
| `src/ui/` | Text helpers (`font`, `line`, `label`), widgets (`iconbtn`, `Btn`, `input`, `cover_art`, `kbd`, `css_border`), lucide icons (`ui::icons`, generated) |
| `src/api/` | HTTP client (cookies persisted), payload types, media URLs |
| `src/net.rs` | Background work: `app.net.run(work, done)`; results land in `poll` |
| `src/images.rs` | Cover cache: `app.images.get(url)` |
| `src/shell/` | Sidebar, top bar, window controls, player bar |
| `src/pages/` | Routed pages; `pages::enter` starts a page's requests |
| `src/player/` | Player state (and the audio engine) |
| `src/desktop/` | What Electron's main process did |

## Conventions

- **Views** are `fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El`. `let t = app.theme();`
  is done once at the root and passed down.
- **Handlers** mutate `&mut App`: `.on_press(|app: &mut App| ..)`,
  `.on_press_tx(|app, tx| ..)` when a `Tx` is needed.
- **Requests**: never block the UI thread. `app.net.run(move || client.get::<T>(path), |app, r| ..)`.
  Clone `app.client` into the closure. In headless scenes the runner is synchronous, so
  scenes load their data before the first frame.
- **Navigation**: `app.navigate_to("/library?view=albums")`, `app.navigate_replace(loc)`,
  `app.back()`. A page's `enter(app, &loc)` runs on every navigation to it.
- **Page state** lives in its own struct inside `pages::Pages` (`app.pages.library`, …).
- **Text**: `ui::font(size, weight)` gives Geist with the body's `line-height: 1.45`; use
  `ui::with_lh` for rules that set another line height. `ui::line` truncates with an
  ellipsis (`white-space: nowrap; text-overflow: ellipsis`). `ui::tnum` for tabular numbers.
  `ui::mono` for `.mono` / `--font-mono`.
- **Icons**: `ui::ico(&icons::HEART, 16.0, colour)`. `size-3` = 12, `size-3.5` = 14,
  `size-4` = 16. Filled variants (`PLAY_FILLED`, `HEART_FILLED`, …) match the CSS that fills
  them. Missing icons: add the name in `tools/gen-icons.mjs` and rerun
  `node tools/gen-icons.mjs ../frontend /home/esson/lumen/frontend/node_modules/lucide-react`.
- **Borders**: Rune's `.border(w, c)` replaces the fill under the ring (a translucent ring
  shows the *parent*), which is CSS with `background-clip: padding-box` (e.g. `.btn`). A plain
  CSS `border` paints over the element's own background: use `ui::css_border(el, w, c, radius)`
  (add the width to the element's padding, since CSS borders take layout space;
  `box-sizing: border-box` is global in the web app). `ui::css_border_bottom` for hairlines.
- **Hover**: `.hover(colour)` draws an overlay over the fill while hovered. CSS that swaps
  `background` on hover needs the overlay that composites to the new colour:
  `ui::hover_overlay(base, target)`. Text/icon colour on hover: `.group_color(c)` on the child
  (the parent with `.hover` is the group). Transitions: `ui::motion::{ease, ease_out, …}`.
- **Pixels**: CSS px = Rune points. Windows at 100% scale is 1:1.
- **Colours**: take every colour from `t.c` (the tokens). `color_mix(a, p, b)` is CSS
  `color-mix(in oklch, a p%, b)`.

## Checking your work: pixel diffs against the Electron app

1. Mock API (the UI-lint fixtures, `frontend/tests/ui/mock-api.ts`, over HTTP):
   `frontend/node_modules/.bin/jiti native/tools/mock-server.ts --port 4791 &`
   (check `curl -s 127.0.0.1:4791/api/auth/me` first; it may already run. Never put the
   server's command line in the same shell command as a `pkill -f` for it.)
2. Reference shots of the React app (Electron bridge stubbed as win32, 1280×820):
   add a scene to `native/tools/reference/scenes.ref.ts`, then
   `cd native/tools/reference && TMPDIR=~/.cache/pwtmp ../../../frontend/node_modules/.bin/playwright test -g <scene>`
   → `native/out/ref/<scene>-{dark,light}.png`. It starts Vite on port 4792 itself.
3. The same scene in Rune: add it to `SCENES` in `src/app.rs` (or your module's scene list),
   then `cargo build && LUMEN_DATA_DIR=$PWD/out/data ./target/debug/lumen --snap out/rune/<scene>-dark.png --scene <scene> --size 1280x820 --scale 1 --theme dark`
   (`--theme light` for light).
4. Diff: `node tools/diff.mjs out/ref/<scene>-dark.png out/rune/<scene>-dark.png out/<name> [--crop x,y,w,h] [--zoom 3]`
   writes `<name>-side.png` (reference | rune | diff). `node tools/px.mjs a.png b.png x,y …`
   prints pixels. Look at the side-by-side; fix layout and colour first, then details.

Rune renders headless with `--tree out.json` (element tree, rects) and `--script s.json`
(scripted input: clicks, keys, typing) — see Rune's README "Agent tooling". Use them to test
interactions (hover states, menus, dialogs) in both the reference and the port.

## Rune

Docs: `~/src/rune/crates/rune/README.md` (core) and `crates/rune-kit/README.md`; the pinned rev
is checked out under `~/.cargo/git/checkouts/rune-*/4ca6835/`. Read the source when the README
is thin. Rune is pre-release; work around gaps in this crate rather than patching Rune.

## Building for Windows

`cargo build --release --target x86_64-pc-windows-gnu` cross-compiles from Linux (mingw).
CI builds the MSVC target on Windows runners.
