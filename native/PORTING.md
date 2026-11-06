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
- **Text boxes and baselines** (measured against Chromium; see `examples/calib.rs`):
  Rune places a line's glyphs within 0.3 px of Chromium for the same box top, but rounds
  every text box up to whole pixels (20.3 → 21, 17.4 → 18). Two consequences:
  - *Stacked lines drift*: hold each line in a box of its CSS height, `ui::exact(text, lh)` /
    `ui::exact_text(..)` (or `ui::css_text_h` for wrapped text), so what follows sits where
    the browser puts it.
  - *Centred lines snap a pixel high*: a row that centres a text (`align-items: center`)
    starts Rune's rounded box half the rounding above the browser's, and both engines snap
    the baseline to a whole pixel, often the one above. Wrap such text in
    `ui::centred(text, style)` (a draw-only nudge of half the rounding).
  - Never hand-tune glyph offsets against a reference shot; measure with
    `node tools/centroid.mjs ref.png rune.png x,y,w,h` (ink centroid, sub-pixel) and compare
    layout boxes with `--tree` against the DOM (`tools/reference/rects.ref.ts`, which prints
    `getBoundingClientRect` for `RECT_SEL` on `RECT_PATH`).
- **Colours**: take every colour from `t.c` (the tokens). `color_mix(a, p, b)` is CSS
  `color-mix(in oklch, a p%, b)`.

## Shared components

| Module | Ports | Use |
| --- | --- | --- |
| `ui::track_list` | `TrackList.tsx` | `TrackList::new("key", \|a\| &a.pages.x.tracks).view_gap(18.0).empty(el).page(app, t, head, tail)` as a page's whole view (virtual rows), or `.build(app, t)` inside a page for short lists. `.queue`, `.no_cover`, `.no_album`, `.headless`, `.not_selectable`, `.no_source_badge`, `.bar_elsewhere`, `.omit_artists`, `.extra(Extra { .. })`. |
| `ui::track_select` | `useTrackSelection`, `TrackSelectionToolbar`, `TrackCheckbox` | Selection lives in `app.widgets.lists` by list key; `selection_bar(app, t, key, source, BarPlace::Group)` for a toolbar group, `checkbox(..)`. |
| `ui::track_row` | `TrackRowCells.tsx`, `TrackRow` | `index_cell`, `playing_bars`, `favorite_button`, `badge`, plus `actions`, `play_from`, `start_list`, `is_local`, `can_share` (`core/track.ts`). |
| `overlays::track_menu` | `TrackContextMenu.tsx` | `track_menu::open(app, track, [x, y], MenuContext { queue, edit, move_to_album, info, share, selection })` from `.on_secondary_press`. |
| `ui::tooltip` | `TitleTooltips.tsx`, `Tooltip.tsx` | `use crate::ui::tooltip::TipExt;` then `el.tip("its-key", "Text")`, `.tip_side(.., Side::Right)`, `.tip_truncated(key, text, style)` (truncation hints), `tooltip::tip_body(el, key, Body::..)`. Don't use Rune's `.help`. |
| `ui::cards` | `MediaCard`, `PlaylistCard`, `TopArtist` | `MediaCard::new(key, title).to(href).cover(url).subtitle(s).on_play(label, f).build(app, t)`, `media_card_placeholders`, `playlist_card(app, t, &p)`, `top_artist_glyph`, `square_art`. |
| `ui::shelf` | `ShelfScroller` | `shelf(app, t, key, "Top artists", cards, SHELF_COL)`. |
| `ui::blocks` | `Section`, `ListPageHeader`, `PageHeader`, `ListMeta`, `LoadMoreSentinel`, `DataState`, `CenteredCard`, `RadioCardOption`, `IosSpinner`, `AnimatedNumber`, `PlayListButton` | `section(..)`, `list_page_header(app, t, key, ListHeader { .. })`, `meta_line`, `page_header(t, title, count, actions)`, `list_meta`, `load_more`, `data_state`, `centered_card`, `radio_card`, `ios_spinner`, `animated_number(app, cx, key, value, style, ink)`, `play_list_button`. |
| `ui::chart` | `ActivityChart` | `activity_chart(t, key, &[Bar { start, plays }], Bucket::Day)`. |
| `ui::paging` | `usePaginatedList` | `Paginated<T>` in page state with `reset` / `load_more` / `reload` through an accessor and a `Fetcher`. |

Text boxes: Rune rounds a text's height up to whole pixels (17.4 → 18), which adds up down a
column of lines (a header's kind, title and meta). Wrap such lines in `ui::exact(text, lh)` to keep
the browser's fractional height; `ui::text_end` puts right-aligned text on its box's edge.

Reference scenes for interactions use `act` in `scenes.ref.ts` (`keepPointer` for hover) and a
script in `tools/reference/scripts/` on the Rune side:
`./target/debug/lumen --snap out/rune/favorites-menu-dark.png --scene favorites --script tools/reference/scripts/favorites-menu.json --at 1.0 …`.
Headless Chromium hides scrollbars, so the content's scrollbar thumb shows only in Rune's shots.

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

`tools/wine-snap.sh <scene>` renders a scene with the Windows `lumen.exe` under Wine (virtual
X display, Vulkan on lavapipe, d3d12 off: Wine's HLSL compiler lacks the shader-model 5.1
resource arrays Rune's blur layers use, which Windows' own FXC has). Its output should match
the Linux build pixel for pixel; it did for home, library and login (2026-11-06).

`cargo build --release --target x86_64-pc-windows-gnu` cross-compiles from Linux (mingw).
CI builds the MSVC target on Windows runners (`.github/workflows/native.yml`); packaging,
release asset names and the updater's rules are in `packaging/README.md`.

## The desktop layer (`src/desktop`)

What Electron's main process did. Services start once the window is up (`desktop::start`),
never in headless runs. Call these on the UI thread:

| Electron IPC | Native |
| --- | --- |
| `window:minimize` / `maximize-toggle` / `close` | `desktop::window::{minimize, toggle_maximize, close}(tx)` |
| `window:mini-player:set` | `window::set_mini_player(bool) -> MiniPlayerResult { ok, mini_player }` |
| `window:mini-player:panel-anchor` | `window::mini_player_panel_anchor() -> PanelAnchor` |
| `window:mini-player:panel` | `window::set_mini_player_panel(open) -> PanelResult { ok, open, anchor }` |
| `config:get` / `config:update` | `desktop::desktop_config(app)`, `desktop::update_config(app, ConfigPatch)` |
| `now-playing:new-token` | `desktop::new_now_playing_token(app)` |
| `config:test-server` | `desktop::test_server(url)` (blocks: run it on `app.net`) |
| `external:open` | `desktop::open_external(tx, url)` |
| `updates:get` / `save` / `check` / `download` / `install` | `app.desktop.updater.status()`, `desktop::save_update_config`, `updater::{check, download_update, install}` |
| `tracks:export-files` | `desktop::export::export_track_files(app, tx, items, done)` |
| `discord:activity` / `discord:clear` | none: `desktop::presence` watches `app.player` |

The Discord card preview uses `desktop::discord_card::DiscordCard::lines`, as Discord will.
