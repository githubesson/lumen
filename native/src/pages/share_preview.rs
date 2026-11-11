//! `SharePreview.tsx` (`share-preview.css`), at `/shared/track/:id`: the
//! public card a share link opens, which plays the snippet and needs no
//! session.

use rune::{Align, Color, Cursor, Cx, Drag, El, Phase, Side, Tx, col, el, row, text};

use crate::app::App;
use crate::player::adapter::{AdapterEvent, AudioAdapter};
use crate::format::fmt_duration_sec;
use crate::api::share::{PublicTrackShare, TrackShareRef, get_public_track_share, track_share_preview_video_path};
use crate::core::share_snippet::{parse_track_share_params, share_clip_name};
use crate::route::Location;
use crate::theme::{Theme, color_mix};
use crate::ui::kit::{error_banner_in, eyebrow, menu_panel};
use crate::ui::{Btn, brand_mark, css_border, font, ico, icons as i, line, tnum, with_lh};

/// `useCopiedFlag(1600)`.
const COPIED_FOR: f64 = 1.6;

#[derive(Default)]
pub struct State {
    /// The link the page shows (`id`, `t`, `d`, `sig`), None when malformed.
    pub link: Option<TrackShareRef>,
    pub share: Option<PublicTrackShare>,
    pub error: Option<String>,
    pub loading: bool,
    pub playing: bool,
    /// `video.currentTime`, seconds into the snippet.
    pub current: f64,
    /// `video.duration` once the media's metadata loaded.
    pub media_duration: f64,
    pub dragging: bool,
    /// When "Copied" shows until (clock seconds); set from the next poll.
    pub copied: bool,
    copied_until: Option<f64>,
    /// The clock at the last poll while playing.
    last_tick: Option<f64>,
    pub menu_open: bool,
    /// A download that failed to save.
    pub download_error: Option<String>,
    /// The snippet's own media (the page's `<audio>`/`<video>`, apart from
    /// the app's player); made on the first play. None in headless runs,
    /// where the clock in `poll` stands in for `timeupdate`.
    audio: Option<Box<dyn AudioAdapter>>,
}

/// The route's share id and its query, as `parseTrackShareParams` reads them.
fn link_of(loc: &Location) -> Option<TrackShareRef> {
    let id = loc.path.strip_prefix("/shared/track/")?;
    let id = urlencoding::decode(id)
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| id.to_string());
    parse_track_share_params(Some(&id), loc.get("t"), loc.get("d"), loc.get("sig"))
}

/// A new link starts a new request (the effect keyed on the link's parts).
pub fn enter(app: &mut App, loc: &Location) {
    // Each visit mounts the page afresh, as the route's component does.
    let link = link_of(loc);
    let s = &mut app.pages.share_preview;
    *s = State {
        link: link.clone(),
        loading: true,
        ..State::default()
    };
    let Some(link) = link else {
        s.loading = false;
        s.error = Some("Share link unavailable.".into());
        return;
    };
    let Some(client) = app.client.clone() else {
        return;
    };
    let asked = link.clone();
    app.net.run(
        move || {
            get_public_track_share(&client, &link.track_id, link.start_sec as f64, &link.sig, link.duration_sec.map(f64::from))
        },
        move |app, result| {
            let s = &mut app.pages.share_preview;
            if s.link.as_ref() != Some(&asked) {
                return;
            }
            s.loading = false;
            match result {
                Ok(share) => s.share = Some(share),
                Err(e) => s.error = Some(crate::api::error_message(&e, "Share link unavailable.")),
            }
        },
    );
}

fn duration(s: &State) -> f64 {
    if s.media_duration > 0.0 {
        return s.media_duration;
    }
    s.share
        .as_ref()
        .and_then(|x| x.preview_duration_sec)
        .unwrap_or(30.0)
        .max(1.0)
}

