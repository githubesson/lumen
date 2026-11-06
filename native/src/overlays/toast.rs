//! `UpdateToast.tsx` (`update-toast.css`): the bottom-right card in the main
//! pane offering an update the background check found: download it, watch
//! the progress, then restart to install. Dismissing hides the current step
//! for the session; a finished download still comes back as "ready to
//! install". It follows the updater through the settings' desktop bridge.

use std::collections::HashSet;

use rune::{Color, Cx, El, Shadow, col, el, row, text};

use super::settings::desktop_bridge::{self as bridge, UpdateStatus};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::{Btn, brand_mark, font, ico, icons as i, motion, tnum, with_lh};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Available,
    Downloading,
    Downloaded,
    Failed,
}

#[derive(Default)]
pub struct State {
    /// "version:offer" / "version:ready" steps dismissed this session.
    dismissed: HashSet<String>,
    /// Set by our own Download, so only a download started here shows its error.
    download_started: bool,
    /// The status the Download click was made against.
    requested_at: Option<UpdateStatus>,
    installing: bool,
    /// The last status that wasn't "checking": a background re-check doesn't
    /// blink the toast away.
    last: Option<UpdateStatus>,
    prev_state: Option<String>,
}

/// The updater's status as the toast follows it ("checking" keeps the last).
fn status(app: &App) -> Option<UpdateStatus> {
    match bridge::update_status(app) {
        Some(s) if s.state != "checking" => Some(s),
        _ => app.overlays.toast.last.clone(),
    }
}

fn phase(app: &App, s: &UpdateStatus) -> Option<Phase> {
    match s.state.as_str() {
        "available" => Some(Phase::Available),
        "downloading" => Some(Phase::Downloading),
        "downloaded" => Some(Phase::Downloaded),
        "error" if app.overlays.toast.download_started => Some(Phase::Failed),
        _ => None,
    }
}

fn dismiss_key(s: &UpdateStatus, phase: Phase) -> String {
    format!("{}:{}", s.target_version.as_deref().unwrap_or(""), if phase == Phase::Downloaded { "ready" } else { "offer" })
}

/// Keep up with the updater: remember the last real status, and close out a
/// download we started once the update is found, finished or gone. Runs
/// before each frame (`overlays::poll`), as the web's status events.
pub fn on_status(app: &mut App) {
    let Some(s) = bridge::update_status(app) else { return };
    let t = &mut app.overlays.toast;
    if s.state != "checking" {
        t.last = Some(s.clone());
    }
    if t.prev_state.as_deref() != Some(&s.state) {
        t.prev_state = Some(s.state.clone());
        if matches!(s.state.as_str(), "available" | "downloaded" | "up-to-date") {
            t.download_started = false;
        }
    }
}

fn dismiss(app: &mut App) {
    let Some(s) = status(app) else { return };
    let Some(p) = phase(app, &s) else { return };
    app.overlays.toast.dismissed.insert(dismiss_key(&s, p));
}

fn download(app: &mut App) {
    let s = status(app);
    let t = &mut app.overlays.toast;
    t.requested_at = s;
    t.download_started = true;
    bridge::download_update(app);
    on_status(app);
}

/// A failed download leaves the updater in "error"; a fresh check finds the
/// update again and puts the Download button back.
fn retry(app: &mut App) {
    bridge::check_for_updates(app);
    on_status(app);
}

