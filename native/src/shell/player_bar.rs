//! `MiniPlayer.tsx` in its docked form: `NowPlaying`, `Transport`,
//! `ProgressBar` and the utility buttons (`player.css`).

use rune::{Cursor, El, Icon, col, el, row, text};

use crate::api::media;
use crate::app::App;
use crate::format::fmt_duration_sec;
use crate::player::Repeat;
use crate::theme::Theme;
use crate::ui::{self, css_border, font, ico, icons as i, line, tnum};
use crate::ui::tooltip::TipExt;

/// `.t-btn`: a 28 px muted icon button.
pub fn t_btn(t: &Theme, key: &str, glyph: &'static Icon, active: bool, disabled: bool) -> El {
    let ink = if active { t.c.foreground } else { t.c.muted_foreground };
    let mut b = el()
        .key(key)
        .size(28.0, 28.0)
        .radius(t.radius_md())
        .center()
        .role("button")
        .child(ico(glyph, 14.0, ink).group_color(t.c.foreground));
    if active {
        b = b.fill(t.c.muted);
    }
    if disabled {
        b.opacity(0.4).disabled(true)
    } else {
        b.cursor(Cursor::Pointer).focusable(true).hover(t.c.ghost_hover)
    }
}

/// `SeekBar`'s look: a 4 px track with the filled part in the primary colour.
fn bar(t: &Theme, key: &str, value: f32) -> El {
    let v = value.clamp(0.0, 1.0);
    el().key(key)
        .grow(1.0)
        .h(4.0)
        .radius(999.0)
        .fill(t.c.muted)
        .cursor(Cursor::Pointer)
        .child(el().pin(Some(0.0), Some(0.0), None, Some(0.0)).w_frac(v).radius(999.0).fill(t.c.primary))
}

fn now_playing(app: &App, t: &Theme) -> El {
    let p = &app.player;
    let track = p.current();
    let title = track.map(|t| crate::format::display_text(Some(&t.title), "Nothing playing")).unwrap_or_else(|| "Nothing playing".into());
    let artist = track
        .map(|t| {
            let a = crate::format::display_text(t.artist.as_deref(), "—");
            match t.album_title.as_deref().filter(|s| !s.is_empty()) {
                Some(album) => format!("{a} · {album}"),
                None => a,
            }
        })
        .unwrap_or_default();
    let cover = track.map(|tr| media::track_cover(&tr.id, tr.album_id.as_deref(), tr.cover_url.as_deref(), None));
    let letter = track.map(|tr| tr.album_title.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| tr.title.clone())).unwrap_or_else(|| "·".into());
    let art = ui::cover_art(t, &app.images, cover.as_deref().filter(|_| track.is_some()), &letter, 48.0, 48.0, t.radius_md());
    let mut lines = col().grow(1.0).min_w(0.0).h(48.0).gap(2.0).justify_center()
        .child(line(title.clone(), font(14.0, 500.0), t.c.foreground).tip_truncated("np-title", &title, font(14.0, 500.0)));
    if let Some(err) = &p.error {
        lines = lines.child(line(err.summary.clone(), font(12.0, 400.0), t.c.destructive));
    } else {
        lines = lines.child(line(artist.clone(), font(12.0, 400.0), t.c.muted_foreground).tip_truncated("np-artist", &artist, font(12.0, 400.0)));
    }
    row().key("np").gap(12.0).items_center().min_w(0.0).child(art).child(lines)
}

