//! Lumen's desktop client, drawn with Rune: a pixel-for-pixel port of the
//! Electron frontend (`frontend/`).
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
// The port lands area by area; parts of the API layer wait for their pages.
#![allow(dead_code)]

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
    // Chromium's Windows text is heavier than Rune's default unsmoothed
    // rasterization. Keep the Linux reference renderer unchanged, and use
    // Rune's outline-dilation pass on Windows to match the desktop client.
    let smoothing = if cfg!(target_os = "windows") {
        rune::FontSmoothing::On
    } else {
        rune::FontSmoothing::Off
    };
    let app = rune::App::new(app::spec()).font_smoothing(smoothing).window_options(options);
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
