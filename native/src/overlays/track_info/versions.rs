//! `TrackInfoDialog.tsx`'s `Versions` and `VersionLinker`: the other copies
//! of the track compared field by field (the copy whose tags show, the files
//! linked with it as the same song, and the copies of its audio that ingest
//! merged into it), a dropdown picking which sit side by side, and for
//! admins, linking another library file of the song and unlinking one.

use rune::{Color, Cursor, El, TextEdit, col, el, row, text};

use super::multi_select::{self, Opt, badge, mark};
use super::rows::{display_artists, display_text, format_bitrate, format_duration};
use crate::api::{TrackDetail, TrackListItem, TrackSource};
use crate::app::App;
use crate::overlays::requests;
use crate::theme::Theme;
use crate::ui::forms::search_input_bound;
use crate::ui::kit::{error_banner, eyebrow};
use crate::ui::{Btn, css_border, font, snug_lines, with_lh};

/// One copy of the track (`Version`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Version {
    pub title: String,
    pub artists: String,
    pub album: String,
    pub file: String,
    pub format: Option<String>,
    pub bitrate: Option<String>,
    /// A linked track, which can be unlinked.
    pub linked_id: Option<String>,
    pub shown: bool,
    pub plays: bool,
}

impl Version {
    fn field(&self, key: &str) -> &str {
        match key {
            "title" => &self.title,
            "artists" => &self.artists,
            "album" => &self.album,
            "format" => self.format.as_deref().unwrap_or(""),
            _ => self.bitrate.as_deref().unwrap_or(""),
        }
    }
}

const TAG_FIELDS: [(&str, &str); 3] = [("title", "Title"), ("artists", "Artists"), ("album", "Album")];
const AUDIO_FIELDS: [(&str, &str); 2] = [("format", "Format"), ("bitrate", "Bitrate")];

fn same(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// "WAV" for a file name ending in .wav, else the format the server read.
fn file_format(file_name: &str, format: Option<&str>) -> String {
    match file_name.rsplit_once('.') {
        Some((_, ext)) if !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric()) => ext.to_uppercase(),
        _ => format.unwrap_or("").to_string(),
    }
}

/// Every copy, the first being the one whose tags the track shows.
pub fn versions(track: &TrackDetail) -> Vec<Version> {
    let own_id = track.db_track_id.clone().unwrap_or_else(|| track.id.clone());
    let own = track.linked.iter().find(|l| l.id == own_id);
    let own_audio = own.map(|o| (file_format(&o.file_name, o.format.as_deref()), format_bitrate(o.bitrate)));
    let first = Version {
        title: track.title.clone(),
        artists: display_artists(track),
        album: track.album_title.clone().unwrap_or_default(),
        file: if track.metadata_edited == Some(true) {
            "Edited tags".into()
        } else {
            track.tags_file_name.clone().or_else(|| track.file_name.clone()).unwrap_or_default()
        },
        format: own_audio.as_ref().map(|a| a.0.clone()),
        bitrate: own_audio.as_ref().map(|a| a.1.clone()),
        linked_id: None,
        shown: track.linked_to.is_none(),
        plays: own.and_then(|o| o.plays).unwrap_or(false),
    };
    let mut out = vec![first];
    for l in track.linked.iter().filter(|l| l.id != own_id) {
        out.push(Version {
            title: l.title.clone(),
            artists: l.artist_names.clone().unwrap_or_default(),
            album: l.album_title.clone().unwrap_or_default(),
            file: l.file_name.clone(),
            format: Some(file_format(&l.file_name, l.format.as_deref())),
            bitrate: Some(format_bitrate(l.bitrate)),
            linked_id: Some(l.id.clone()),
            shown: l.shown.unwrap_or(false),
            plays: l.plays.unwrap_or(false),
        });
    }
    for a in &track.aliases {
        out.push(Version {
            title: a.title.clone().unwrap_or_default(),
            artists: a.artist_names.clone().unwrap_or_default(),
            album: a.album_title.clone().unwrap_or_default(),
            file: a.file_name.clone(),
            format: own_audio.as_ref().map(|x| x.0.clone()),
            bitrate: own_audio.as_ref().map(|x| x.1.clone()),
            ..Default::default()
        });
    }
    out
}

