//! `PlaylistTracksPanel.tsx`: the Tracks tab's table (`library.css`
//! `.table-tracks`), with the playlist's own columns (Added, added-by,
//! remove), selection, and drag reorder (`useDragReorder.ts`).

use rune::{Cursor, Cx, El, Phase, Tx, col, el, row, text};

use crate::api::{Playlist, PlaylistTrackEntry, Visibility, media};
use crate::app::App;
use crate::format::{display_text, fmt_duration_ms};
use crate::theme::Theme;
use crate::ui::kit::empty_state;
use crate::ui::tooltip::TipExt;
use crate::ui::track_row::{action_button, favorite_button, idx_play, index_cell};
use crate::ui::track_select::{self, BarPlace};
use crate::ui::{css_border_bottom, exact, font, ico, icons as i, line, tnum};

use super::detail::{self, Detail, TRACKS_LIST, detail_mut, queue_source, shown_source};
use super::edits;
use super::logic::{Permissions, SortKey, fmt_date};

/// A drag in progress: the row picked up and the gap it would land in
/// (0..=rows; None while the pointer is off the rows).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DragState {
    pub from: usize,
    pub slot: Option<usize>,
    /// Past the 4 pt threshold: a drag, not a click.
    pub active: bool,
}

/// `useDragReorder`'s state (the selection is the shared list's,
/// [`detail::TRACKS_LIST`]).
#[derive(Default)]
pub struct State {
    pub drag: Option<DragState>,
}

fn selecting(app: &App) -> bool {
    app.widgets.lists.is_selecting(TRACKS_LIST)
}

/// The selection controls in the toolbar's host (`TrackSelectionToolbar`).
pub fn selection_host(app: &App, t: &Theme) -> El {
    track_select::selection_bar(app, t, TRACKS_LIST, shown_source, BarPlace::Group)
}

/// Whether the table is in selection mode (the toolbar group then holds
/// only the selection's controls).
pub fn is_selecting(app: &App) -> bool {
    selecting(app)
}

/// Play `track_id` with the table's queue.
fn play(app: &mut App, track_id: &str) {
    let queue = queue_source(app).to_vec();
    let Some(start) = queue.iter().position(|t| t.id == track_id) else { return };
    app.player.play_list(queue, start);
}

/// The column widths (`table-layout: fixed`): select, #, art, title, album
/// (25%), added, time, actions.
#[derive(Clone, Copy)]
struct Cols {
    select: f32,
    idx: f32,
    art: f32,
    title: f32,
    album: f32,
    added: f32,
    dur: f32,
    acts: f32,
}

fn cols(width: f32, selecting: bool) -> Cols {
    let w = width.max(720.0);
    let select = if selecting { 32.0 } else { 0.0 };
    let album = (w * 0.25).round();
    let fixed = select + 40.0 + 44.0 + 130.0 + 64.0 + 80.0;
    Cols { select, idx: 40.0, art: 44.0, title: (w - fixed - album).max(0.0), album, added: 130.0, dur: 64.0, acts: 80.0 }
}

/// A `<td>`/`<th>`: `w` wide with the 8 px side padding.
fn cell(w: f32) -> El {
    row().w(w).h_full().px(8.0).items_center().min_w(0.0)
}

fn header(app: &App, t: &Theme, c: &Cols, selecting: bool) -> El {
    let th = |s: &str| text(s.to_string()).font(font(12.0, 500.0)).color(t.c.muted_foreground);
    let mut h = row().key("playlist-thead").w_full().h(40.0).pb(1.0).fill(t.c.background);
    if selecting {
        let items = shown_source(app);
        let (all, some) = app.widgets.lists.selection(TRACKS_LIST).all_some(items);
        h = h.child(
            row().w(c.select).h_full().px(4.0).items_center().justify_center().child(
                track_select::checkbox(
                    t,
                    "playlist-select-all",
                    all,
                    some && !all,
                    if all { "Deselect all tracks" } else { "Select all tracks" },
                )
                .on_press(|app: &mut App| track_select::select_all(app, TRACKS_LIST, shown_source)),
            ),
        );
    }
    h = h
        .child(cell(c.idx).justify_end().child(th("#")))
        .child(cell(c.art))
        .child(cell(c.title).child(th("Title")))
        .child(cell(c.album).child(th("Album")))
        .child(cell(c.added).child(th("Added")))
        .child(cell(c.dur).justify_end().child(th("Time")))
        .child(cell(c.acts));
    css_border_bottom(h, 1.0, t.c.border)
}

struct RowCtx<'a> {
    c: &'a Cols,
    index: usize,
    count: usize,
    now: bool,
    playing: bool,
    selected: bool,
    selecting: bool,
    can_edit: bool,
    show_added_by: bool,
    reorderable: bool,
    drag: Option<DragState>,
    fav: bool,
}

