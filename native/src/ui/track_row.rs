//! `TrackRowCells.tsx` and `TrackList.tsx`'s `TrackRow` (`library.css`,
//! `tooltip.css`): one row of a track table, and the cells other tables (the
//! playlist table, the mini player) share: the index cell with its hover play
//! button and playing bars, the favourite heart with its pop, the select
//! checkbox cell.

use std::sync::OnceLock;

use rune::{Color, Cursor, El, el, row, text};
use rune_motion::{Beat, Easing, LoopSpec, Sequence};

use crate::api::{TrackListItem, TrackSource, media};
use crate::app::App;
use crate::format::{display_text, fmt_duration_ms};
use crate::theme::Theme;
use crate::ui::track_select::{self, Source};
use crate::ui::{css_border_bottom, font, ico, icons as i, line, motion, tnum, tooltip};

// TODO(api-merge): these mirror `core/src/track.ts` and `entity-labels.ts`
// until the core port lands; switch callers to it then.

/// `isLocalTrack`: stored in this library (not streamed from TIDAL).
pub fn is_local(t: &TrackListItem) -> bool {
    t.source.is_none_or(|s| s == TrackSource::Local)
}

/// `isTidalTrack`.
pub fn is_tidal(t: &TrackListItem) -> bool {
    t.source == Some(TrackSource::Tidal)
}

/// `canShareTrack`: library and TIDAL tracks, never a personal upload.
pub fn can_share(t: &TrackListItem) -> bool {
    t.owned != Some(true) && (is_local(t) || is_tidal(t))
}

/// `trackActions`: which of a track's actions to offer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Actions {
    pub play: bool,
    pub download: bool,
    pub view_album: bool,
    pub share: bool,
    pub edit_metadata: bool,
    pub edit_album: bool,
    pub move_to_album: bool,
    pub delete_own_upload: bool,
    pub admin_remove: bool,
}

pub fn actions(t: &TrackListItem, is_admin: bool) -> Actions {
    let local = is_local(t);
    let owned = t.owned == Some(true) && local;
    let unavailable = t.unavailable == Some(true);
    Actions {
        play: !unavailable,
        download: !unavailable,
        view_album: t.album_id.as_deref().is_some_and(|s| !s.is_empty())
            || t.album_title.as_deref().is_some_and(|s| !s.is_empty())
            || is_tidal(t),
        share: can_share(t),
        edit_metadata: is_admin && local,
        edit_album: is_admin && local && t.album_id.is_some(),
        move_to_album: is_admin && local,
        delete_own_upload: owned,
        admin_remove: is_admin && local && !owned,
    }
}

/// `creditsOnly`: the track credits only artists from `names`, each a whole
/// entry of its ", "-joined credit (case-insensitive).
pub fn credits_only(artist: Option<&str>, names: &[String]) -> bool {
    let credit = display_text(artist, "").to_lowercase();
    if credit.is_empty() {
        return false;
    }
    let mut entries: Vec<String> = names.iter().map(|n| display_text(Some(n), "").to_lowercase()).filter(|n| !n.is_empty()).collect();
    entries.dedup();
    let mut starts = vec![0usize];
    let mut k = 0;
    while k < starts.len() {
        let at = starts[k];
        k += 1;
        for e in &entries {
            if !credit[at..].starts_with(e.as_str()) {
                continue;
            }
            let end = at + e.len();
            if end == credit.len() {
                return true;
            }
            if credit[end..].starts_with(", ") && !starts.contains(&(end + 2)) {
                starts.push(end + 2);
            }
        }
    }
    false
}

/// `playableTracks`: the rows that can stream.
pub fn playable(tracks: &[TrackListItem]) -> Vec<TrackListItem> {
    tracks.iter().filter(|t| t.unavailable != Some(true)).cloned().collect()
}

/// `usePlayFromList().playTrack`: play `track` with the list's playable rows
/// as the queue; an unavailable row does nothing.
pub fn play_from(app: &mut App, track: &TrackListItem, list: &[TrackListItem]) {
    if track.unavailable == Some(true) {
        return;
    }
    let mut queue = playable(list);
    let start = match queue.iter().position(|t| t.id == track.id) {
        Some(i) => i,
        None => {
            queue = vec![track.clone()];
            0
        }
    };
    app.player.play_list(queue, start);
}

