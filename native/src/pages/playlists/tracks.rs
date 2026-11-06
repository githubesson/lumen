//! `PlaylistTracksPanel.tsx`: the Tracks tab's table (`library.css`
//! `.table-tracks`), with the playlist's own columns (Added, added-by,
//! remove), selection, and drag reorder (`useDragReorder.ts`).

use std::collections::HashSet;

use rune::{Cursor, Cx, El, Phase, Tx, col, el, row, text};

use crate::api::{Playlist, PlaylistTrackEntry, Visibility, media};
use crate::app::App;
use crate::format::{display_text, fmt_duration_ms};
use crate::theme::Theme;
use crate::ui::kit::empty_state;
use crate::ui::{css_border_bottom, font, icons as i, line, tnum};

use super::adapters::{self, SelectionBar};
use super::detail::{self, Detail, detail_mut};
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

/// `useTrackSelection` and `useDragReorder`'s state.
#[derive(Default)]
pub struct State {
    pub selecting: bool,
    /// Selected track ids.
    pub selected: HashSet<String>,
    /// The last row toggled, for shift-click ranges.
    pub anchor: Option<usize>,
    pub drag: Option<DragState>,
}

/// The rows the table shows, as entries.
fn shown_rows<'a>(app: &App, d: &'a Detail) -> Vec<&'a PlaylistTrackEntry> {
    let rows = d.tracks.as_deref().unwrap_or(&[]);
    d.shown(&query(app)).into_iter().map(|i| &rows[i]).collect()
}

fn query(app: &App) -> String {
    app.pages.playlists.fields.search.text.trim().to_lowercase()
}

/// The selection controls in the toolbar's host (`TrackSelectionToolbar`).
pub fn selection_host(app: &App, t: &Theme, d: &Detail) -> El {
    adapters::selection_toolbar(t, "playlist-selectbar", bar(app, d), toggle_mode, select_all, clear)
}

fn bar(app: &App, d: &Detail) -> SelectionBar {
    let rows = shown_rows(app, d);
    let s = &d.table;
    let selected = rows.iter().filter(|r| s.selected.contains(&r.track_id)).count();
    SelectionBar { selecting: s.selecting, selected, all_selected: !rows.is_empty() && selected == rows.len(), some_selected: selected > 0 }
}

fn toggle_mode(app: &mut App) {
    if let Some(d) = detail_mut(app) {
        d.table.selecting = !d.table.selecting;
    }
}

fn clear(app: &mut App) {
    if let Some(d) = detail_mut(app) {
        d.table.selecting = false;
        d.table.selected.clear();
        d.table.anchor = None;
    }
}

/// Select every shown row, or none when they all are.
fn select_all(app: &mut App) {
    let ids: Vec<String> = match detail::detail(app) {
        Some(d) => shown_rows(app, d).iter().map(|r| r.track_id.clone()).collect(),
        None => return,
    };
    let Some(d) = detail_mut(app) else { return };
    let s = &mut d.table;
    if !ids.is_empty() && ids.iter().all(|id| s.selected.contains(id)) && s.selected.len() == ids.len() {
        s.selected.clear();
    } else {
        s.selected = ids.into_iter().collect();
    }
    s.selecting = true;
}

/// `toggleSelection`: one row, or with Shift the range from the last one.
fn toggle_row(app: &mut App, index: usize, range: bool) {
    let ids: Vec<String> = match detail::detail(app) {
        Some(d) => shown_rows(app, d).iter().map(|r| r.track_id.clone()).collect(),
        None => return,
    };
    let Some(d) = detail_mut(app) else { return };
    let s = &mut d.table;
    let Some(id) = ids.get(index) else { return };
    match s.anchor.filter(|_| range) {
        Some(a) => {
            for id in &ids[a.min(index)..=a.max(index).min(ids.len() - 1)] {
                s.selected.insert(id.clone());
            }
        }
        None => {
            if !s.selected.remove(id) {
                s.selected.insert(id.clone());
            }
        }
    }
    s.anchor = if s.selected.is_empty() { None } else { Some(index) };
}

/// Play `track_id` with the table's queue.
fn play(app: &mut App, track_id: &str) {
    let Some(d) = detail::detail(app) else { return };
    let queue = d.queue();
    let Some(start) = queue.iter().position(|t| t.id == track_id) else { return };
    app.player.play_list(queue, start);
}

/// The column widths (`table-layout: fixed`): select, #, art, title, album
/// (25%), added, time, actions.
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

