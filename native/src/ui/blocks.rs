//! Page building blocks: `Section.tsx`, `ListPageHeader.tsx`,
//! `PageHeader.tsx`, `list/ListMeta.tsx`, `list/LoadMoreSentinel.tsx`,
//! `DataState.tsx`, `CenteredCard.tsx`, `RadioCardOption.tsx`,
//! `IosSpinner.tsx`, `AnimatedNumber.tsx` and `PlayListButton.tsx`
//! (`home.css`, `detail.css`, `primitives.css`, `auth.css`).

use std::cell::RefCell;
use std::collections::HashMap;

use rune::{Color, Cursor, El, Icon, col, el, row, text};
use rune_motion::{Beat, Easing, LoopSpec, Sequence};

use crate::api::TrackListItem;
use crate::app::App;
use crate::theme::{Theme, color_mix};
use crate::ui::kit::{error_banner, loading_state};
use crate::ui::track_select::Source;
use crate::ui::{Btn, exact, font, ico, icons as i, tnum, with_lh};

/// `Section`: the eyebrow (`sub`) over the 16 px title, an optional action
/// at the right (a "view all" link), then the section's content.
pub fn section(t: &Theme, key: &str, sub: Option<&str>, title: &str, action: Option<El>, body: El) -> El {
    section_with(t, key, sub, title, action, body, SectionLook::default())
}

/// How a [`section_with`]'s head looks: `home.css`'s `.section-head` and
/// `.section-title`, or a page's override of them.
#[derive(Clone, Copy, Debug)]
pub struct SectionLook {
    /// `.section-title`'s type.
    pub title: rune::TextStyle,
    /// `.section-head`'s `margin-bottom`.
    pub gap: f32,
    /// `align-items: center` (else `baseline`, the title's last line on the action's).
    pub center: bool,
}

impl Default for SectionLook {
    fn default() -> Self {
        SectionLook { title: font(16.0, 600.0).tracking(-0.16), gap: 12.0, center: false }
    }
}

impl SectionLook {
    /// `artist.css`'s `.artist-section`: an 18 px title, centred, 10 px above the content.
    pub fn artist() -> Self {
        SectionLook { title: font(18.0, 600.0).tracking(-0.27), gap: 10.0, center: true }
    }
}

/// [`section`] with its head styled by `look`.
pub fn section_with(t: &Theme, key: &str, sub: Option<&str>, title: &str, action: Option<El>, body: El, look: SectionLook) -> El {
    col().key(key).w_full().child(section_head(t, sub, title, action, look).mb(look.gap)).child(body)
}

/// `.section-head` alone (without its `margin-bottom`), for a section whose
/// content is a virtualised [`TrackList::page`](crate::ui::track_list::TrackList::page).
pub fn section_head(t: &Theme, sub: Option<&str>, title: &str, action: Option<El>, look: SectionLook) -> El {
    let mut head_text = col().min_w(0.0);
    if let Some(s) = sub {
        head_text = head_text.child(exact(text(s).font(font(12.0, 400.0)).color(t.c.muted_foreground), 17.4));
    }
    let lh = look.title.line_height;
    head_text = head_text.child(exact(text(title).font(look.title).color(t.c.foreground), lh));
    let mut head = row().w_full().gap(16.0).justify_between().child(head_text);
    head = if look.center { head.items_center() } else { head.items_end() };
    if let Some(a) = action {
        head = head.child(a);
    }
    head
}

/// `.section-link`: a muted 14 px link that lights up on hover.
pub fn section_link(t: &Theme, key: &str, label: &str, href: &str) -> El {
    let href = href.to_string();
    el().key(key)
        .role("link")
        .label(label)
        .cursor(Cursor::Pointer)
        .hover_group()
        .child(text(label).font(font(14.0, 400.0)).color(t.c.muted_foreground).group_color(t.c.foreground))
        .on_press(move |app: &mut App| app.navigate_to(&href))
}