fn version_label(v: &Version, i: usize) -> String {
    if v.file.is_empty() { format!("Version {}", i + 1) } else { v.file.clone() }
}

/// The copies compared at first: the shown one and the one that plays (or the second).
pub fn default_pick(vs: &[Version]) -> Vec<usize> {
    let playing = vs.iter().enumerate().skip(1).find(|(_, v)| v.plays).map(|(i, _)| i);
    let mut p = vec![0, playing.unwrap_or(1)];
    p.dedup();
    p
}

fn picked(app: &App, vs: &[Version]) -> Vec<usize> {
    let s = &app.overlays.track_info;
    let mut p: Vec<usize> = s.picked.clone().unwrap_or_else(|| default_pick(vs)).into_iter().filter(|i| *i < vs.len()).collect();
    p.sort_unstable();
    p
}

fn toggle_pick(app: &mut App, n: usize) {
    let Some(track) = app.overlays.track_info.track.clone() else { return };
    let vs = versions(&track);
    let mut p = picked(app, &vs);
    if let Some(at) = p.iter().position(|x| *x == n) {
        if p.len() > 1 {
            p.remove(at);
        }
    } else {
        p.push(n);
        p.sort_unstable();
    }
    app.overlays.track_info.picked = Some(p);
}

fn toggle_picker(app: &mut App) {
    let s = &mut app.overlays.track_info;
    s.picker_open = !s.picker_open;
}

fn close_picker(app: &mut App) {
    app.overlays.track_info.picker_open = false;
}

/// The open picker's list, drawn above the dialog.
pub fn picker_layer(app: &App, t: &Theme, cx: &mut rune::Cx<App>) -> Option<El> {
    let s = &app.overlays.track_info;
    if !s.picker_open {
        return None;
    }
    let track = s.track.as_ref()?;
    let vs = versions(track);
    let options: Vec<Opt> = vs
        .iter()
        .enumerate()
        .map(|(i, v)| Opt {
            label: version_label(v, i),
            detail: Some(
                [v.title.as_str(), v.artists.as_str(), v.format.as_deref().unwrap_or("")]
                    .iter()
                    .filter(|x| !x.is_empty())
                    .copied()
                    .collect::<Vec<_>>()
                    .join(" · "),
            )
            .filter(|d| !d.is_empty()),
            tag: if v.shown {
                Some("Shown".into())
            } else if v.plays {
                Some("Plays".into())
            } else {
                None
            },
            mark: Some(i + 1),
        })
        .collect();
    let w = cx.layout_size("track-versions-picker").map_or(140.0, |s| s[0]);
    Some(multi_select::list(t, "track-versions-picker", &options, &picked(app, &vs), w, toggle_pick, close_picker))
}

fn relinked(app: &mut App, updated: TrackDetail) {
    let s = &mut app.overlays.track_info;
    s.linking = false;
    s.unlinking = None;
    s.linking_id = None;
    s.picked = None;
    s.relinks += 1;
    s.track = Some(updated);
    crate::pages::library_changed(app);
}

fn unlink(app: &mut App, id: String) {
    let s = &mut app.overlays.track_info;
    if s.unlinking.is_some() {
        return;
    }
    s.unlinking = Some(id.clone());
    s.version_error = None;
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || requests::unlink_track(&client, &id),
        |app, result| match result {
            Ok(t) => relinked(app, t),
            Err(e) => {
                let s = &mut app.overlays.track_info;
                s.unlinking = None;
                s.version_error = Some(crate::overlays::error_message(&e, "Couldn't unlink the file."));
            }
        },
    );
}

/// The title without a trailing "(v2)" or "[Remix]", to find other versions by.
fn searchable_title(title: &str) -> String {
    let clean = display_text(Some(title), "");
    let mut s = clean.trim_end().to_string();
    loop {
        let trimmed = s.trim_end();
        let close = trimmed.chars().last();
        let open = match close {
            Some(')') => '(',
            Some(']') => '[',
            _ => break,
        };
        match trimmed.rfind(open) {
            Some(i) => s = trimmed[..i].to_string(),
            None => break,
        }
    }
    let s = s.trim().to_string();
    if s.is_empty() { clean } else { s }
}

