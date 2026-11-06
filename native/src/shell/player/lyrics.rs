//! `LyricsSidebar.tsx`, `PlayerLyricsLine.tsx`, `context/LyricsPanel.tsx`,
//! `lib/useTrackLyrics.ts` and `lib/lyricsCache.ts` (`lyrics-sidebar.css`,
//! `player-lyrics.css`): the lyrics column beside the page (a drawer over
//! it at 760 px and under), and the lyrics view it shares with the mini
//! player's panel: synced lines with the active line and word, plain
//! lyrics, "Instrumental", "No lyrics found", a spinner and errors.
//! Lyrics only ever come from the server.

use std::cell::RefCell;
use std::rc::Rc;

use rune::{Color, Cx, El, Span, Tx, col, el, row, text};

use crate::api::lyrics::LyricsResult;
use crate::api::{TrackListItem, media};
use crate::app::App;
use crate::ui::tooltip::TipExt;
use crate::core::lyrics::{
    LYRICS_NOT_FOUND_MESSAGE, LyricsCache, LyricsCacheEntry, LyricsContent, active_line_index, active_word_index_for_line,
    lyrics_cache_key_for, lyrics_content, lyrics_error_message, lyrics_request_for, lyrics_timing_duration,
};
use crate::format::display_text;
use crate::theme::{Theme, color_mix};
use crate::ui::{BtnState, cover_art, css_border, font, ico, iconbtn, icons as i, line, with_lh};

/// The lyrics cache (`lyricsCache.ts`), shared by every lyrics view.
#[derive(Clone, Default)]
pub struct SharedCache(Rc<RefCell<LyricsCache>>);

impl std::fmt::Debug for SharedCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LyricsCache")
    }
}

impl PartialEq for SharedCache {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

/// `useTrackLyrics`' state for the track a lyrics view shows.
#[derive(Clone, Debug, PartialEq)]
pub struct Lyrics {
    cache: SharedCache,
    /// The track the state is for (`lyricsCacheKey`); None while no lyrics
    /// view is open.
    pub key: Option<String>,
    pub loading: bool,
    pub error: Option<String>,
    pub result: Option<LyricsResult>,
    /// `lyricsContent(result)`, parsed once per answer.
    pub parsed: LyricsContent,
    /// The synced line last scrolled to (`lastScrolledLineRef`).
    pub scrolled: isize,
}

impl Default for Lyrics {
    fn default() -> Self {
        Lyrics { cache: SharedCache::default(), key: None, loading: false, error: None, result: None, parsed: LyricsContent::None, scrolled: -1 }
    }
}

impl Lyrics {
    fn set_result(&mut self, r: LyricsResult) {
        self.parsed = lyrics_content(Some(&r));
        self.result = Some(r);
    }
}

/// Whether a lyrics view is open: the column (or drawer), or the mini
/// player's lyrics panel.
pub fn enabled(app: &App) -> bool {
    let mini = &app.ui.player.mini;
    if mini.on { mini.panel == Some(super::mini::Panel::Lyrics) || mini.requested == Some(super::mini::Panel::Lyrics) } else { app.ui.lyrics_open }
}

/// Open or close the lyrics column (`useLyricsPanel().setOpen`).
pub fn set_open(app: &mut App, open: bool) {
    app.ui.lyrics_open = open;
    sync(app);
}

/// Load the lyrics of the current track while a lyrics view is open, through
/// the cache; reset the state while none is. True when the state changed.
pub fn sync(app: &mut App) -> bool {
    let track = if enabled(app) { app.player.current().cloned() } else { None };
    let key = track.as_ref().map(lyrics_cache_key_for);
    if key == app.ui.player.lyrics.key {
        return false;
    }
    let l = &mut app.ui.player.lyrics;
    l.key = key.clone();
    l.scrolled = -1;
    l.result = None;
    l.parsed = LyricsContent::None;
    l.error = None;
    l.loading = false;
    let (Some(track), Some(key)) = (track, key) else { return true };
    let cached = l.cache.0.borrow().peek(&key).cloned();
    match cached {
        // A cached answer for the new track replaces the previous track's.
        Some(LyricsCacheEntry::Hit(r)) => l.set_result(r),
        Some(LyricsCacheEntry::Miss) => l.error = Some(LYRICS_NOT_FOUND_MESSAGE.into()),
        None => {
            l.loading = true;
            // A request for this track already in flight answers it below.
            if l.cache.0.borrow_mut().begin(&key) {
                fetch(app, &track, key);
            }
        }
    }
    true
}

fn fetch(app: &mut App, track: &TrackListItem, key: String) {
    let Some(client) = app.client.clone() else { return };
    let query = lyrics_request_for(track);
    app.net.run(
        move || crate::api::lyrics::get_lyrics(&client, &query),
        move |app, result| {
            let entry = app.ui.player.lyrics.cache.0.borrow_mut().finish(&key, result);
            let l = &mut app.ui.player.lyrics;
            if l.key.as_deref() != Some(key.as_str()) {
                return;
            }
            l.loading = false;
            match entry {
                Ok(LyricsCacheEntry::Hit(r)) => l.set_result(r),
                Ok(LyricsCacheEntry::Miss) => l.error = Some(LYRICS_NOT_FOUND_MESSAGE.into()),
                Err(e) => {
                    eprintln!("Failed to fetch lyrics: {e}");
                    l.error = Some(lyrics_error_message(&e).into());
                }
            }
        },
    );
}

/// The synced lines and the active line and word at the player's clock.
struct Synced<'a> {
    lines: &'a [crate::core::lyrics::SyncedLine],
    active: isize,
    word: Option<usize>,
}