fn transport(app: &App, t: &Theme) -> El {
    let p = &app.player;
    let disabled = !p.has_track();
    let repeat_active = p.repeat != Repeat::Off;
    let mut repeat = t_btn(t, "repeat", &i::REPEAT, repeat_active, false)
        .label(match p.repeat {
            Repeat::Off => "Repeat off",
            Repeat::All => "Repeat all",
            Repeat::One => "Repeat one",
        })
        .on_press(|app: &mut App| app.player.cycle_repeat());
    if p.repeat == Repeat::One {
        repeat = repeat.child(
            text("1").font(font(12.0, 600.0)).color(t.c.foreground).absolute(14.0 + 8.0 - 3.5, 14.0 + 8.0 - 8.7),
        );
    }
    let play_fill = t.c.primary;
    let play = el()
        .key("play")
        .size(32.0, 32.0)
        .radius(999.0)
        .fill(play_fill)
        .center()
        .role("button")
        .label(if p.playing { "Pause" } else { "Play" })
        .child(ico(if p.playing { &i::PAUSE_FILLED } else { &i::PLAY_FILLED }, 16.0, t.c.primary_foreground));
    let play = if disabled {
        play.opacity(0.5).disabled(true)
    } else {
        // The primary at 80% over the bar is the bar's colour at 20% over the primary.
        play.cursor(Cursor::Pointer).focusable(true).hover(t.c.background.alpha(0.2))
            .on_press(|app: &mut App| app.player.toggle_play())
    };
    let controls = row()
        .gap(8.0)
        .items_center()
        .child(
            t_btn(t, "shuffle", &i::SHUFFLE, p.shuffle, false)
                .label("Shuffle")
                .on_press(|app: &mut App| app.player.toggle_shuffle()),
        )
        .child(t_btn(t, "previous", &i::SKIP_BACK_FILLED, false, disabled).label("Previous").on_press(|app: &mut App| app.player.previous()))
        .child(play)
        .child(t_btn(t, "next", &i::SKIP_FORWARD_FILLED, false, disabled).label("Next").on_press(|app: &mut App| app.player.next()))
        .child(repeat);
    let duration = p.duration.unwrap_or(0.0);
    let progress = if duration > 0.0 { (p.position / duration) as f32 } else { 0.0 };
    let time = |s: String| el().min_w(32.0).center().child(text(s).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground));
    let progress_row = row()
        .w_full()
        .gap(8.0)
        .items_center()
        .child(time(fmt_duration_sec(p.position)))
        .child(bar(t, "seek", progress).label("Seek"))
        .child(time(fmt_duration_sec(duration)));
    col().key("transport").w_full().min_w(0.0).gap(6.0).items_center().child(controls).child(progress_row)
}

fn utility(app: &App, t: &Theme) -> El {
    let p = &app.player;
    let has = p.has_track();
    let fav = p.current().is_some_and(|tr| app.pages.favorites_has(&tr.id));
    let off = p.muted || p.volume == 0.0;
    let volume = row()
        .key("volume")
        .w(130.0)
        .gap(8.0)
        .items_center()
        .child(t_btn(t, "mute", if off { &i::VOLUME_X } else { &i::VOLUME_2 }, false, false)
            .label(if off { "Unmute" } else { "Mute" })
            .on_press(|app: &mut App| app.player.toggle_mute()))
        .child(bar(t, "volume-bar", if p.muted { 0.0 } else { p.volume }).label("Volume"));
    row()
        .key("utility")
        .gap(8.0)
        .items_center()
        .justify_end()
        .child(t_btn(t, "devices", &i::MONITOR, false, false).label("Playback device"))
        .child(
            t_btn(t, "favorite", if fav { &i::HEART_FILLED } else { &i::HEART }, fav, !has)
                .label(if fav { "Remove from favorites" } else { "Add to favorites" }),
        )
        .child(
            t_btn(t, "lyrics", &i::MIC_VOCAL, app.ui.lyrics_open, !has)
                .label("Toggle lyrics panel")
                .tip("lyrics", "Lyrics")
                .on_press(|app: &mut App| app.ui.lyrics_open = !app.ui.lyrics_open),
        )
        .child(t_btn(t, "queue", &i::LIST_MUSIC, false, false).label("Queue"))
        .child(volume)
        .child(t_btn(t, "mini-player", &i::MINIMIZE_2, false, false).label("Mini player").tip("mini-player", "Mini player"))
}

pub fn view(app: &App, t: &Theme) -> El {
    // `grid-template-columns: 1fr 1.3fr 1fr` with a 16 px gap.
    css_border(row(), 1.0, t.c.border, t.radius_xl())
        .key("player-bar")
        .w_full()
        .h(72.0)
        .px(13.0)
        .py(1.0)
        .gap(16.0)
        .items_center()
        .radius(t.radius_xl())
        .fill(t.c.background)
        .clip_rounded(t.radius_xl())
        .child(el().grow(1.0).w(0.0).min_w(0.0).child(now_playing(app, t).w_full()))
        .child(el().grow(1.3).w(0.0).min_w(0.0).child(transport(app, t)))
        .child(el().grow(1.0).w(0.0).min_w(0.0).justify_end().child(utility(app, t)))
}