/// `startListPlayback`: the list from its first playable row, or from a
/// random one with shuffle on. False when nothing can play.
pub fn start_list(app: &mut App, tracks: &[TrackListItem], shuffle: bool) -> bool {
    let queue = playable(tracks);
    if queue.is_empty() {
        return false;
    }
    let start = if shuffle { random_below(queue.len()) } else { 0 };
    app.player.play_list(queue, start);
    true
}

fn random_below(n: usize) -> usize {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64));
    (h.finish() % n.max(1) as u64) as usize
}

/// The cover thumbnail URL rows draw (`trackCoverUrl(track, 64)`).
pub fn cover_url(t: &TrackListItem, size: u32) -> String {
    media::track_cover(&t.id, t.album_id.as_deref(), t.cover_url.as_deref(), Some(size))
}

/// `trackCoverUrl(track)` at the server's full size (detail headers).
pub fn cover_url_full(t: &TrackListItem) -> String {
    media::track_cover(&t.id, t.album_id.as_deref(), t.cover_url.as_deref(), None)
}

/// The cover's placeholder letter source: the album, else the title.
pub fn art_label(t: &TrackListItem) -> String {
    t.album_title.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| t.title.clone())
}

/// `PlayingBars`: three 2 px bars dancing on a 14 px square.
pub fn playing_bars(t: &Theme) -> El {
    // `barDance`: scaleY .3 → .9 → .3 over 1 s, ease-in-out each half; each
    // bar starts .2 s after the one before. A bar slides inside a clip, its
    // hidden part standing for the scale.
    static CURVE: OnceLock<&'static [[f32; 2]]> = OnceLock::new();
    let curve = CURVE.get_or_init(|| {
        let ease = Easing::cubic(0.42, 0.0, 0.58, 1.0);
        let pts: Vec<[f32; 2]> = (0..=40)
            .map(|k| {
                let x = k as f32 / 40.0;
                let half = if x < 0.5 { x * 2.0 } else { 2.0 - x * 2.0 };
                [x, ease.eval(half)]
            })
            .collect();
        Box::leak(pts.into_boxed_slice())
    });
    let mut bars = row().size(14.0, 14.0).gap(2.0).items_end().label("now playing");
    for (n, rest) in [0.4f32, 0.8, 0.6].into_iter().enumerate() {
        let spec = LoopSpec { delay: n as f64 * 0.2, ..LoopSpec::slide(1.0, [0.0, 0.7], [0.0, 0.1]).easing(Easing::Piecewise(curve)) };
        let bar = el().w(2.0).h(14.0).radius(1.0).fill(t.c.foreground).offset(0.0, 14.0 * (1.0 - rest)).looping(spec);
        bars = bars.child(el().w(2.0).h(14.0).clip_rounded(0.0).child(bar));
    }
    bars
}

/// `TrackIndexCell`'s `.play-cell`: the zero-padded number (or the bars
/// while the row's track plays), and with `play` the hover play button over
/// it.
///
/// Chromium lays the 18 px inline grid out with one 24 px track (the play
/// button's size), so the number centres 3 px right of the cell's centre,
/// and the grid's baseline sits it 1.65 px below the row's middle. Place the
/// result's 18 × 18 box where the cell is (right-aligned in `.col-idx`,
/// centred in the row); the number and button draw where Chromium has them.
pub fn index_cell(t: &Theme, key: &str, index: usize, playing: bool, ink: Color, play: Option<El>) -> El {
    let number = if playing {
        playing_bars(t)
    } else {
        text(format!("{:02}", index + 1)).font(tnum(font(12.0, 400.0))).color(ink)
    };
    // The 24 px track, from the cell's top-left; 3 px lower than the cell's
    // centre less the 1.35 px the line box's strut lifts it.
    let track = el().absolute(0.0, -1.35).size(24.0, 24.0).center();
    let mut cell = el().key(key).size(18.0, 18.0);
    match play {
        Some(button) => {
            cell = cell.child(track.clone().child(el().center().group_opacity(1.0, 0.0).child(number)));
            cell.child(track.child(button.group_opacity(0.0, 1.0)))
        }
        None => cell.child(track.child(number)),
    }
}