fn synced(app: &App) -> Option<Synced<'_>> {
    let LyricsContent::Synced(lines) = &app.ui.player.lyrics.parsed else { return None };
    let p = &app.player;
    let time = p.position;
    let active = active_line_index(lines, time);
    let duration = lyrics_timing_duration(p.current().map(|t| t.duration_ms), p.duration.unwrap_or(0.0)).max(1.0);
    let word = (active >= 0)
        .then(|| &lines[active as usize])
        .filter(|line| !line.section)
        .and_then(|line| active_word_index_for_line(line, lines.get(active as usize + 1), time, duration));
    Some(Synced { lines, active, word })
}

/// Every frame: glide the active synced line to the middle of its view when
/// it changes (the `useLayoutEffect` on `currentIndex`).
pub fn follow(app: &mut App, tx: &mut Tx) {
    if app.ui.player.lyrics.key.is_none() {
        return;
    }
    let Some(active) = synced(app).map(|s| s.active) else { return };
    if active < 0 || active == app.ui.player.lyrics.scrolled {
        return;
    }
    app.ui.player.lyrics.scrolled = active;
    let scope = if app.ui.player.mini.on { "mini-lyrics-scroll" } else { "lyrics-scroll" };
    tx.scroll_center_in(scope, format!("{scope}-line-{active}"));
}

// ---- views ----

/// The column's width (`--lyrics-panel-w`).
pub fn column_width(t: &Theme) -> f32 {
    if t.layout == crate::theme::Layout::Wide { 320.0 } else { 280.0 }
}

/// The lyrics column beside the main pane, with its 8 px gutter, while
/// open; it slides in from 12 px right as it fades in, and the column's
/// track opens and closes with it.
pub fn column(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    if !app.ui.lyrics_open || app.ui.player.mini.on {
        return None;
    }
    let w = column_width(t);
    let enter = rune::Transition::offset(12.0, 0.0).combined(rune::Transition::opacity()).hold_layout();
    Some(row().key("lyrics-column").w(w + 8.0).h_full().transition(enter).child(el().w(8.0)).child(sidebar(app, t, cx).w(w)))
}

/// At 760 px and under: the panel floats over the page from the right, over
/// a scrim; Escape or a click on the scrim closes it.
pub fn drawer(app: &App, t: &Theme, cx: &mut Cx<App>, window_w: f32) -> Option<El> {
    if !app.ui.lyrics_open || app.ui.player.mini.on {
        return None;
    }
    let w = 320.0f32.min(window_w - 48.0);
    let panel = super::shadow_md(t, sidebar(app, t, cx))
        .pin(None, Some(4.0), Some(4.0), Some(4.0))
        .w(w)
        .transition(rune::Transition::offset(12.0, 0.0).combined(rune::Transition::opacity()));
    Some(
        el().key("lyrics-drawer")
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .modal(true, |app: &mut App| set_open(app, false))
            .child(
                el().key("lyrics-backdrop")
                    .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .fill(t.c.scrim)
                    .transition(rune::Transition::opacity())
                    .on_press(|app: &mut App| set_open(app, false)),
            )
            .child(panel),
    )
}

