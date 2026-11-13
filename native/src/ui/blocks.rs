//! Page building blocks: `Section.tsx`, `ListPageHeader.tsx`,
//! `PageHeader.tsx`, `list/ListMeta.tsx`, `DataState.tsx`, `IosSpinner.tsx`,
//! `AnimatedNumber.tsx` and `PlayListButton.tsx` (`home.css`, `detail.css`,
//! `primitives.css`, `player-lyrics.css`).

use std::cell::RefCell;
use std::collections::HashMap;

use rune::{El, Icon, col, el, row, text};

use crate::api::TrackListItem;
use crate::app::App;
use crate::theme::Theme;
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
                let url = tr.cover_at(None);
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

/// `PageHeader` (`.page-header`): the 24 px title, an optional muted count
/// after it and right-aligned actions.
///
/// The row aligns its items' baselines: the count's sits on the title's
/// ([`css_baseline`](crate::ui::css_baseline): 25 px down the title's 34.8 px
/// line, 15 down the count's 20.3), and a button's at its top (Chromium takes
/// an inline-flex button's baseline from its leading icon), so the title and
/// the actions share the row's top. The title keeps Rune's whole-pixel box:
/// the pages under it (the library's toolbar and track table) are measured
/// with it.
pub fn page_header(t: &Theme, title: &str, count: Option<&str>, actions: Option<El>) -> El {
    let mut h = row().w_full().gap(16.0).items_start().flex_wrap();
    h = h.child(text(title).font(with_lh(font(24.0, 600.0), 34.8).tracking(-0.6)).color(t.c.foreground).shrink());
    if let Some(c) = count {
        let drop = crate::ui::css_baseline(24.0, 34.8) - crate::ui::css_baseline(14.0, 20.3);
        h = h.child(crate::ui::exact(text(c).font(tnum(font(14.0, 400.0))).color(t.c.muted_foreground), 20.3).shrink().mt(drop));
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

/// `DataState`: the error banner, "Loading…" until there's data, the empty
/// state when `empty`, else the content.
pub fn data_state<T: ?Sized>(t: &Theme, data: Option<&T>, error: Option<&str>, loading_label: Option<&str>, empty: Option<(bool, El)>, content: impl FnOnce(&T) -> El) -> El {
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

/// `IosSpinner` (`.ios-spinner`): twelve 2.2 × 7 px spokes round a `size`
/// px circle (`--spinner-size`, 28 unless a rule sets it) in the muted ink,
/// each fading from full to 18% over a second, a twelfth of a turn behind
/// the last. `label` is its `aria-label`.
pub fn ios_spinner(t: &Theme, key: &str, size: f32, label: &str) -> El {
    const PHASES: [f32; 12] = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0];
    let mut s = el().key(key).size(size, size).role("status").label(label);
    for (n, k) in PHASES.iter().enumerate() {
        let spoke = el()
            .absolute(size / 2.0 - 1.1, 1.0)
            .size(2.2, 7.0)
            .radius(999.0)
            .fill(t.c.muted_foreground)
            // A ≤ 30 fps cycle that settles at the reduced-motion opacity.
            .looping(rune::LoopSpec::cycle(rune::Cycle {
                period: 1.0,
                // `animation-delay: calc(var(--i) * -1s / 12)`.
                phase: -k / 12.0,
                stops: &[(0.0, 1.0), (1.0, 0.18)],
                still: 0.45,
                fps: 30.0,
            }));
        // Each spoke turns about the circle's centre (`rotate(var(--i) * 30deg)`).
        s = s.child(
            el().key(format!("{key}-{n}"))
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .rotate(*k * std::f32::consts::PI / 6.0)
                .inert()
                .child(spoke),
        );
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

/// `AnimatedNumber`'s value this frame: it counts up from 0 (then from its
/// last value) to `value` over 600 ms, ease-out cubic; under reduced motion
/// it is the value at once. The caller formats it ([`format_count`] gives
/// the thousands separators; Replay's listening time formats its own).
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

/// The original sleeve's compact secondary button, shared by new collection actions.
/// Keep the 32 px box and 16 px glyph; accessible text lives in the label/tooltip.
pub fn shuffle_button(t: &Theme, key: &str, disabled: bool) -> El {
    Btn::new(key, "").icon(&i::SHUFFLE).icon_size(16.0).disabled(disabled).build(t)
        .w(32.0).px(0.0).label("Shuffle play").help("Shuffle play")
}

/// Start this collection at once in shuffled order, shuffle on (native only).
pub fn shuffle_list_button(t: &Theme, key: &str, source: Source, disabled: bool) -> El {
    shuffle_button(t, key, disabled)
        .on_press(move |app: &mut App| {
            let tracks = source(app).to_vec();
            app.player.start_shuffled_list(&tracks);
        })
}

pub fn list_play_actions(t: &Theme, key: &str, source: Source, disabled: bool) -> El {
    row().gap(8.0).flex_wrap().items_center()
        .child(play_list_button(t, &format!("{key}-play"), "Play all", source, disabled))
        .child(shuffle_list_button(t, &format!("{key}-shuffle"), source, disabled))
}
