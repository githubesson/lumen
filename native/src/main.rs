//! Lumen's desktop client, drawn with Rune: a pixel-for-pixel port of the
//! Electron frontend (`frontend/`).
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod api;
mod app;
mod config;
mod core;
mod desktop;
mod format;
mod images;
mod keys;
mod net;
mod overlays;
mod pages;
mod player;
mod resource;
mod route;
mod shell;
mod theme;
mod ui;

/// Geist and Geist Mono, the web app's `--font-sans` and `--font-mono`.
pub const FONTS: &[&[u8]] = &[
    include_bytes!("../assets/fonts/Geist-Variable.ttf"),
    include_bytes!("../assets/fonts/GeistMono-Variable.ttf"),
];

fn main() {
    // Match lumen.desktop so Wayland taskbars and docks can identify this window.
    rune::set_app_id("lumen");
    // `requestSingleInstanceLock`: a second launch brings the first forward.
    // Headless runs (snapshots, scripts) are never the app.
    let headless = rune::is_headless();
    if !headless && !desktop::single_instance::acquire() {
        return;
    }
    rune::prewarm_gpu();
    let (w, h) = desktop::window::NORMAL_MIN_SIZE;
    // `electron/windows.ts`: frameless and transparent, its corners drawn by
    // the app; the window comes on screen with its first frame (Rune cloaks
    // it until then on Windows), so nothing flashes white.
    let options = rune::WindowOptions {
        transparent: true,
        borderless: true,
        min_size: Some((w as f32, h as f32)),
        always_on_top: !headless && config::Config::load().always_on_top,
        ..Default::default()
    };
    // Text keeps Rune's default smoothing: DirectWrite on Windows, rasterised
    // as Chromium's Skia does there, so it matches the Electron client; off on
    // Linux, which the reference shots are taken with. `LUMEN_FONT_SMOOTHING`
    // (`off`, `on`, `directwrite`) overrides it: `tools/wine-snap.sh` sets
    // `off`, as Wine's DirectWrite ignores variable fonts' weight axis.
    let app = rune::App::new(app::spec()).window_options(options);
    let app = match std::env::var("LUMEN_FONT_SMOOTHING").as_deref() {
        Ok("off") => app.font_smoothing(rune::FontSmoothing::Off),
        Ok("on") => app.font_smoothing(rune::FontSmoothing::On),
        Ok("directwrite") => app.font_smoothing(rune::FontSmoothing::DirectWrite),
        _ => app,
    };
    let handle = app.handle();
    app.on_window(desktop::window::on_window)
        .on_ready(move |_| {
            let started = handle.clone();
            handle.update(move |app, _| desktop::start(app, started));
        })
        .on_close(desktop::on_close)
        .run();
    // `autoInstallOnAppQuit`: a downloaded update installs once the app is gone.
    desktop::updater::install_on_quit();
}