/// `ListPageHeader`'s props.
#[derive(Default)]
pub struct ListHeader<'a> {
    /// `.detail-kind`: "Collection", "Recent", "Playlist"…
    pub kind: &'a str,
    pub title: &'a str,
    /// A muted paragraph between title and meta (a playlist's description).
    pub description: Option<&'a str>,
    /// Its cover fills the art (`heroTrack`).
    pub hero: Option<&'a TrackListItem>,
    /// Drawn on the muted art when there's no hero (`fallbackIcon`, 48 px).
    pub fallback_icon: Option<&'static Icon>,
    /// Replaces the art entirely (`art`).
    pub art: Option<El>,
    /// Replaces the kind's text (a playlist's visibility icon and role),
    /// held to its own line height.
    pub kind_el: Option<El>,
    /// Replaces the title's text (a playlist owner's "Edit details" button).
    pub title_el: Option<El>,
    pub meta: Option<El>,
    pub actions: Option<El>,
}

/// `ListPageHeader` (`.detail-header`): the card with the 200 px art and the
/// kind, title, meta and actions along its bottom.
pub fn list_page_header(app: &App, t: &Theme, key: &str, h: ListHeader) -> El {
    let art = h.art.unwrap_or_else(|| {
        let base = el().size(200.0, 200.0).radius(t.radius_lg()).clip_rounded(t.radius_lg()).fill(t.c.muted).center();
        match h.hero {
            Some(tr) => {
                let url = crate::ui::track_row::cover_url_full(tr);
                match app.images.get(&url) {
                    crate::images::Cover::Ready(img) => base.child(el().size(200.0, 200.0).pixels_fit(img.pixels(), rune::SurfaceFit::Fill)),
                    _ => base,
                }
            }
            None => match h.fallback_icon {
                Some(g) => base.child(ico(g, 48.0, t.c.muted_foreground)),
                None => base,
            },
        }
    });
    let mut body = col().grow(1.0).min_w(0.0).justify_end();
    // A custom kind sets its own line height (an inline-flex icon box makes
    // the browser's line taller than the text's 17.4 px).
    let kind = h.kind_el.unwrap_or_else(|| exact(text(h.kind).font(font(12.0, 500.0)).color(t.c.muted_foreground), 17.4));
    body = body.child(kind);
    // Wrapped lines held to their CSS height (Rune rounds a text box up).
    let title = h.title_el.unwrap_or_else(|| {
        text(h.title).font(list_title_style()).color(t.c.card_foreground).wrap_anywhere()
    });
    body = body.child(crate::ui::snug_lines(&format!("{key}-title"), title, list_title_style().line_height).mt(6.0).mb(10.0));
    if let Some(d) = h.description {
        // `max-width: 60ch`: sixty of the font's "0".
        let style = font(14.0, 400.0);
        let ch = rune::text::advance("0", style);
        let d = text(d).font(style).color(t.c.muted_foreground).wrap();
        body = body.child(crate::ui::snug_lines(&format!("{key}-description"), d, style.line_height).max_w(60.0 * ch).mb(10.0));
    }
    if let Some(m) = h.meta {
        body = body.child(m);
    }
    if let Some(a) = h.actions {
        body = body.child(row().mt(16.0).gap(8.0).items_center().flex_wrap().child(a));
    }
    crate::ui::css_border(row(), 1.0, t.c.border, t.radius_xl())
        .key(key)
        .w_full()
        .min_h(200.0)
        .padding(25.0)
        .gap(24.0)
        .items_end()
        .radius(t.radius_xl())
        .fill(t.c.card)
        .clip_rounded(t.radius_xl())
        .child(art)
        .child(body)
}

/// `.detail-title`'s type: 36 px semibold on a 39.6 px line.
pub fn list_title_style() -> rune::TextStyle {
    with_lh(font(36.0, 600.0), 39.6).tracking(-0.9)
}

/// `.detail-meta`: muted 14 px parts with 3 px dots between them.
pub fn meta_line(t: &Theme, parts: &[&str]) -> El {
    let mut r = row().gap(8.0).items_center().flex_wrap();
    for (n, p) in parts.iter().enumerate() {
        if n > 0 {
            r = r.child(meta_dot(t));
        }
        r = r.child(text(*p).font(font(14.0, 400.0)).color(t.c.muted_foreground));
    }
    // 20.3 px tall, as the browser lays it out (Rune rounds the text to 21).
    exact(r, 20.3)
}