fn toggle_play(app: &mut App) {
    let s = &mut app.pages.share_preview;
    if s.share.is_none() {
        return;
    }
    if s.playing {
        s.playing = false;
        return;
    }
    if s.current >= duration(s) - 0.1 {
        s.current = 0.0;
    }
    s.playing = true;
    s.last_tick = None;
    let current = s.current;
    if let Some(audio) = snippet_audio(app) {
        audio.seek(current);
        if !audio.play() {
            app.pages.share_preview.playing = false;
        }
    }
}

/// The snippet's media, made (and loaded with `share.audio_url`, else the
/// `preview_url` MP4) on first use. None in headless runs.
fn snippet_audio(app: &mut App) -> Option<&mut Box<dyn AudioAdapter>> {
    if rune::tooling::headless_run().is_some() || app.net.is_sync() {
        return None;
    }
    if app.pages.share_preview.audio.is_none() {
        let share = app.pages.share_preview.share.as_ref()?;
        let raw = share.audio_url.clone().filter(|u| !u.is_empty()).unwrap_or_else(|| share.preview_url.clone());
        let url = match &app.client {
            Some(c) if raw.starts_with('/') => c.url(&raw),
            _ => raw,
        };
        let engine = crate::player::engine::Engine::start(app.waker.clone(), app.config.audio_sink_id.clone());
        let client = std::sync::Arc::new(std::sync::Mutex::new(app.client.clone()));
        let mut audio: Box<dyn AudioAdapter> = Box::new(crate::player::engine::EngineAdapter::new(engine, client));
        audio.set_equalizer(app.tweaks.equalizer);
        audio.load(&url);
        app.pages.share_preview.audio = Some(audio);
    }
    app.pages.share_preview.audio.as_mut()
}

fn seek(app: &mut App, value: f64) {
    let s = &mut app.pages.share_preview;
    let d = duration(s);
    s.current = (value * d).clamp(0.0, d);
    let at = s.current;
    if let Some(audio) = s.audio.as_mut() {
        audio.seek(at);
    }
}

fn copy(app: &mut App, tx: &mut Tx) {
    let s = &mut app.pages.share_preview;
    let Some(share) = &s.share else { return };
    tx.copy(share.canonical_url.clone());
    s.copied = true;
    s.copied_until = None;
}

/// Timers: the playback clock and the "Copied" flash. True when the view changed.
pub fn poll(app: &mut App, clock: f64, tx: &mut Tx) -> bool {
    if let Some(audio) = app.pages.share_preview.audio.as_mut() { audio.set_equalizer(app.tweaks.equalizer); }
    let shown = app.location().path.starts_with("/shared/track/");
    let s = &mut app.pages.share_preview;
    if !shown {
        // Unmounted: the media element (and its playback) went with it.
        let changed = s.playing || s.copied;
        s.playing = false;
        s.copied = false;
        s.audio = None;
        return changed;
    }
    let mut changed = false;
    if s.copied {
        let until = *s.copied_until.get_or_insert(clock + COPIED_FOR);
        if clock >= until {
            s.copied = false;
            s.copied_until = None;
            changed = true;
        } else {
            tx.wake_after(std::time::Duration::from_secs_f64(until - clock));
        }
    }
    if let Some(audio) = s.audio.as_mut() {
        // The media's own clock and events (`timeupdate`, `loadedmetadata`, `ended`).
        while let Some(ev) = audio.next_event() {
            match ev {
                AdapterEvent::LoadedMetadata => s.media_duration = audio.duration(),
                AdapterEvent::Ended | AdapterEvent::Error => s.playing = false,
                _ => {}
            }
            changed = true;
        }
        if !s.playing {
            audio.pause();
        } else if !s.dragging {
            s.current = audio.current_time().min(duration(s));
            changed = true;
            tx.wake_after(std::time::Duration::from_millis(250));
        }
        return changed;
    }
    if s.playing && !s.dragging {
        if let Some(last) = s.last_tick {
            let d = duration(s);
            s.current = (s.current + (clock - last).max(0.0)).min(d);
            if s.current >= d {
                // `onEnded`.
                s.playing = false;
                s.current = d;
            }
            changed = true;
        }
        s.last_tick = s.playing.then_some(clock);
        if s.playing {
            // `timeupdate` comes about four times a second.
            tx.wake_after(std::time::Duration::from_millis(250));
        }
    }
    changed
}