fn install(app: &mut App, tx: &mut rune::Tx) {
    app.overlays.toast.installing = true;
    bridge::install_update(app, tx);
    if bridge::update_status(app).is_some_and(|s| s.state == "error") {
        app.overlays.toast.installing = false;
    }
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let s = &status(app)?;
    let p = phase(app, s)?;
    if app.overlays.toast.dismissed.contains(&dismiss_key(s, p)) {
        return None;
    }
    let st = &app.overlays.toast;
    // Bottom-right of the main pane: 20 px in from its right, 16 up from its bottom.
    let main = cx.layout("main")?;
    let [ww, wh] = super::window_size(cx);
    // From the pane's padding box, inside its 1 px border.
    let right = ww - (main[0] + main[2] - 1.0) + 20.0;
    let bottom = wh - (main[1] + main[3] - 1.0) + 16.0;
    let width = 320.0f32.min(main[2] - 32.0);

    let name = s.target_version.as_deref().map_or("A new version".to_string(), |v| format!("Lumen {v}"));
    let progress = s.progress.unwrap_or(0.0).round().clamp(0.0, 100.0);
    let (title, detail) = match p {
        Phase::Available => ("Update available", format!("{name} is out. You have {}.", s.current_version)),
        Phase::Downloading => ("Downloading update", name.clone()),
        Phase::Downloaded => ("Ready to install", "Restart Lumen to finish updating.".to_string()),
        Phase::Failed => ("Download failed", s.message.clone()),
    };
    let head = row()
        .w_full()
        .gap(10.0)
        .items_start()
        .child(brand_mark(t, 28.0).radius(t.radius_md()))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .pt(1.0)
                .child(text(title).font(with_lh(font(13.0, 600.0), 16.9)).color(t.c.popover_foreground))
                .child(
                    text(detail)
                        .font(with_lh(font(12.0, 400.0), 16.8))
                        .color(if p == Phase::Failed { t.c.destructive } else { t.c.muted_foreground })
                        .wrap()
                        .max_lines(2)
                        .mt(2.0),
                ),
        )
        .child(
            // `.iconbtn.update-toast-close`: 24 px, muted.
            el().key("update-toast-close")
                .size(24.0, 24.0)
                .mt(-4.0)
                .mr(-4.0)
                .radius(t.radius_lg())
                .center()
                .role("button")
                .cursor(rune::Cursor::Pointer)
                .focusable(true)
                .hover(t.c.ghost_hover)
                .child(ico(&i::X, 14.0, t.c.muted_foreground))
                .label("Dismiss update")
                .help("Dismiss update")
                .on_press(dismiss),
        );
    let mut foot = row().w_full().min_h(28.0).gap(6.0).items_center().justify_end();
    match p {
        Phase::Available => {
            foot = foot.child(Btn::new("update-toast-later", "Later").small().ghost().build(t).on_press(dismiss)).child(
                Btn::new("update-toast-download", "Download")
                    .small()
                    .primary()
                    .disabled(st.requested_at.as_ref() == Some(s) || !bridge::can_download())
                    .build(t)
                    .on_press(download),
            );
        }
        Phase::Downloading => {
            foot = foot
                .child(
                    el().grow(1.0)
                        .h(6.0)
                        .ml(38.0)
                        .radius(999.0)
                        .fill(t.c.muted)
                        .clip_rounded(999.0)
                        .role("progressbar")
                        .label("Download progress")
                        .child(el().h_full().w_frac(progress as f32 / 100.0).radius(999.0).fill(t.c.primary)),
                )
                .child(
                    el().min_w(28.0)
                        .items_end()
                        .child(text(format!("{progress}%")).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground)),
                );
        }
        Phase::Downloaded => {
            foot = foot.child(Btn::new("update-toast-later", "Later").small().ghost().disabled(st.installing).build(t).on_press(dismiss)).child(
                Btn::new("update-toast-install", if st.installing { "Restarting…" } else { "Restart & install" })
                    .small()
                    .primary()
                    .disabled(st.installing)
                    .build(t)
                    .on_press_tx(install),
            );
        }
        Phase::Failed => {
            foot = foot.child(Btn::new("update-toast-retry", "Try again").small().build(t).on_press(retry));
        }
    }
    let r = t.radius_xl();
    let a = t.c.shadow_md_alpha;
    Some(
        crate::ui::css_border(col(), 1.0, t.c.border, r)
            .key("update-toast")
            .pin(None, None, Some(right), Some(bottom))
            .w(width)
            .padding(13.0)
            .gap(12.0)
            .radius(r)
            .fill(t.c.popover)
            .box_shadow(Shadow { x: 0.0, y: 4.0, blur: 6.0, spread: -1.0, color: Color::BLACK.alpha(a), inset: false })
            .box_shadow(Shadow { x: 0.0, y: 2.0, blur: 4.0, spread: -2.0, color: Color::BLACK.alpha(a), inset: false })
            .box_shadow(Shadow { x: 0.0, y: 12.0, blur: 32.0, spread: -12.0, color: Color::BLACK.alpha(0.25), inset: false })
            .role("status")
            .label("App update")
            .transition(rune::Transition::offset(0.0, 8.0).combined(rune::Transition::scale(0.98)))
            .offset_motion(motion::ease_out(320.0))
            .child(head)
            .child(foot),
    )
}