/// `.idx-play`: the 24 px play target centred on the 18 px cell.
pub fn idx_play(t: &Theme, key: &str, label: &str) -> El {
    el().key(key)
        .size(24.0, 24.0)
        .radius(t.radius_sm())
        .center()
        .role("button")
        .label(label)
        .cursor(Cursor::Pointer)
        .child(ico(&i::PLAY_FILLED, 14.0, t.c.foreground))
}

/// `FavoriteButton` in a row's actions: the heart, filled and in the
/// foreground while it's a favourite, popping as it turns on.
pub fn favorite_button(app: &App, t: &Theme, key: &str, id: &str, fav: bool) -> El {
    let pop = app.widgets.lists.pops.get(id).copied().unwrap_or(0);
    let ink = if fav { t.c.foreground } else { t.c.muted_foreground };
    let glyph = if fav { &i::HEART_FILLED } else { &i::HEART };
    let mut heart = ico(glyph, 14.0, ink).group_color(t.c.accent_foreground);
    if fav && pop > 0 {
        static POP: [Beat; 3] = [Beat::new(0.0), Beat::new(0.096).scale(1.25), Beat::new(0.24)];
        heart = heart.key(format!("{key}-pop{pop}")).sequence(Sequence::new(&POP));
    }
    let id = id.to_string();
    action_button(t, key, if fav { "Remove from favorites" } else { "Add to favorites" })
        .checked(fav)
        .child(heart)
        .on_press(move |app: &mut App| toggle_favorite(app, &id))
}

/// The heart's toggle: flips the favourite and pops the heart when it turns on.
pub fn toggle_favorite(app: &mut App, id: &str) {
    let was = app.pages.favorites_has(id);
    if !was {
        *app.widgets.lists.pops.entry(id.to_string()).or_default() += 1;
    }
    crate::pages::favorites::toggle(app, id);
}

/// `.row-actions button`: 28 px, muted, lit in the accent on hover.
pub fn action_button(t: &Theme, key: &str, label: &str) -> El {
    el().key(key)
        .size(28.0, 28.0)
        .radius(t.radius_md())
        .center()
        .role("button")
        .label(label)
        .cursor(Cursor::Pointer)
        .hover(t.c.accent)
        .focusable(true)
}

/// Where a row sits and what it shows, from its list.
pub struct RowSpec<'a> {
    pub list: &'a str,
    pub source: Source,
    pub queue: Source,
    pub index: usize,
    pub track: &'a TrackListItem,
    pub cover: bool,
    pub album: bool,
    pub source_badge: bool,
    /// In a `.table-headless`: rounded rows over transparent borders, and
    /// 40 px covers in a 56 px column.
    pub headless: bool,
    pub artist: bool,
    pub extra: Option<&'a crate::ui::track_list::Extra>,
}