/// "Open Lumen": the app's own page when the link is this server's,
/// otherwise the browser.
fn open_lumen(app: &mut App, tx: &mut Tx) {
    let Some(share) = &app.pages.share_preview.share else {
        return;
    };
    let url = share.open_url.clone();
    let base = app
        .client
        .as_ref()
        .map(|c| c.base().to_string())
        .unwrap_or_default();
    match url
        .strip_prefix(&base)
        .filter(|rest| !base.is_empty() && rest.starts_with('/'))
    {
        Some(path) => app.navigate_to(path),
        None => {
            let _ = crate::desktop::open_external(tx, &url);
        }
    }
}

/// `<a href download>`: Electron asks where to save it, then downloads it.
fn download(app: &mut App, tx: &mut Tx, href: String, file_name: String, ext: &'static str) {
    app.pages.share_preview.menu_open = false;
    let options = rune::FileDialogOptions {
        title: "Save".into(),
        file_name: Some(file_name),
        ..Default::default()
    }
    .filter(ext.to_uppercase(), &[ext]);
    tx.save_file(options, move |app: &mut App, result, _tx| {
        let Ok(Some(path)) = result else { return };
        let Some(client) = app.client.clone() else {
            return;
        };
        app.net.run(
            move || {
                client
                    .bytes(&href)
                    .map_err(|e| e.to_string())
                    .and_then(|(bytes, _)| std::fs::write(&path, bytes).map_err(|e| e.to_string()))
            },
            |app, r| app.pages.share_preview.download_error = r.err(),
        );
    });
}

/// The card's content width: 380 less 16 px of padding and a 1 px border a side.
const CARD_W: f32 = 346.0;

/// Text boxed as CSS boxes it, `CARD_W` wide (rune rounds each box up).
fn boxed(e: El, s: &str, style: rune::TextStyle, anywhere: bool) -> El {
    let opts = if anywhere { rune::text::RichLayoutOptions::new().wrap_anywhere() } else { rune::text::RichLayoutOptions::new() };
    e.h(crate::ui::css_text_h_with(s, style, Some(CARD_W), opts))
}

fn header(t: &Theme, eyebrow_text: &str, title: &str, meta: Option<String>) -> El {
    let eb = font(12.0, 500.0);
    let title_style = with_lh(font(20.0, 600.0), 24.0).tracking(-0.4);
    let mut h = col()
        .w_full()
        .min_w(0.0)
        .gap(6.0)
        .child(boxed(eyebrow(t, eyebrow_text).wrap(), eyebrow_text, eb, false))
        .child(boxed(
            text(title).font(title_style).color(t.c.card_foreground).wrap_anywhere().w_full(),
            title,
            title_style,
            true,
        ));
    if let Some(m) = meta {
        let style = font(14.0, 400.0);
        h = h.child(boxed(text(m.clone()).font(style).color(t.c.muted_foreground).wrap_anywhere().w_full(), &m, style, true));
    }
    h
}

/// `.share-preview-footer`: `1fr 1fr auto` across the card's bottom edge.
fn footer(t: &Theme, a: El, b: Option<El>, c: Option<El>) -> El {
    let r = t.radius_xl() - 1.0;
    // Stretched across the card's padding (no width: the margins widen it).
    let bar = row()
        .mx(-16.0)
        .mb(-16.0)
        .px(16.0)
        .pt(13.0)
        .pb(12.0)
        .gap(8.0)
        .fill(color_mix(t.c.muted, 0.5, Color::TRANSPARENT))
        .corners([0.0, 0.0, r, r])
        .child(
            el().pin(Some(0.0), Some(0.0), Some(0.0), None)
                .h(1.0)
                .fill(t.c.border)
                .inert(),
        )
        .child(el().grow(1.0).w(0.0).child(a.w_full()))
        .child(el().grow(1.0).w(0.0).children(b.map(|b| b.w_full())));
    bar.child(el().h_full().children(c))
}