/// `.lyrics-sidebar`: the heading, the track, and the lyrics under them.
fn sidebar(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let r = t.radius_xl();
    let close = iconbtn(t, "lyrics-close", &i::X, 16.0, BtnState::default())
        .label("Close lyrics panel")
        .tip("lyrics-close", "Close lyrics")
        .on_press(|app: &mut App| set_open(app, false));
    let head = row()
        .w_full()
        .px(12.0)
        .pt(12.0)
        .pb(8.0)
        .gap(8.0)
        .items_center()
        .justify_between()
        .child(
            row()
                .gap(8.0)
                .items_center()
                .child(ico(&i::MIC_VOCAL, 16.0, t.c.foreground))
                .child(super::centred(text("Lyrics").font(font(14.0, 600.0)).color(t.c.foreground), 20.3)),
        )
        .child(close);
    let mut aside = css_border(col(), 1.0, t.c.border, r)
        .key("lyrics-sidebar")
        .h_full()
        .padding(1.0)
        .radius(r)
        .fill(t.c.background)
        .clip_rounded(r)
        .role("complementary")
        .label("Lyrics")
        .child(head);
    match app.player.current() {
        Some(track) => {
            let cover = (track.has_cover != Some(false))
                .then(|| media::track_cover(&track.id, track.album_id.as_deref(), track.cover_url.as_deref(), None));
            let letter = display_text(track.album_title.as_deref().filter(|s| !s.is_empty()).or(Some(&track.title)), "·");
            aside = aside.child(
                row()
                    .w_full()
                    .px(12.0)
                    .pb(8.0)
                    .gap(10.0)
                    .items_center()
                    // `size={44}` sets the box inline, over the CSS 40 px.
                    .child(cover_art(t, &app.images, cover.as_deref(), &letter, 44.0, 44.0, t.radius_md()))
                    .child(
                        col()
                            .grow(1.0)
                            .min_w(0.0)
                            .child(line(display_text(Some(&track.title), ""), font(14.0, 500.0), t.c.foreground).h(20.3))
                            .child(line(super::display::artist_line(track), font(12.0, 400.0), t.c.muted_foreground).mt(2.0).h(17.4)),
                    ),
            );
        }
        None => {
            aside = aside.child(el().px(14.0).pb(12.0).child(text("Nothing playing").font(font(12.0, 400.0)).color(t.c.muted_foreground)));
        }
    }
    let mut body = col().key("lyrics-body").w_full().grow(1.0).min_h(0.0).pt(8.0).pb(12.0);
    if app.player.current().is_some() {
        body = body.child(content(app, t, cx, "lyrics-scroll", false));
    }
    aside.child(body)
}

/// `.player-lyric-status.player-lyric-sidebar`: a centred 14 px note.
fn status(t: &Theme, s: &str) -> El {
    el().w_full()
        .px(16.0)
        .child(text(s).font(with_lh(font(14.0, 400.0), 18.9)).color(t.c.muted_foreground).wrap().align(rune::Align::Center).w_full())
}

