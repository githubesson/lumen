//! Lumen's desktop client, drawn with Rune: a pixel-for-pixel port of the
//! Electron frontend (`frontend/`).
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
// The port lands area by area; parts of the API layer wait for their pages.
#![allow(dead_code)]

mod api;
mod app;
mod config;
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
    rune::prewarm_gpu();
    let options = rune::WindowOptions {
        transparent: true,
        borderless: true,
        min_size: Some((640.0, 480.0)),
        ..Default::default()
    };
    rune::App::new(app::spec()).window_options(options).run();
}