/// `.share-preview-card`.
fn card(t: &Theme, children: Vec<El>) -> El {
    let r = t.radius_xl();
    let mut c = css_border(col(), 1.0, t.c.border, r)
        .key("share-card")
        .w_full()
        .padding(17.0)
        .gap(16.0)
        .radius(r)
        .fill(t.c.card)
        .role("region")
        .label("Shared track");
    for ch in children {
        c = c.child(ch);
    }
    c
}

/// `ShareSeekBar`: the 4 px track, its fill and the thumb that shows on hover.
fn seek_bar(t: &Theme, value: f64, dragging: bool) -> El {
    let v = value.clamp(0.0, 1.0) as f32;
    let thumb = el()
        .key("share-seek-thumb")
        .size(12.0, 12.0)
        .radius(999.0)
        .fill(t.c.background)
        .border(1.0, t.c.primary)
        .inert();
    let thumb = if dragging {
        thumb
    } else {
        thumb.group_opacity(0.0, 1.0)
    };
    let mut bar = el()
        .key("share-seek")
        .w_full()
        .h(4.0)
        .radius(999.0)
        .fill(t.c.muted)
        .role("slider")
        .label("Seek preview")
        .focusable(true)
        .focus_ring(2.0, 3.0, t.c.focus_ring)
        .cursor(Cursor::Pointer)
        .hover_group()
        .on_step(move |a: &mut App, delta, _| {
            let s = &a.pages.share_preview;
            let now = s.current / duration(s);
            seek(a, (now + 0.05 * delta.signum() as f64).clamp(0.0, 1.0));
        })
        .on_step_limit(|a: &mut App, end, _| seek(a, if end { 1.0 } else { 0.0 }))
        .child(
            el().pin(Some(0.0), Some(0.0), None, Some(0.0))
                .w_frac(v)
                .radius(999.0)
                .fill(t.c.primary)
                .inert(),
        );
    // The thumb, centred on the value; the hit area reaches 10 px above and below.
    bar = bar
        .child(
            el().pin(Some(0.0), Some(-4.0), Some(0.0), Some(-4.0))
                .inert()
                .child(
                    row()
                        .w_full()
                        .h_full()
                        .child(el().w_frac(v))
                        .child(thumb.ml(-6.0)),
                ),
        )
        .child(
            el().pin(Some(0.0), Some(-10.0), Some(0.0), Some(-10.0))
                .on_drag(|a: &mut App, d: &mut Drag, _| {
                    let at = if d.w > 0.0 {
                        (d.x / d.w).clamp(0.0, 1.0) as f64
                    } else {
                        0.0
                    };
                    match d.phase {
                        Phase::Down => {
                            a.pages.share_preview.dragging = true;
                            seek(a, at);
                        }
                        Phase::Move => seek(a, at),
                        Phase::Up => a.pages.share_preview.dragging = false,
                    }
                }),
        );
    bar
}

fn player(t: &Theme, s: &State) -> El {
    let d = duration(s);
    let progress = if d > 0.0 {
        (s.current / d).min(1.0)
    } else {
        0.0
    };
    let play = el()
        .key("share-play")
        .size(36.0, 36.0)
        .radius(999.0)
        .fill(t.c.primary)
        .center()
        .role("button")
        .label(if s.playing {
            "Pause preview"
        } else {
            "Play preview"
        })
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(t.c.background.alpha(0.2))
        .press_scale(0.94)
        .child(ico(
            if s.playing {
                &i::PAUSE_FILLED
            } else {
                &i::PLAY_FILLED
            },
            16.0,
            t.c.primary_foreground,
        ))
        .on_press(toggle_play);
    let times = row()
        .w_full()
        .justify_between()
        .child(
            text(fmt_duration_sec(s.current))
                .font(tnum(font(12.0, 400.0)))
                .color(t.c.muted_foreground)
                .h(17.4),
        )
        .child(
            text(fmt_duration_sec(d))
                .font(tnum(font(12.0, 400.0)))
                .color(t.c.muted_foreground)
                .h(17.4),
        );
    row().w_full().gap(12.0).items_center().child(play).child(
        col()
            .grow(1.0)
            .min_w(0.0)
            .gap(8.0)
            .pt(6.0)
            .child(seek_bar(t, progress, s.dragging))
            .child(times),
    )
}