/// Which edge of row `index` the drop line draws on, if any
/// (`dropEdgeFor`): hidden on the no-op slots around the dragged row.
fn drop_edge(drag: Option<DragState>, index: usize, count: usize) -> Option<bool> {
    let d = drag.filter(|d| d.active)?;
    let slot = d.slot?;
    if slot == d.from || slot == d.from + 1 {
        return None;
    }
    if slot == index {
        return Some(true);
    }
    (slot == index + 1 && index + 1 == count).then_some(false)
}

/// `PlaylistRow`.
fn track_row(app: &App, t: &Theme, e: &PlaylistTrackEntry, r: RowCtx) -> El {
    let c = r.c;
    let key = format!("pl-row-{}-{}", e.position, e.track_id);
    let ink = if r.now || r.selected { t.c.foreground } else { t.c.muted_foreground };
    let small = |s: String| text(s).font(tnum(font(12.0, 400.0))).color(ink);
    let artist = display_text(e.artist.as_deref(), "Unknown artist");
    let sub = match e.added_by.as_deref().filter(|_| r.show_added_by) {
        Some(by) => format!("{artist} · added by {by}"),
        None => artist,
    };
    let title = display_text(Some(&e.title), "");
    let id = e.track_id.clone();
    let play_id = id.clone();
    let play_btn = idx_play(t, &format!("{key}-play"), &format!("Play {}", e.title)).on_press(move |app: &mut App| play(app, &play_id));
    let index_cell = index_cell(t, &format!("{key}-idx"), r.index, r.now && r.playing, ink, Some(play_btn));
    let art_url = match e.album_id.as_deref() {
        Some(a) => media::album_cover_path(a, None, None),
        None => media::cover_path(&e.track_id, None),
    };
    let art_label = e.album_title.clone().filter(|a| !a.is_empty()).unwrap_or_else(|| e.title.clone());
    let album = e.album_title.as_deref().map(|a| display_text(Some(a), "")).filter(|a| !a.is_empty());
    let added = if e.added_at.is_empty() { "—".to_string() } else { fmt_date(&e.added_at) };

    let fav_key = format!("{key}-fav");
    let heart = favorite_button(app, t, &fav_key, &e.track_id, r.fav).tip(&fav_key, if r.fav { "Remove from favorites" } else { "Add to favorites" });
    let mut acts = row().gap(8.0).items_center().group_opacity(0.0, 1.0).child(heart);
    if r.can_edit {
        let position = e.position;
        let remove_key = format!("{key}-remove");
        acts = acts.child(
            action_button(t, &remove_key, "Remove from playlist")
                .child(ico(&i::TRASH_2, 14.0, t.c.muted_foreground).group_color(t.c.accent_foreground))
                .on_press(move |app: &mut App| edits::remove(app, position))
                .tip(&remove_key, "Remove from playlist"),
        );
    }

    // The cells' 1 px bottom border is inside the row height.
    let mut tr = row().key(key.clone()).w_full().h(t.row_h()).pb(1.0).cursor(Cursor::Pointer);
    if r.selecting {
        let (sel_index, sel_id) = (r.index, e.track_id.clone());
        tr = tr.child(
            row().w(c.select).h_full().px(4.0).items_center().justify_center().child(
                track_select::checkbox(t, &format!("{key}-check"), r.selected, false, &format!("Select {}", display_text(Some(&e.title), "track")))
                    .on_press_tx(move |app: &mut App, tx: &mut Tx| {
                        track_select::toggle_row(app, TRACKS_LIST, shown_source, &sel_id, sel_index, tx.mods().shift)
                    }),
            ),
        );
    }
    tr = tr
        // `.play-cell`: an 18 px inline-grid whose one track grows to the
        // 24 px play button, overflowing to the right and down.
        .child(cell(c.idx).justify_end().child(index_cell))
        .child(cell(c.art).child(crate::ui::cover_art(t, &app.images, Some(&art_url), &art_label, 32.0, 32.0, t.radius_md()).min_w(32.0).mb(1.0)))
        .child(
            cell(c.title).child(
                col()
                    .w_full()
                    .min_w(0.0)
                    // At their CSS line heights (Rune would round them to 21 and 18).
                    .child(exact(
                        line(title.clone(), font(14.0, 500.0), t.c.foreground).tip_truncated(&format!("{key}-title"), &title, font(14.0, 500.0)),
                        20.3,
                    ))
                    .child(exact(
                        line(sub.clone(), font(12.0, 400.0), t.c.muted_foreground).tip_truncated(&format!("{key}-sub"), &sub, font(12.0, 400.0)),
                        17.4,
                    )),
            ),
        )
        .child(cell(c.album).child({
            let a = line(album.clone().unwrap_or_else(|| "—".into()), tnum(font(12.0, 400.0)), ink);
            match album {
                Some(s) => a.tip_truncated(&format!("{key}-album"), &s, tnum(font(12.0, 400.0))),
                None => a,
            }
        }))
        .child(cell(c.added).child(line(added, tnum(font(12.0, 400.0)), ink)))
        .child(cell(c.dur).justify_end().child(small(fmt_duration_ms(e.duration_ms))))
        .child(cell(c.acts).justify_end().child(acts));
    tr = css_border_bottom(tr, 1.0, t.c.border);
    // Drop line: `inset 0 ±2px 0 var(--primary)` on the row's cells.
    if let Some(above) = drop_edge(r.drag, r.index, r.count) {
        let bar = el().h(2.0).fill(t.c.primary).inert();
        tr = tr.child(if above { bar.pin(Some(0.0), Some(0.0), Some(0.0), None) } else { bar.pin(Some(0.0), None, Some(0.0), Some(1.0)) });
    }
    if r.selected {
        tr = tr.fill(t.c.muted).hover_group();
    } else {
        tr = tr.hover(t.c.ghost_hover);
    }
    if r.drag.is_some_and(|d| d.active && d.from == r.index) {
        tr = tr.opacity(0.4);
    }
    let (index, count, selecting, reorderable) = (r.index, r.count, r.selecting, r.reorderable);
    let title_x = (c.select + c.idx + c.art, c.select + c.idx + c.art + c.title);
    let menu_track = e.as_track();
    let dbl_id = id.clone();
    tr.role("row")
        .on_drag(move |app: &mut App, g: &mut rune::Drag, tx: &mut Tx| {
            on_drag(app, g, tx, Gesture { index, count, selecting, reorderable, title_x, id: &id })
        })
        .on_double_press(move |app: &mut App| {
            if !selecting {
                play(app, &dbl_id);
            }
        })
        .on_secondary_press(move |app: &mut App, at, _tx| {
            // `bind(item, { queue, selection })`: the playlist offers no edits.
            let selection = crate::ui::track_list::menu_selection(app, TRACKS_LIST, shown_source, &menu_track);
            let ctx = crate::overlays::track_menu::MenuContext {
                selection,
                ..crate::overlays::track_menu::MenuContext::bind(&menu_track, queue_source(app).to_vec())
            };
            crate::overlays::track_menu::open(app, menu_track.clone(), [at.x, at.y], ctx);
        })
}