/// `.detail-meta .dot`.
pub fn meta_dot(t: &Theme) -> El {
    el().size(3.0, 3.0).radius(99.0).fill(t.c.muted_foreground)
}

/// `PageHeader` with its right-aligned actions (`.page-header`); the plain
/// title and count are `kit::page_header`.
///
/// The row aligns its items' baselines: the 24 px title's sits 25.9 px down
/// its 34.8 px line, the count's 15.15 px down its 20.3, and a button's at
/// its top (Chromium takes an inline-flex button's baseline from its
/// leading icon), so the title and the actions share the row's top.
pub fn page_header(t: &Theme, title: &str, count: Option<&str>, actions: Option<El>) -> El {
    let mut h = row().w_full().gap(16.0).items_start().flex_wrap();
    // Both drawn a pixel higher than the line boxes put them: where
    // Chromium's 24 px baseline lands (measured against the reference).
    h = h.child(crate::ui::exact(text(title).font(with_lh(font(24.0, 600.0), 34.8).tracking(-0.6)).color(t.c.foreground), 34.8).shrink());
    if let Some(c) = count {
        h = h.child(crate::ui::exact(text(c).font(tnum(font(14.0, 400.0))).color(t.c.muted_foreground), 20.3).shrink().mt(25.9 - 15.15));
    }
    h = h.child(el().grow(1.0));
    if let Some(a) = actions {
        h = h.child(a);
    }
    h
}

/// `ListMeta`'s line: "120 of 4,512 tracks", "4,512 tracks", or "—" before
/// the first page.
pub fn list_meta_text(loaded: Option<u64>, total: Option<u64>, unit: &str) -> String {
    let units = |n: u64| if n == 1 { unit.to_string() } else { format!("{unit}s") };
    match (loaded, total) {
        (None, _) => "—".into(),
        (Some(l), Some(tot)) if tot > l => format!("{} of {} {}", group(l), group(tot), units(tot)),
        (Some(_), Some(tot)) => format!("{} {}", group(tot), units(tot)),
        (Some(l), None) => format!("{} {}", group(l), units(l)),
    }
}

/// `ListMeta`: the mono count under a library toolbar, 14 px below it (its
/// 17.4 px line box held, so what follows sits where the browser puts it).
pub fn list_meta(t: &Theme, loaded: Option<u64>, total: Option<u64>, unit: &str) -> El {
    exact(text(list_meta_text(loaded, total, unit)).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground), 17.4).mt(14.0)
}