fn shared(app: &App, t: &Theme, s: &State, share: &PublicTrackShare) -> El {
    let art = crate::ui::cover_art(
        t,
        &app.images,
        share.cover_url.as_deref(),
        &share.title,
        346.0,
        346.0,
        t.radius_lg(),
    );
    let mut eyebrow_text = "Shared track".to_string();
    if share.start_sec > 0.0 {
        eyebrow_text.push_str(&format!(
            " · Starts at {}",
            fmt_duration_sec(share.start_sec)
        ));
    }
    let mut meta = share
        .artist
        .clone()
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| "Unknown artist".into());
    if let Some(album) = share.album.as_deref().filter(|a| !a.is_empty()) {
        meta.push_str(&format!(" · {album}"));
    }
    let open = Btn::new("share-open", "Open Lumen")
        .primary()
        .icon(&i::EXTERNAL_LINK).icon_size(16.0)
        .build(t)
        .on_press_tx(open_lumen);
    let copy_btn = Btn::new("share-copy", if s.copied { "Copied" } else { "Copy link" })
        .icon(if s.copied { &i::CHECK } else { &i::CLIPBOARD_COPY }).icon_size(16.0)
        .build(t)
        .on_press_tx(copy);
    let download = s.link.is_some().then(|| {
        let chevron = ico(&i::CHEVRON_DOWN, 14.0, t.c.foreground)
            .rotate(if s.menu_open {
                std::f32::consts::PI
            } else {
                0.0
            })
            .rotate_motion(crate::ui::motion::ease_out(150.0));
        Btn::new("share-download", "")
            .icon(&i::DOWNLOAD).icon_size(16.0)
            .build(t)
            .gap(4.0)
            .h_full()
            .label("Download snippet")
            .expanded(s.menu_open)
            .child(chevron)
            .on_press(|a: &mut App| {
                a.pages.share_preview.menu_open = !a.pages.share_preview.menu_open
            })
    });
    let mut children = vec![
        art.w_full(),
        header(t, &eyebrow_text, &share.title, Some(meta)),
        player(t, s),
        footer(t, open, Some(copy_btn), download),
    ];
    if let Some(e) = &s.download_error {
        children.insert(3, error_banner_in(t, e, Some(CARD_W)));
    }
    card(t, children)
}