fn start_linking(app: &mut App) {
    let Some(track) = app.overlays.track_info.track.clone() else { return };
    let s = &mut app.overlays.track_info;
    s.linking = true;
    s.linker_error = None;
    s.results = None;
    s.query = TextEdit::new(searchable_title(&track.title));
    s.query.focused = true;
    search(app);
}

fn cancel_linking(app: &mut App) {
    let s = &mut app.overlays.track_info;
    if s.linking_id.is_none() {
        s.linking = false;
    }
}

/// The linker's query changed: search after a 250 ms pause (`SEARCH_DEBOUNCE_MS`).
fn search(app: &mut App) {
    let s = &mut app.overlays.track_info;
    s.linker_error = None;
    let q = s.query.text.trim().to_string();
    s.search_gen += 1;
    let id = s.search_gen;
    if q.is_empty() {
        return;
    }
    let Some(client) = app.client.clone() else { return };
    let wait = !app.net.is_sync();
    app.net.run(
        move || {
            if wait {
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            (q.clone(), requests::list_tracks(&client, &q, 20))
        },
        move |app, (q, result)| {
            let s = &mut app.overlays.track_info;
            if s.search_gen != id {
                return;
            }
            match result {
                Ok(items) => s.results = Some((q, items)),
                Err(e) => {
                    s.results = Some((q, Vec::new()));
                    s.linker_error = Some(crate::overlays::error_message(&e, "Couldn't search the library."));
                }
            }
        },
    );
}

fn link(app: &mut App, item: TrackListItem) {
    let s = &mut app.overlays.track_info;
    let Some(track) = s.track.clone() else { return };
    if s.linking_id.is_some() {
        return;
    }
    s.linking_id = Some(item.id.clone());
    s.linker_error = None;
    let Some(client) = app.client.clone() else { return };
    let own = track.db_track_id.clone().unwrap_or(track.id.clone());
    let other = item.db_track_id.clone().unwrap_or(item.id.clone());
    app.net.run(
        move || requests::link_track(&client, &own, &other),
        |app, result| match result {
            Ok(t) => relinked(app, t),
            Err(e) => {
                let s = &mut app.overlays.track_info;
                s.linking_id = None;
                s.linker_error = Some(crate::overlays::error_message(&e, "Couldn't link the file."));
            }
        },
    );
}

/// A library track another file can be linked with: a shared local one.
fn linkable(i: &TrackListItem) -> bool {
    i.source.is_none_or(|s| s == TrackSource::Local) && i.owned != Some(true) && i.unavailable != Some(true)
}

fn linker(app: &App, t: &Theme, track: &TrackDetail) -> El {
    let s = &app.overlays.track_info;
    let mut exclude: Vec<String> = track.linked.iter().map(|l| l.id.clone()).collect();
    exclude.push(track.db_track_id.clone().unwrap_or(track.id.clone()));
    let q = s.query.text.trim().to_string();
    let mut c = col().w_full().gap(8.0).my(8.0).child(
        row()
            .w_full()
            .gap(8.0)
            .items_center()
            .child(
                el().grow(1.0).min_w(0.0).child(
                    search_input_bound(
                        t,
                        "track-linker-search",
                        &s.query,
                        "Find another file of this song",
                        None,
                        |app: &mut App| &mut app.overlays.track_info.query,
                        Some(search),
                    ),
                ),
            )
            .child(Btn::new("track-linker-cancel", "Cancel").small().ghost().disabled(s.linking_id.is_some()).build(t).on_press(cancel_linking)),
    );
    if let Some(e) = &s.linker_error {
        c = c.child(error_banner(t, e));
    }
    if !q.is_empty() {
        let items: Option<Vec<&TrackListItem>> = s
            .results
            .as_ref()
            .filter(|(rq, _)| *rq == q)
            .map(|(_, items)| items.iter().filter(|i| linkable(i) && !exclude.contains(&i.db_track_id.clone().unwrap_or(i.id.clone()))).collect());
        let empty = |msg: &str| el().px(8.0).py(6.0).child(text(msg.to_string()).font(font(12.0, 400.0)).color(t.c.muted_foreground));
        let mut list = col().w_full().gap(8.0);
        match &items {
            None => list = list.child(empty("Searching…")),
            Some(v) if v.is_empty() => list = list.child(empty("No other library tracks match.")),
            Some(v) => {
                for item in v {
                    let meta = [
                        display_text(item.artist.as_deref(), ""),
                        display_text(item.album_title.as_deref(), ""),
                        format_duration(item.duration_ms),
                    ]
                    .into_iter()
                    .filter(|x| !x.is_empty())
                    .collect::<Vec<_>>()
                    .join(" · ");
                    let busy = s.linking_id.is_some();
                    let it = (*item).clone();
                    let mut b = col()
                        .key(format!("track-linker-{}", item.id))
                        .w_full()
                        .gap(2.0)
                        .px(8.0)
                        .py(6.0)
                        .radius(t.radius_md())
                        .role("button")
                        .label(item.title.clone())
                        .child(text(display_text(Some(&item.title), "")).font(font(13.0, 500.0)).color(t.c.foreground).wrap_anywhere())
                        .child(text(meta).font(font(12.0, 400.0)).color(t.c.muted_foreground).wrap_anywhere());
                    if s.linking_id.as_deref() == Some(item.id.as_str()) {
                        b = b.child(text("Linking…").font(font(12.0, 400.0)).color(t.c.muted_foreground));
                    }
                    b = if busy {
                        b.opacity(0.6).disabled(true)
                    } else {
                        b.cursor(Cursor::Pointer).focusable(true).hover(t.c.muted).on_press(move |app: &mut App| link(app, it.clone()))
                    };
                    list = list.child(b);
                }
            }
        }
        c = c.child(
            css_border(el(), 1.0, t.c.border, t.radius_lg())
                .w_full()
                .padding(5.0)
                .radius(t.radius_lg())
                .child(crate::ui::kit::scroll_area_fit(t, "track-linker-results", list, false, Some(230.0))),
        );
    }
    c
}

/// The file name with its badge flowing after it, as inline text does.
fn version_name(t: &Theme, n: usize, v: &Version) -> El {
    let label = version_label(v, n);
    let mut words = row().flex_wrap().min_w(0.0).shrink().items_center();
    let parts: Vec<&str> = label.split(' ').collect();
    for (k, w) in parts.iter().enumerate() {
        let w = if k + 1 < parts.len() { format!("{w} ") } else { (*w).to_string() };
        words = words.child(text(w).font(font(13.0, 500.0)).color(t.c.foreground));
    }
    let tag = if v.shown { Some("Shown") } else if v.plays { Some("Plays") } else { None };
    if let Some(tag) = tag {
        words = words.child(badge(t, tag).ml(6.0));
    }
    row().w_full().gap(6.0).items_start().child(mark(t, n + 1).mt(0.5)).child(words)
}

pub fn view(app: &App, t: &Theme, track: &TrackDetail, can_link: bool, width: f32) -> El {
    let s = &app.overlays.track_info;
    let vs = versions(track);
    let compared = picked(app, &vs);
    let linked = !track.linked.is_empty();
    let alias_count = track.aliases.len();
    let total = vs.len() + track.alias_count.map_or(0, |c| (c as usize).saturating_sub(alias_count));

    let mut actions = row().gap(8.0).items_center();
    if vs.len() > 1 {
        actions = actions.child(multi_select::trigger(
            t,
            "track-versions-picker",
            &format!("Comparing {} of {}", compared.len(), vs.len()),
            "Versions to compare",
            s.picker_open,
            toggle_picker,
        ));
    }
    if can_link && !s.linking {
        actions = actions.child(Btn::new("track-link-file", "Link a file").small().build(t).on_press(start_linking));
    }
    let mut c = col().w_full().child(
        row()
            .w_full()
            .gap(12.0)
            .mb(4.0)
            .items_center()
            .justify_between()
            .child(eyebrow(t, &if vs.len() > 1 { format!("Versions ({total})") } else { "Versions".into() }).role("heading"))
            .child(actions),
    );
    if s.linking {
        c = c.child(linker(app, t, track));
    }
    if let Some(e) = &s.version_error {
        c = c.child(error_banner(t, e));
    }
    if vs.len() <= 1 {
        return c;
    }
    let mut caption = if linked {
        format!(
            "Files of the same song: the fullest tags show and the best file plays. Faded values match {}.",
            if vs[0].shown { "the shown file" } else { "the first" }
        )
    } else {
        "Same audio, different tags; the fullest is shown. Faded values match it.".to_string()
    };
    if total > vs.len() {
        caption.push_str(&format!(" Listing the first {} of {total}.", vs.len()));
    }
    c = c.child(
        snug_lines("track-versions-caption", text(caption).font(with_lh(font(12.0, 400.0), 17.4)).color(t.c.muted_foreground).wrap(), 17.4)
            .mb(8.0),
    );

    // The table: a 72 px label column, then the compared copies sharing the rest.
    let fields: Vec<(&str, &str)> = if linked { TAG_FIELDS.iter().chain(AUDIO_FIELDS.iter()).copied().collect() } else { TAG_FIELDS.to_vec() };
    let table_w = (width - 2.0).max(72.0 + compared.len() as f32 * 136.0);
    let col_w = (table_w - 72.0) / compared.len().max(1) as f32;
    let cell = |w: f32| el().w(w).min_w(0.0);
    let line_c = t.c.border;
    let mut head = row().w(table_w).items_stretch().child(
        cell(72.0).fill(t.c.popover).child(el().pin(None, Some(0.0), Some(0.0), Some(0.0)).w(1.0).fill(line_c)),
    );
    for (k, &n) in compared.iter().enumerate() {
        let v = &vs[n];
        let mut h = col().w(col_w).min_w(0.0).px(10.0).pt(9.0).pb(9.0).justify_center();
        if k > 0 {
            h = h.pl(11.0).child(el().pin(Some(0.0), Some(0.0), None, Some(0.0)).w(1.0).fill(line_c));
        }
        if v.shown {
            h = h.fill(t.c.muted);
        }
        h = h.child(version_name(t, n, v));
        if can_link && let Some(id) = v.linked_id.clone() {
            let label = if s.unlinking.as_deref() == Some(id.as_str()) { "Unlinking…" } else { "Unlink" };
            h = h.child(
                el().mt(4.0).child(
                    Btn::new(format!("track-unlink-{n}"), label)
                        .small()
                        .ghost()
                        .disabled(s.unlinking.is_some())
                        .build(t)
                        .label(format!("Unlink {}", version_label(v, n)))
                        .on_press(move |app: &mut App| unlink(app, id.clone())),
                ),
            );
        }
        head = head.child(h);
    }
    let mut table = col().w(table_w).child(head);
    for (key, label) in &fields {
        let mut r = row().w(table_w).items_stretch().child(
            cell(72.0)
                .fill(t.c.popover)
                .px(10.0)
                .pt(9.0)
                .pb(6.0)
                .child(el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(1.0).fill(line_c))
                .child(el().pin(None, Some(0.0), Some(0.0), Some(0.0)).w(1.0).fill(line_c))
                .child(text(*label).font(font(12.0, 400.0)).color(t.c.muted_foreground).wrap_anywhere()),
        );
        for (k, &n) in compared.iter().enumerate() {
            let v = &vs[n];
            let value = v.field(key);
            let same_as_first = n > 0 && same(value, vs[0].field(key));
            let mut d = col()
                .w(col_w)
                .min_w(0.0)
                .px(10.0)
                .pt(7.0)
                .pb(6.0)
                .child(el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(1.0).fill(line_c));
            if k > 0 {
                d = d.pl(11.0).child(el().pin(Some(0.0), Some(0.0), None, Some(0.0)).w(1.0).fill(line_c));
            }
            if v.shown {
                d = d.fill(t.c.muted);
            }
            d = d.child(
                text(if value.is_empty() { "—".to_string() } else { value.to_string() })
                    .font(font(14.0, 400.0))
                    .color(if same_as_first { t.c.muted_foreground } else { t.c.foreground })
                    .wrap_anywhere(),
            );
            r = r.child(d);
        }
        table = table.child(r);
    }
    let r = t.radius_lg();
    let boxed = css_border(el(), 1.0, t.c.border, r).w_full().padding(1.0).radius(r).clip_rounded(r);
    let boxed = if table_w > width - 2.0 { boxed.child(el().w_full().scroll_x().child(table)) } else { boxed.child(table) };
    c.child(boxed.fill(Color::TRANSPARENT))
}