fn header(t: &Theme, c: &Cols, selecting: bool, bar: &SelectionBar) -> El {
    let th = |s: &str| text(s.to_string()).font(font(12.0, 500.0)).color(t.c.muted_foreground);
    let mut h = row().key("playlist-thead").w_full().h(40.0).pb(1.0).fill(t.c.background).sticky_top(0.0);
    if selecting {
        h = h.child(
            row().w(c.select).h_full().px(4.0).items_center().justify_center().child(
                adapters::checkbox(
                    t,
                    "playlist-select-all",
                    bar.all_selected,
                    bar.some_selected && !bar.all_selected,
                    if bar.all_selected { "Deselect all tracks" } else { "Select all tracks" },
                )
                .on_press(select_all),
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
    let index_cell = adapters::index_cell(t, &format!("{key}-idx"), r.index, r.now && r.playing, ink, &format!("Play {}", e.title), move |app| {
        play(app, &play_id)
    });
    let art_url = match e.album_id.as_deref() {
        Some(a) => media::album_cover_path(a, None, None),
        None => media::cover_path(&e.track_id, None),
    };
    let art_label = e.album_title.clone().filter(|a| !a.is_empty()).unwrap_or_else(|| e.title.clone());
    let album = e.album_title.as_deref().map(|a| display_text(Some(a), "")).filter(|a| !a.is_empty());
    let added = if e.added_at.is_empty() { "—".to_string() } else { fmt_date(&e.added_at) };

    let mut acts = row().gap(8.0).items_center().group_opacity(0.0, 1.0).child(adapters::favorite_button(t, &format!("{key}-fav"), &e.track_id, r.fav));
    if r.can_edit {
        let position = e.position;
        acts = acts.child(
            adapters::row_action(t, &format!("{key}-remove"), &i::TRASH_2, t.c.muted_foreground)
                .label("Remove from playlist")
                .on_press(move |app: &mut App| edits::remove(app, position)),
        );
    }

    // The cells' 1 px bottom border is inside the row height.
    let mut tr = row().key(key.clone()).w_full().h(t.row_h()).pb(1.0).cursor(Cursor::Pointer);
    if r.selecting {
        let sel_id = r.index;
        tr = tr.child(
            row().w(c.select).h_full().px(4.0).items_center().justify_center().child(
                adapters::checkbox(t, &format!("{key}-check"), r.selected, false, &format!("Select {}", display_text(Some(&e.title), "track")))
                    .on_press_tx(move |app: &mut App, tx: &mut Tx| toggle_row(app, sel_id, tx.mods().shift)),
            ),
        );
    }
    tr = tr
        // `.play-cell`: an 18 px inline-grid whose one track grows to the
        // 24 px play button, overflowing to the right and down.
        .child(cell(c.idx).justify_end().child(el().w(18.0).h(18.0).child(index_cell.absolute(0.0, -2.0))))
        .child(cell(c.art).child(crate::ui::cover_art(t, &app.images, Some(&art_url), &art_label, 32.0, 32.0, t.radius_md()).min_w(32.0).mb(1.0)))
        .child(
            cell(c.title).child(
                col()
                    .w_full()
                    .min_w(0.0)
                    .child(line(title.clone(), font(14.0, 500.0), t.c.foreground).help(title))
                    .child(line(sub.clone(), font(12.0, 400.0), t.c.muted_foreground).help(sub)),
            ),
        )
        .child(cell(c.album).child({
            let a = line(album.clone().unwrap_or_else(|| "—".into()), tnum(font(12.0, 400.0)), ink);
            match album {
                Some(s) => a.help(s),
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
            let queue = detail::detail(app).map(|d| d.queue()).unwrap_or_default();
            adapters::open_track_menu(app, menu_track.clone(), queue, [at.x, at.y]);
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
                let keys: Vec<String> = d
                    .tracks
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .map(|e| format!("pl-row-{}-{}", e.position, e.track_id))
                    .collect();
                if let Some(k) = keys.get(slot.saturating_sub(1)) {
                    tx.scroll_into_view(k.clone());
                }
                if let Some(k) = keys.get(slot) {
                    tx.scroll_into_view(k.clone());
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
                toggle_row(app, r.index, tx.mods().shift);
            } else if g.x >= r.title_x.0 && g.x < r.title_x.1 {
                play(app, r.id);
            }
        }
    }
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>, d: &Detail, p: &Playlist, perms: &Permissions) -> El {
    let rows = d.tracks.as_deref().unwrap_or(&[]);
    let raw = app.pages.playlists.fields.search.text.clone();
    let q = query(app);
    if rows.is_empty() {
        let hint = perms.can_edit_tracks.then_some("Choose \"Add tracks\" to pull songs in from your library.");
        return empty_state(t, None, "No tracks yet.", hint, None);
    }
    let shown = d.shown(&q);
    if shown.is_empty() {
        let hint = format!("Nothing in this playlist matches \"{raw}\".");
        return empty_state(t, None, "No matches.", Some(&hint), None);
    }
    let s = &d.table;
    let width = cx.layout_size("playlist-table").map_or(956.0, |s| s[0]);
    let c = cols(width, s.selecting);
    let show_added_by =
        p.visibility == Visibility::Collaborative || rows.iter().any(|t| t.added_by_id.as_deref().is_some_and(|by| by != p.owner_id));
    let reorderable = perms.can_edit_tracks && d.sort == SortKey::Custom && q.is_empty() && !s.selecting;
    let current = app.player.current().map(|t| t.id.clone());
    let b = bar(app, d);
    let mut body = col().key("playlist-tbody").w_full();
    for (index, &i) in shown.iter().enumerate() {
        let e = &rows[i];
        let now = current.as_deref() == Some(e.track_id.as_str());
        body = body.child(track_row(
            app,
            t,
            e,
            RowCtx {
                c: &c,
                index,
                count: shown.len(),
                now,
                playing: app.player.playing,
                selected: s.selected.contains(&e.track_id),
                selecting: s.selecting,
                can_edit: perms.can_edit_tracks,
                show_added_by,
                reorderable,
                drag: s.drag,
                fav: app.pages.favorites_has(&e.track_id),
            },
        ));
    }
    let mut panel = col().w_full().gap(8.0);
    if !q.is_empty() {
        panel = panel.child(text(format!("{} of {} match", shown.len(), rows.len())).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground));
    }
    // With one row there's no toolbar host, so the bar sits above the table.
    if rows.len() <= 1 {
        let status = if b.selecting {
            format!("{} selected", b.selected)
        } else {
            format!("{} track{}", rows.len(), if rows.len() == 1 { "" } else { "s" })
        };
        panel = panel.child(
            row()
                .w_full()
                .min_h(38.0)
                .pb(8.0)
                .gap(8.0)
                .items_center()
                .child(text(status).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground).grow(1.0))
                .child(selection_host(app, t, d)),
        );
    }
    panel.child(col().key("playlist-table").w_full().child(header(t, &c, s.selecting, &b)).child(body))
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