/// `TrackRow`: one row of the table, `row_h` tall over its bottom border.
pub fn track_row(app: &App, t: &Theme, spec: RowSpec) -> El {
    let tr = spec.track;
    let key = format!("{}-row-{}", spec.list, tr.id);
    let sel = app.widgets.lists.selection(spec.list);
    let selecting = sel.is_some_and(|s| s.mode);
    let selected = sel.is_some_and(|s| s.ids.contains(&tr.id));
    let is_now = app.player.current().is_some_and(|c| c.id == tr.id);
    let playing = is_now && app.player.playing;
    let is_admin = app.me().is_some_and(|m| m.is_admin());
    let unavailable = tr.unavailable == Some(true);
    let lit = is_now || selected;
    let cell_ink = if lit { t.c.foreground } else { t.c.muted_foreground };
    let title = display_text(Some(&tr.title), "");
    let (list, source, queue, index) = (spec.list.to_string(), spec.source, spec.queue, spec.index);

    let mut r = row()
        .key(key.clone())
        .w_full()
        .h(t.row_h())
        .pb(1.0)
        .items_center()
        .cursor(Cursor::Pointer)
        .role("row")
        .hover_motion(motion::ease(100.0), motion::ease(100.0));
    if selecting {
        r = r.checked(selected);
    }
    r = if selected { r.fill(t.c.muted).hover_group() } else { r.hover(t.c.ghost_hover) };
    r = if spec.headless { r.radius(t.radius_lg()) } else { css_border_bottom(r, 1.0, t.c.border) };

    // `.col-select`: collapsed to nothing until selection mode opens it.
    let check = {
        let (l, id) = (list.clone(), tr.id.clone());
        track_select::checkbox(t, &format!("{key}-check"), selected, false, &format!("Select {}", display_text(Some(&tr.title), "track")))
            .opacity(if selecting { 1.0 } else { 0.0 })
            .opacity_motion(motion::ease_out(150.0))
            .offset(if selecting { 0.0 } else { -4.0 }, 0.0)
            .offset_motion(motion::ease_out(150.0))
            .on_press_tx(move |app: &mut App, tx| track_select::toggle_row(app, &l, source, &id, index, tx.mods().shift))
    };
    let check = if selecting { check } else { check.inert() };
    r = r.child(
        el().key(format!("{key}-sel"))
            .w(if selecting { 32.0 } else { 0.0 })
            .h_full()
            .center()
            .clip_rounded(0.0)
            .child(check),
    );

    // `.col-idx`.
    let play_btn = {
        let (tr2, q) = (tr.clone(), queue);
        idx_play(t, &format!("{key}-play"), &format!("Play {}", tr.title))
            .on_press(move |app: &mut App| {
                let list = q(app).to_vec();
                play_from(app, &tr2, &list)
            })
    };
    r = r.child(
        row().w(40.0).h_full().px(8.0).items_center().justify_end().child(index_cell(
            t,
            &format!("{key}-idx"),
            index,
            is_now && playing,
            cell_ink,
            Some(play_btn),
        )),
    );

    // `.col-art`.
    if spec.cover {
        let url = cover_url(tr, 64);
        let (col_w, art) = if spec.headless { (56.0, 40.0) } else { (44.0, 32.0) };
        r = r.child(
            row().w(col_w).h_full().pl(8.0).items_center().child(crate::ui::cover_art(
                t,
                &app.images,
                Some(&url),
                &art_label(tr),
                art,
                art,
                t.radius_md(),
            )),
        );
    }

    // Title and artist.
    let mut title_line =
        row().w_full().min_w(0.0).items_center().child(crate::ui::centred(line(title.clone(), font(14.0, 500.0), t.c.foreground), font(14.0, 500.0)));
    if spec.source_badge && is_tidal(tr) {
        title_line = title_line.child(badge(t, if unavailable { "Removed from TIDAL" } else { "TIDAL" }).ml(8.0));
    }
    if let Some(aka) = tr.aka.as_deref().filter(|s| !s.is_empty()) {
        title_line = title_line.child(aka_hint(t, &format!("{key}-aka"), &tr.id, aka));
    }
    let title_line = tooltip::tip_truncated(title_line, &format!("{key}-title"), &title, font(14.0, 500.0));
    // Both lines at their CSS heights (20.3 and 17.4 px; Rune would round
    // them to 21 and 18 and the centred pair would sit high).
    let mut title_cell =
        rune::col().grow(1.0).min_w(0.0).h_full().px(8.0).justify_center().child(crate::ui::exact(title_line.h(20.3), 20.3));
    if spec.artist {
        let artist = display_text(tr.artist.as_deref(), "Unknown artist");
        let sub = line(artist.clone(), font(12.0, 400.0), t.c.muted_foreground);
        title_cell =
            title_cell.child(crate::ui::exact(tooltip::tip_truncated(sub, &format!("{key}-artist"), &artist, font(12.0, 400.0)), 17.4));
    }
    {
        let (l, id, tr2) = (list.clone(), tr.id.clone(), tr.clone());
        title_cell = title_cell.on_press_tx(move |app: &mut App, tx| {
            if app.widgets.lists.is_selecting(&l) {
                track_select::toggle_row(app, &l, source, &id, index, tx.mods().shift);
            } else {
                let list = queue(app).to_vec();
                play_from(app, &tr2, &list);
            }
        });
    }
    r = r.child(title_cell);

    // `.col-album`.
    if spec.album {
        let album = tr.album_title.as_deref().filter(|s| !s.is_empty()).map(|a| display_text(Some(a), ""));
        let mut cell = row().w_frac(0.25).h_full().px(8.0).items_center().min_w(0.0);
        let label = line(album.clone().unwrap_or_else(|| "—".into()), tnum(font(12.0, 400.0)), t.c.muted_foreground);
        cell = cell.child(match album {
            Some(a) => tooltip::tip_truncated(label, &format!("{key}-album"), &a, tnum(font(12.0, 400.0))),
            None => label,
        });
        r = r.child(cell);
    }
    if let Some(extra) = spec.extra {
        let mut cell = row().w(extra.width).h_full().px(8.0).items_center().min_w(0.0);
        if extra.align_end {
            cell = cell.justify_end();
        }
        r = r.child(cell.child((extra.render)(app, t, tr)));
    }

    // `.col-dur`.
    r = r.child(
        row().w(64.0).h_full().px(8.0).items_center().justify_end().child(
            crate::ui::text_end(fmt_duration_ms(tr.duration_ms), tnum(font(12.0, 400.0)), cell_ink),
        ),
    );

    // `.col-acts`: edit (admins, library tracks) and the heart, shown on hover.
    let mut acts = row().gap(8.0).items_center().group_opacity(0.0, 1.0);
    if is_admin && actions(tr, true).edit_metadata {
        let id = tr.id.clone();
        let edit = action_button(t, &format!("{key}-edit"), "Edit metadata")
            .child(ico(&i::SQUARE_PEN, 14.0, t.c.muted_foreground).group_color(t.c.accent_foreground))
            .on_press(move |app: &mut App| crate::overlays::edit::open_track(app, &id));
        acts = acts.child(tooltip::tip(edit, &format!("{key}-edit"), "Edit metadata"));
    }
    let fav = app.pages.favorites_has(&tr.id);
    let heart = favorite_button(app, t, &format!("{key}-fav"), &tr.id, fav);
    acts = acts.child(tooltip::tip(heart, &format!("{key}-fav"), if fav { "Remove from favorites" } else { "Add to favorites" }));
    r = r.child(row().w(80.0).h_full().px(8.0).items_center().justify_end().child(acts));

    // Presses: a click toggles the row while selecting, a double click plays.
    {
        let (l, id) = (list.clone(), tr.id.clone());
        r = r.on_press_tx(move |app: &mut App, tx| {
            if app.widgets.lists.is_selecting(&l) {
                track_select::toggle_row(app, &l, source, &id, index, tx.mods().shift);
            }
        });
    }
    {
        let (l, tr2) = (list.clone(), tr.clone());
        r = r.on_double_press(move |app: &mut App| {
            if !app.widgets.lists.is_selecting(&l) {
                let list = queue(app).to_vec();
                play_from(app, &tr2, &list);
            }
        });
    }
    {
        let (l, tr2) = (list.clone(), tr.clone());
        r = r.on_secondary_press(move |app: &mut App, at: rune::PointerPress, _tx| {
            crate::ui::track_list::open_menu(app, &l, source, queue, &tr2, [at.x, at.y]);
        });
    }
    if unavailable {
        r = tooltip::tip(r.opacity(0.45), &key, "No longer on TIDAL");
    }
    r
}