/// `toLocaleString()` in en-US: thousands grouped with commas.
pub fn group(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (k, c) in s.chars().enumerate() {
        if k > 0 && (s.len() - k) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `LoadMoreSentinel`: a 1 px marker that asks for the next page when it
/// scrolls into view (`more`), and "Loading more…" while one loads.
pub fn load_more(t: &Theme, key: &str, more: bool, loading: bool, on_near: fn(&mut App)) -> El {
    let mut c = col().key(key).w_full();
    if more {
        c = c.child(el().key(format!("{key}-sentinel")).w_full().h(1.0).on_visible(move |app: &mut App, visible, _| {
            if visible {
                on_near(app);
            }
        }));
    }
    if loading {
        c = c.child(loading_state(t, "Loading more…"));
    }
    c
}

/// `DataState`: the error banner, "Loading…" until there's data, the empty
/// state when `empty`, else the content.
pub fn data_state<T>(t: &Theme, data: Option<&T>, error: Option<&str>, loading_label: Option<&str>, empty: Option<(bool, El)>, content: impl FnOnce(&T) -> El) -> El {
    let mut c = col().w_full();
    if let Some(e) = error {
        c = c.child(error_banner(t, e));
    }
    match data {
        None if error.is_none() => c.child(loading_state(t, loading_label.unwrap_or("Loading…"))),
        None => c,
        Some(d) => match empty {
            Some((true, e)) => c.child(e),
            _ => c.child(content(d)),
        },
    }
}

/// `CenteredCard` (`.auth-wrap` / `.auth-card`): the brand mark, a title and
/// intro over the card's content, centred in the window.
pub fn centered_card(t: &Theme, key: &str, title: &str, intro: Option<&str>, content: El) -> El {
    let mut head = col().w_full().gap(12.0).mb(24.0).items_center().child(crate::ui::brand_mark(t, 38.0));
    let mut words = col().items_center().child(text(title).font(font(24.0, 600.0).tracking(-0.48)).color(t.c.foreground));
    if let Some(i) = intro {
        words = words.child(text(i).font(font(14.0, 400.0)).color(t.c.muted_foreground).wrap().mt(6.0));
    }
    head = head.child(words);
    let card = crate::ui::css_border(col(), 1.0, t.c.border, t.radius_xl())
        .key(format!("{key}-card"))
        .w_full()
        .max_w(400.0)
        .padding(25.0)
        .radius(t.radius_xl())
        .fill(t.c.card)
        .child(head)
        .child(content);
    col().key(key).w_full().h_full().padding(24.0).fill(t.c.background).center().child(card)
}

/// `RadioCardOption`: a bordered card with a radio, a label and a line
/// under it; checked, it takes the primary border and a faint tint.
pub fn radio_card(t: &Theme, key: &str, checked: bool, label: &str, description: &str, on_pick: impl Fn(&mut App) + 'static) -> El {
    let border = if checked { t.c.primary } else { t.c.border };
    let fill = if checked { color_mix(t.c.primary, 0.05, Color::TRANSPARENT) } else { Color::TRANSPARENT };
    let words = col()
        .grow(1.0)
        .min_w(0.0)
        .child(text(label).font(font(14.0, 500.0)).color(t.c.foreground).wrap())
        .child(text(description).font(font(12.0, 400.0)).color(t.c.muted_foreground).wrap().mt(2.0));
    crate::ui::css_border(row(), 1.0, border, t.radius_lg())
        .key(key)
        .w_full()
        .padding(13.0)
        .gap(12.0)
        .items_start()
        .radius(t.radius_lg())
        .fill(fill)
        .role("radio")
        .checked(checked)
        .label(label)
        .cursor(Cursor::Pointer)
        .focusable(true)
        .child(radio_dot(t, checked).mt(3.0))
        .child(words)
        .on_press(on_pick)
}

/// Chromium's 13 px radio in `accent-color: var(--primary)`.
fn radio_dot(t: &Theme, checked: bool) -> El {
    let ring = if t.dark() { rune::color::hex("#858585").unwrap() } else { rune::color::hex("#767676").unwrap() };
    let face = if t.dark() { rune::color::hex("#3b3b3b").unwrap() } else { Color::WHITE };
    if checked {
        el().size(13.0, 13.0).radius(99.0).fill(t.c.primary).center().child(el().size(5.0, 5.0).radius(99.0).fill(if t.dark() { face } else { Color::WHITE }))
    } else {
        el().size(13.0, 13.0).radius(99.0).fill(face).border(1.0, ring)
    }
}

/// `IosSpinner` (`.ios-spinner`): twelve spokes fading round, `size` px
/// across (28 by default), in the muted ink unless given one.
pub fn ios_spinner(t: &Theme, size: f32, ink: Option<Color>) -> El {
    let ink = ink.unwrap_or(t.c.muted_foreground);
    let mut s = el().size(size, size).role("status").label("Loading");
    let r = size / 2.0 - 1.0;
    for k in 0..12 {
        // Each spoke is a 2.2 × 7 pill from the top edge, turned about the
        // centre by k × 30°; its fade runs a twelfth of a second behind.
        let a = (k as f32) * std::f32::consts::PI / 6.0;
        let (sx, sy) = a.sin_cos();
        let mid = r - 3.5;
        let cx = size / 2.0 + sx * mid;
        let cy = size / 2.0 - sy * mid;
        // `animation-delay: -k/12 s` on an endless loop is the same as
        // starting it (1 - k/12) s in.
        static FADE: [Beat; 2] = [Beat::new(0.0), Beat::new(1.0).opacity(0.18).easing(Easing::LINEAR)];
        let delay = (1.0 - (k as f64) / 12.0) % 1.0;
        let spoke = el()
            .absolute(cx - 1.1, cy - 3.5)
            .size(2.2, 7.0)
            .radius(999.0)
            .fill(ink)
            .rotate(a)
            .looping(LoopSpec { delay, ..LoopSpec::sequence(Sequence::new(&FADE)) });
        s = s.child(spoke);
    }
    s
}

/// `AnimatedNumber`'s state: each counter's run, by key, and the clock the
/// last poll saw.
#[derive(Default)]
pub struct Numbers {
    runs: RefCell<HashMap<String, Run>>,
    clock: std::cell::Cell<f64>,
}

#[derive(Clone, Copy, Debug)]
struct Run {
    from: f64,
    to: f64,
    /// When it started (clock seconds); None until the next poll starts it.
    start: Option<f64>,
}

const COUNT_SECS: f64 = 0.6;

fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}

impl Run {
    fn at(&self, now: f64) -> f64 {
        match self.start {
            None => self.from,
            Some(s) => self.from + (self.to - self.from) * ease_out_cubic(((now - s) / COUNT_SECS).clamp(0.0, 1.0)),
        }
    }
}

/// `AnimatedNumber`: counts up from 0 (then from its last value) to `value`
/// over 600 ms, ease-out cubic, with thousands separators. Under reduced
/// motion it shows the value at once.
pub fn animated_number(app: &App, cx: &rune::Cx<App>, key: &str, value: f64, style: rune::TextStyle, ink: Color) -> El {
    let shown = animated_value(app, cx, key, value);
    text(format_count(shown)).font(tnum(style)).color(ink).key(key.to_string())
}

/// [`animated_number`]'s value this frame, for a counter that formats it
/// itself (`AnimatedNumber`'s `format`: Replay's listening time) or sets it
/// with other text.
pub fn animated_value(app: &App, cx: &rune::Cx<App>, key: &str, value: f64) -> f64 {
    let nums = &app.widgets.numbers;
    let now = nums.clock.get();
    let shown = if cx.is_reduced_motion() {
        nums.runs.borrow_mut().insert(key.to_string(), Run { from: value, to: value, start: Some(now) });
        value
    } else {
        let mut runs = nums.runs.borrow_mut();
        let run = runs.entry(key.to_string()).or_insert(Run { from: 0.0, to: value, start: None });
        if run.to != value {
            *run = Run { from: run.at(now), to: value, start: None };
        }
        run.at(now)
    };
    shown
}

/// Runs before each frame: starts new counts and keeps frames coming while
/// any runs.
pub fn poll_numbers(app: &mut App, clock: f64, tx: &mut rune::Tx) -> bool {
    let nums = &app.widgets.numbers;
    nums.clock.set(clock);
    let mut moving = false;
    for run in nums.runs.borrow_mut().values_mut() {
        if run.start.is_none() {
            run.start = Some(clock);
        }
        if clock < run.start.unwrap_or(clock) + COUNT_SECS {
            moving = true;
        } else {
            run.from = run.to;
        }
    }
    if moving {
        tx.wake_after(std::time::Duration::from_millis(16));
    }
    moving
}

/// `Math.round(n).toLocaleString()`.
pub fn format_count(n: f64) -> String {
    let r = n.round();
    if r < 0.0 { format!("-{}", group((-r) as u64)) } else { group(r as u64) }
}

/// `PlayListButton`: the primary button that plays a whole list, from its
/// first playable track or, with shuffle on, a random one.
pub fn play_list_button(t: &Theme, key: &str, label: &str, source: Source, disabled: bool) -> El {
    Btn::new(key, label)
        .primary()
        .icon(&i::PLAY_FILLED)
        .icon_size(16.0)
        .disabled(disabled)
        .build(t)
        .on_press(move |app: &mut App| {
            let tracks = source(app).to_vec();
            let shuffle = app.player.shuffle;
            crate::ui::track_row::start_list(app, &tracks, shuffle);
        })
}