struct Gesture<'a> {
    index: usize,
    count: usize,
    selecting: bool,
    reorderable: bool,
    /// The title cell's left and right edge in the row: a click there plays.
    title_x: (f32, f32),
    id: &'a str,
}

/// A press on a row: a click toggles it (selecting) or plays it (on the
/// title); a drag past 4 pt picks it up and moves it.
fn on_drag(app: &mut App, g: &mut rune::Drag, tx: &mut Tx, r: Gesture) {
    let Some(d) = detail_mut(app) else { return };
    let s = &mut d.table;
    match g.phase {
        Phase::Down => s.drag = Some(DragState { from: r.index, slot: None, active: false }),
        Phase::Move => {
            let Some(drag) = s.drag.as_mut() else { return };
            if !drag.active && (!r.reorderable || (g.dx.abs() < 4.0 && g.dy.abs() < 4.0)) {
                return;
            }
            drag.active = true;
            // Rows are all one height, so the pointer's row is a whole
            // number of heights from the one picked up.
            let h = g.h.max(1.0);
            let at = r.index as f32 + g.y / h;
            drag.slot = (at >= 0.0 && at < r.count as f32).then(|| {
                let over = at.floor() as usize;
                if (at - over as f32) < 0.5 { over } else { over + 1 }
            });
            // Auto-scroll: keep the rows around the gap in view.
            if let Some(slot) = drag.slot {
                let rows = d.tracks.as_deref().unwrap_or(&[]);
                for n in [slot.saturating_sub(1), slot] {
                    if let Some(e) = rows.get(n) {
                        tx.scroll_into_view(format!("pl-row-{}-{}", e.position, e.track_id));
                    }
                }
            }
        }
        Phase::Up => {
            let Some(drag) = s.drag.take() else { return };
            if drag.active {
                if g.cancelled() {
                    return;
                }
                if let Some(slot) = drag.slot {
                    let to = if slot > drag.from { slot - 1 } else { slot };
                    if to != drag.from {
                        edits::reorder(app, drag.from, to);
                    }
                }
                return;
            }
            if r.selecting {
                track_select::toggle_row(app, TRACKS_LIST, shown_source, r.id, r.index, tx.mods().shift);
            } else if g.x >= r.title_x.0 && g.x < r.title_x.1 {
                play(app, r.id);
            }
        }
    }
}