/// `.badge`: a 20 px pill in the secondary colours.
pub fn badge(t: &Theme, label: &str) -> El {
    rune::row()
        .h(20.0)
        .px(9.0)
        .items_center()
        .radius(999.0)
        .fill(t.c.secondary)
        .child(text(label).font(font(12.0, 500.0)).color(t.c.secondary_foreground))
}

/// `.track-aka-hint`: "(+N)" after the title, with the other names in a
/// tooltip; a click opens the compare view in Song info.
fn aka_hint(t: &Theme, key: &str, id: &str, aka: &str) -> El {
    let parts: Vec<String> = aka.split(" • ").map(str::to_string).collect();
    let id = id.to_string();
    let b = el()
        .key(key)
        .ml(6.0)
        .role("button")
        .label(format!("Compare versions, also known as {aka}"))
        .cursor(Cursor::Pointer)
        .hover_group()
        .child(text(format!("(+{})", parts.len())).font(font(12.0, 400.0)).color(t.c.muted_foreground).group_color(t.c.foreground))
        .on_press(move |app: &mut App| crate::overlays::track_info::open(app, &id))
        .on_double_press(|_: &mut App| {});
    tooltip::tip_body(b, key, tooltip::Body::AlsoKnownAs { names: parts, hint: true })
}