/// The download menu, above its trigger at the right (`bottom: calc(100% + 6px)`).
fn download_menu(app: &App, t: &Theme) -> Option<El> {
    let s = &app.pages.share_preview;
    if !s.menu_open {
        return None;
    }
    let share = s.share.as_ref()?;
    let link = s.link.as_ref()?;
    let client = app.client.as_ref()?;
    let base = share_clip_name(Some(&share.title), share.artist.as_deref(), &[]);
    let mut items: Vec<(
        &'static str,
        &'static str,
        String,
        &'static str,
        &'static rune::Icon,
    )> = Vec::new();
    if let Some(audio) = &share.audio_url {
        items.push(("Audio", "M4A", audio.clone(), "m4a", &i::MUSIC));
    }
    items.push((
        "Video",
        "MP4",
        client.url(&track_share_preview_video_path(link)),
        "mp4",
        &i::FILM,
    ));
    let mut menu = menu_panel(t, "share-download-menu", None).min_w(180.0);
    for (label, hint, href, ext, glyph) in items {
        let name = format!("{base}.{ext}");
        menu = menu.child(
            row()
                .key(format!("share-download-{ext}"))
                .w_full()
                .min_h(28.0)
                .px(6.0)
                .py(4.0)
                .gap(6.0)
                .items_center()
                .radius(t.radius_md())
                .role("menuitem")
                .label(label)
                .cursor(Cursor::Pointer)
                .focusable(true)
                .hover(t.c.accent)
                .focus_highlight(t.c.accent)
                .child(ico(glyph, 16.0, t.c.popover_foreground).group_color(t.c.accent_foreground))
                .child(
                    line(label, font(14.0, 400.0), t.c.popover_foreground)
                        .group_color(t.c.accent_foreground)
                        .grow(1.0),
                )
                .child(
                    text(hint)
                        .font(font(12.0, 400.0))
                        .color(t.c.muted_foreground),
                )
                .on_press_tx(move |a: &mut App, tx| {
                    download(a, tx, href.clone(), name.clone(), ext)
                }),
        );
    }
    let close = |a: &mut App| a.pages.share_preview.menu_open = false;
    Some(
        el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .modal(false, close)
            .child(
                el().key("share-download-dismiss")
                    .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .on_press(close),
            )
            .child(
                menu.focus_group()
                    .anchored("share-download", Side::Top, Align::End, 6.0),
            ),
    )
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let s = &app.pages.share_preview;
    let h = crate::pages::auth::window_h(cx);
    let brand = row()
        .key("share-brand")
        .self_center()
        .gap(8.0)
        .items_center()
        .role("link")
        .label("Lumen home")
        .hover(t.c.ghost_hover)
        .cursor(Cursor::Pointer)
        .focusable(true)
        .child(brand_mark(t, 24.0).radius(t.radius_md()))
        .child(text("Lumen").font(font(14.0, 600.0)).color(t.c.foreground).h(20.3))
        .on_press(|a: &mut App| a.navigate_to("/"));
    let mut shell = col().w_full().max_w(380.0).gap(16.0).child(brand);
    if s.loading {
        let r = t.radius_xl();
        shell = shell.child(
            css_border(el(), 1.0, t.c.border, r)
                .w_full()
                .min_h(200.0)
                .radius(r)
                .fill(t.c.card)
                .center()
                .child(
                    el().padding(20.0).child(
                        text("Loading…")
                            .font(tnum(font(14.0, 400.0)))
                            .color(t.c.muted_foreground),
                    ),
                ),
        );
    } else if let Some(share) = &s.share {
        shell = shell.child(shared(app, t, s, share));
    } else if let Some(e) = &s.error {
        let open = Btn::new("share-open", "Open Lumen")
            .primary()
            .icon(&i::EXTERNAL_LINK).icon_size(16.0)
            .build(t)
            .on_press(|a: &mut App| a.navigate_to("/"));
        shell = shell.child(card(
            t,
            vec![
                header(t, "Shared track", "Preview unavailable", None),
                error_banner_in(t, e, Some(CARD_W)),
                footer(t, open, None, None),
            ],
        ));
    }
    let page = col()
        .key("share-page")
        .w_full()
        .min_h(h)
        .padding(24.0)
        .center()
        .fill(t.c.background)
        .child(shell);
    let mut root = el()
        .w_full()
        .h_full()
        .child(crate::pages::auth::card::page_scroller(
            t,
            "share-scroll",
            page,
        ));
    if let Some(menu) = download_menu(app, t) {
        root = root.child(menu);
    }
    root
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_come_from_the_route() {
        let l = link_of(&Location::parse("/shared/track/t-1?t=45&d=30&sig=abc")).unwrap();
        assert_eq!(
            (
                l.track_id.as_str(),
                l.start_sec,
                l.duration_sec,
                l.sig.as_str()
            ),
            ("t-1", 45, Some(30), "abc")
        );
        assert!(link_of(&Location::parse("/shared/track/t-1?t=4")).is_none());
    }
}