/// `PlayerLyricsLine`: what the lyrics state has to show. `scope` keys the
/// scroll view (the column's or the mini panel's).
pub fn content(app: &App, t: &Theme, cx: &mut Cx<App>, scope: &str, mini: bool) -> El {
    let l = &app.ui.player.lyrics;
    if l.loading {
        return col()
            .key(format!("{scope}-loading"))
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .items_center()
            .justify_center()
            .child(super::ios_spinner(t, &format!("{scope}-spinner")));
    }
    if let Some(e) = &l.error {
        return status(t, e);
    }
    if l.result.is_none() {
        return status(t, LYRICS_NOT_FOUND_MESSAGE);
    }
    let [_, window_h] = crate::shell::window_size(cx);
    match &l.parsed {
        LyricsContent::Instrumental => status(t, "Instrumental"),
        LyricsContent::Synced(_) => {
            let s = synced(app).expect("synced lyrics");
            let wrap_w = text_width(cx, scope);
            // `padding: clamp(48px, 10vh, 120px) 18px 24vh`.
            let top = (window_h * 0.1).clamp(48.0, 120.0);
            let mut lines = col().w_full().px(18.0).pt(top).pb(window_h * 0.24);
            for (n, line) in s.lines.iter().enumerate() {
                let state = match (n as isize).cmp(&s.active) {
                    std::cmp::Ordering::Equal => LineState::Active,
                    std::cmp::Ordering::Less => LineState::Past,
                    std::cmp::Ordering::Greater => LineState::Upcoming,
                };
                let word = if state == LineState::Active { s.word } else { None };
                lines = lines.child(synced_line(t, &format!("{scope}-line-{n}"), &line.text, line.section, state, word, wrap_w));
            }
            scroller(cx, scope, lines, mini)
        }
        LyricsContent::Plain(plain) => {
            let wrap_w = text_width(cx, scope);
            let mut lines = col().w_full().px(18.0).pt(36.0).pb(window_h * 0.24);
            for (n, line) in plain.iter().enumerate() {
                let el = if line.section {
                    section_text(t, &line.text, wrap_w)
                } else {
                    css_lines(text(line.text.clone()).font(line_style(400.0)).color(t.c.muted_foreground).wrap(), &line.text, line_style(400.0), wrap_w).mb(18.0)
                };
                lines = lines.child(el.key(format!("{scope}-line-{n}")));
            }
            scroller(cx, scope, lines, mini)
        }
        LyricsContent::None => status(t, LYRICS_NOT_FOUND_MESSAGE),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LineState {
    Active,
    Past,
    Upcoming,
}

/// `.player-lyrics-scroll-line`: 14 px, line height 1.6, tracked −0.01em.
fn line_style(weight: f32) -> rune::TextStyle {
    with_lh(font(14.0, weight), 22.4).tracking(-0.14)
}

/// `.player-lyrics-section`: a muted 12 px heading line.
fn section_text(t: &Theme, s: &str, wrap_w: Option<f32>) -> El {
    let style = with_lh(font(12.0, 500.0), 16.2);
    css_lines(text(s).font(style).color(t.c.muted_foreground).wrap(), s, style, wrap_w).mt(6.0).mb(12.0)
}

/// The width lyrics wrap at in the scroll view `scope` (its last layout,
/// less the 18 px sides).
fn text_width(cx: &mut Cx<App>, scope: &str) -> Option<f32> {
    cx.layout_size(scope).map(|s| s[0] - 36.0).filter(|w| *w > 0.0)
}

/// Wrapped text at its CSS height: whole lines of `style`'s line height
/// (Rune rounds a text box up, which would push the lines under it down).
fn css_lines(e: El, s: &str, style: rune::TextStyle, wrap_w: Option<f32>) -> El {
    let Some(w) = wrap_w else { return e };
    let (_, h) = rune::text::measure(s, &[], style, Some(w));
    let lines = (h / style.line_height).round().max(1.0);
    e.h(lines * style.line_height)
}

/// A synced line in its tier: past lines small and faint, upcoming ones
/// faint, the active one whole and a touch larger (15/14), its words lit up
/// to the one being sung.
fn synced_line(t: &Theme, key: &str, s: &str, section: bool, state: LineState, word: Option<usize>, wrap_w: Option<f32>) -> El {
    let base = color_mix(t.c.muted_foreground, 0.75, Color::TRANSPARENT);
    let mut e = if section {
        section_text(t, s, wrap_w)
    } else if state == LineState::Active {
        let mut spans = Vec::new();
        if let Some(active) = word {
            for (n, (start, end)) in word_ranges(s).into_iter().enumerate() {
                let (ink, weight) = match n.cmp(&active) {
                    std::cmp::Ordering::Less => (faded(color_mix(t.c.foreground, 0.68, Color::TRANSPARENT), 0.88), 500.0),
                    std::cmp::Ordering::Equal => (t.c.foreground, 600.0),
                    std::cmp::Ordering::Greater => (faded(color_mix(t.c.foreground, 0.38, Color::TRANSPARENT), 0.72), 500.0),
                };
                spans.push(Span::new(start, end).color(ink).weight(weight));
            }
        }
        css_lines(text(s).font(line_style(500.0)).color(t.c.foreground).spans(spans).wrap(), s, line_style(500.0), wrap_w).mb(18.0)
    } else {
        css_lines(text(s).font(line_style(400.0)).color(base).wrap(), s, line_style(400.0), wrap_w).mb(18.0)
    };
    e = e.key(key).origin(0.0, 0.5);
    match state {
        LineState::Active => e.scale(1.0714),
        LineState::Past => e.opacity(0.28).scale(0.985).blur(0.35),
        LineState::Upcoming => e.opacity(0.42).blur(0.2),
    }
}

/// The byte ranges of `s`'s words (`text.split(/(\s+)/)`'s non-blank
/// tokens), in the order `activeWordIndexForLine` counts them.
fn word_ranges(s: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, c) in s.char_indices() {
        match (c.is_whitespace(), start) {
            (false, None) => start = Some(i),
            (true, Some(a)) => {
                out.push((a, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(a) = start {
        out.push((a, s.len()));
    }
    out
}

/// `color` at `opacity` (a word's own `opacity` over its colour).
fn faded(color: Color, opacity: f32) -> Color {
    color.alpha(color.a * opacity)
}

/// `.player-lyrics-scroll`: scrolls without a scrollbar, its top and bottom
/// 12% fading out.
fn scroller(cx: &mut Cx<App>, scope: &str, lines: El, mini: bool) -> El {
    let h = cx.layout_size(scope).map_or(0.0, |s| s[1]);
    let fade = h * 0.12;
    let _ = mini;
    col()
        .key(scope)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .scroll(rune::ScrollSpec { stick_bottom: false })
        .clip_fade_linear(0.0, fade, 0.0, fade)
        .child(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_the_non_blank_runs() {
        let s = "  made up  line, here ";
        let words: Vec<&str> = word_ranges(s).into_iter().map(|(a, b)| &s[a..b]).collect();
        assert_eq!(words, ["made", "up", "line,", "here"]);
        assert_eq!(words.len(), s.split_whitespace().count());
        assert!(word_ranges("   ").is_empty());
    }
}