/// The Tracks tab under the page's `head` (header, error, toolbar): the
/// whole page, whose rows are the content's virtual rows (only those near
/// the viewport are built), or the empty state.
pub fn page(app: &App, t: &Theme, cx: &mut Cx<App>, d: &Detail, p: &Playlist, perms: &Permissions, head: El) -> El {
    let rows = d.tracks.as_deref().unwrap_or(&[]);
    let raw = app.pages.playlists.fields.search.text.clone();
    let q = raw.trim().to_lowercase();
    let padded = |head: El, e: El| col().key("playlist-view").w_full().padding(t.pad()).child(head.child(e));
    if rows.is_empty() {
        let hint = perms.can_edit_tracks.then_some("Choose \"Add tracks\" to pull songs in from your library.");
        return padded(head, empty_state(t, None, "No tracks yet.", hint, None));
    }
    let shown = d.shown_idx.len();
    if shown == 0 {
        let hint = format!("Nothing in this playlist matches \"{raw}\".");
        return padded(head, empty_state(t, None, "No matches.", Some(&hint), None));
    }
    let selecting = selecting(app);
    let width = detail::content_width(t, cx);
    let c = cols(width, selecting);
    let show_added_by = p.visibility == Visibility::Collaborative || d.adders.iter().any(|by| *by != p.owner_id);
    let reorderable = perms.can_edit_tracks && d.sort == SortKey::Custom && q.is_empty() && !selecting;
    let can_edit = perms.can_edit_tracks;
    let mut panel = col().w_full().gap(8.0);
    if !q.is_empty() {
        panel = panel.child(text(format!("{shown} of {} match", rows.len())).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground));
    }
    // With one row there's no toolbar host, so the bar sits above the table.
    if rows.len() <= 1 {
        panel = panel.child(track_select::selection_bar(app, t, TRACKS_LIST, shown_source, BarPlace::Inline));
    }
    let head = head.child(panel.child(header(app, t, &c, selecting)));
    let row_key = |d: &Detail, n: usize| -> String {
        let e = &d.tracks.as_deref().unwrap_or(&[])[d.shown_idx[n]];
        format!("pl-row-{}-{}", e.position, e.track_id)
    };
    crate::ui::track_list::virtual_page(
        t,
        "playlist",
        shown,
        (d.shown_rev, selecting, c.title.to_bits()),
        head.key("playlist-head"),
        None,
        move |app: &App, n| detail::detail(app).filter(|d| n < d.shown_idx.len()).map_or_else(|| format!("pl-row-{n}"), |d| row_key(d, n)),
        move |app: &App, n| {
            let t = app.theme();
            let Some(d) = detail::detail(app).filter(|d| n < d.shown_idx.len()) else { return el() };
            let e = &d.tracks.as_deref().unwrap_or(&[])[d.shown_idx[n]];
            let sel = app.widgets.lists.selection(TRACKS_LIST);
            track_row(
                app,
                &t,
                e,
                RowCtx {
                    c: &c,
                    index: n,
                    count: d.shown_idx.len(),
                    now: app.player.current().is_some_and(|c| c.id == e.track_id),
                    playing: app.player.playing,
                    selected: sel.ids.contains(&e.track_id),
                    selecting,
                    can_edit,
                    show_added_by,
                    reorderable,
                    drag: d.table.drag,
                    fav: app.pages.favorites_has(&e.track_id),
                },
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drag(from: usize, slot: usize) -> Option<DragState> {
        Some(DragState { from, slot: Some(slot), active: true })
    }

    #[test]
    fn the_drop_line_skips_the_rows_own_gaps() {
        // Row 1 held over the gap above row 4: the line is on row 4's top.
        assert_eq!(drop_edge(drag(1, 4), 4, 9), Some(true));
        assert_eq!(drop_edge(drag(1, 4), 3, 9), None);
        // The gaps either side of the held row move nothing.
        assert_eq!(drop_edge(drag(1, 1), 1, 9), None);
        assert_eq!(drop_edge(drag(1, 2), 2, 9), None);
        // Past the last row, the line is on its bottom.
        assert_eq!(drop_edge(drag(1, 9), 8, 9), Some(false));
        // Not yet a drag (under the 4 pt threshold): no line.
        assert_eq!(drop_edge(Some(DragState { from: 1, slot: Some(4), active: false }), 4, 9), None);
    }

    #[test]
    fn columns_follow_the_fixed_table_layout() {
        let c = cols(956.0, false);
        assert_eq!((c.idx, c.art, c.album, c.added, c.dur, c.acts), (40.0, 44.0, 239.0, 130.0, 64.0, 80.0));
        assert_eq!(c.title, 956.0 - 358.0 - 239.0);
        // The table never gets narrower than 720 px; selecting adds 32.
        assert_eq!(cols(500.0, true).select + cols(500.0, true).title + 358.0 + 180.0, 720.0);
    }
}
