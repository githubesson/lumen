//! Headless scenes that open each overlay over the library, matching the
//! overlay scenes in `tools/reference/scenes.ref.ts`.

use crate::app::{App, scene};
use crate::overlays::settings::SectionId;
use crate::overlays::settings::desktop_bridge::UpdateStatus;

/// The library row the reference right-clicks (`t-al-weather-4`).
pub const MENU_TRACK: &str = "t-al-weather-4";
/// The track linked with a studio WAV (`linkedTrackId`).
pub const LINKED_TRACK: &str = "t-al-weather-2";

fn library(app: &mut App) {
    scene(app, "/library");
    // The first `/me` may still be on a worker (it starts before scenes run
    // requests inline); overlays read the signed-in user as they open.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while app.me().is_none() && std::time::Instant::now() < deadline {
        crate::net::Net::drain(app);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    app.settle_sync();
}

/// Type `text` into the palette as keystrokes would.
fn palette_query(app: &mut App, text: &str) {
    crate::overlays::palette::open(app);
    app.overlays.palette.query.replace_text(text);
    crate::overlays::palette::changed(app);
    app.settle_sync();
}

fn settings(app: &mut App, section: SectionId) {
    library(app);
    app.overlays.settings.active = section;
    crate::overlays::settings::open(app);
    app.settle_sync();
}

/// The desktop config the reference's desktop-settings scenes serve.
fn desktop_config(app: &mut App) {
    app.config.backend_url = Some("https://music.example.com".into());
    app.config.discord_enabled = true;
    app.config.always_on_top = false;
    app.config.discord_card = None;
    app.config.now_playing_api_enabled = true;
    app.config.now_playing_api_port = Some(48638);
    app.config.now_playing_api_token = Some("first-token-0123456789".into());
}

/// An updater that found a new version (`updateAvailable` in the reference).
pub fn update_available() -> UpdateStatus {
    UpdateStatus {
        state: "available".into(),
        branch: "main".into(),
        repo_url: "https://github.com/esson/lumen".into(),
        default_repo_url: "https://github.com/esson/lumen".into(),
        current_version: "0.1.29".into(),
        target_version: Some("0.1.30".into()),
        progress: None,
        message: "Lumen 0.1.30 is available.".into(),
        can_check: true,
        can_install: false,
    }
}

pub const SCENES: &[(&str, fn(&mut App))] = &[
    ("palette", |a| {
        library(a);
        crate::overlays::palette::open(a);
    }),
    ("palette-filter", |a| {
        library(a);
        palette_query(a, "p");
    }),
    ("palette-search", |a| {
        library(a);
        palette_query(a, "weather");
    }),
    ("settings", |a| settings(a, SectionId::Appearance)),
    ("settings-playback", |a| settings(a, SectionId::Playback)),
    ("settings-connections", |a| settings(a, SectionId::Connections)),
    ("settings-search", |a| {
        // The reference bridge's server is the page's own origin.
        a.config.backend_url = Some("http://localhost:4792".into());
        settings(a, SectionId::Appearance);
        a.overlays.settings.query.replace_text("de");
        a.overlays.settings.query.focused = true;
    }),
    ("settings-desktop", |a| {
        desktop_config(a);
        settings(a, SectionId::Desktop);
    }),
    ("settings-discord", |a| {
        desktop_config(a);
        settings(a, SectionId::Discord);
    }),
    ("settings-discord-side", |a| {
        desktop_config(a);
        settings(a, SectionId::Discord);
        a.overlays.settings.side_shown = true;
    }),
    ("settings-updates", |a| {
        a.overlays.settings.updater = Some(update_available());
        settings(a, SectionId::Updates);
    }),
    ("upload", |a| {
        library(a);
        crate::overlays::upload::open(a);
    }),
    ("confirm", |a| {
        library(a);
        let Some(t) = track(a, MENU_TRACK) else { return };
        crate::overlays::confirm::ask_action(
            a,
            remove_spec(&t),
            |_| Ok(()),
            |_| {},
        );
    }),
    ("toast", |a| {
        library(a);
        a.overlays.settings.updater = Some(update_available());
        crate::overlays::toast::on_status(a);
    }),
];

/// A library row by id, as the track list shows it.
pub fn track(app: &mut App, id: &str) -> Option<crate::api::TrackListItem> {
    let client = app.client.clone()?;
    let (list, _) = client.page::<crate::api::TrackListItem>("/api/tracks?limit=200").ok()?;
    list.into_iter().find(|t| t.id == id)
}

/// The track menu's "Remove from library" question (`TrackContextMenu.tsx`).
pub fn remove_spec(t: &crate::api::TrackListItem) -> crate::overlays::confirm::ConfirmSpec {
    use crate::overlays::confirm::{Art, ConfirmSpec};
    let artist = crate::format::display_text(t.artist.as_deref(), "Unknown artist");
    let detail = match t.album_title.as_deref().filter(|a| !a.is_empty()) {
        Some(al) => format!("{artist} · {al}"),
        None => artist,
    };
    let label = t.album_title.clone().filter(|a| !a.is_empty()).unwrap_or_else(|| t.title.clone());
    ConfirmSpec::new(
        "Remove for everyone?",
        "This permanently deletes the file from the server, so it leaves every library.",
        "Remove",
    )
    .subject(
        Art::Cover {
            url: Some(crate::api::media::track_cover(&t.id, t.album_id.as_deref(), t.cover_url.as_deref(), Some(64))),
            label,
        },
        t.title.clone(),
        Some(detail),
    )
    .icon(&crate::ui::icons::TRASH_2)
    .busy_label("Removing…")
    .error_fallback("Delete failed.")
}
