//! The URL-building parts of the web's `lib/downloads.ts` (the desktop
//! app's own release downloads, for the landing/about links) and
//! `lib/download.ts` (a track's tagged file; see `audio_format` for names).

use crate::api::{Client, media};

/// The latest release on GitHub, for "Download Lumen" links.
pub const RELEASES_PAGE: &str = "https://github.com/githubesson/lumen/releases/latest";
/// The public latest-release API.
pub const RELEASES_LATEST_API: &str = "https://api.github.com/repos/githubesson/lumen/releases/latest";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DesktopPlatform {
    Windows,
    Mac,
    Linux,
    Other,
}

/// The platform this build runs on.
pub fn current_platform() -> DesktopPlatform {
    if cfg!(windows) {
        DesktopPlatform::Windows
    } else if cfg!(target_os = "macos") {
        DesktopPlatform::Mac
    } else if cfg!(target_os = "linux") {
        DesktopPlatform::Linux
    } else {
        DesktopPlatform::Other
    }
}

/// The asset a platform downloads, from a release's asset names and URLs:
/// the setup .exe, the .dmg, or the AppImage; the releases page otherwise.
pub fn desktop_download_url(platform: DesktopPlatform, assets: &[(String, String)]) -> String {
    let suffix = match platform {
        DesktopPlatform::Windows => "-setup.exe",
        DesktopPlatform::Mac => ".dmg",
        DesktopPlatform::Linux => ".AppImage",
        DesktopPlatform::Other => return RELEASES_PAGE.into(),
    };
    assets.iter().find(|(name, _)| name.ends_with(suffix)).map_or_else(|| RELEASES_PAGE.into(), |(_, url)| url.clone())
}

/// The absolute URL of a track's tagged file (`downloadStreamUrl`).
pub fn track_download_url(c: &Client, track_id: &str) -> String {
    c.url(&media::download_stream_path(track_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_platforms_asset() {
        let assets = vec![
            ("Lumen-1.0-setup.exe".to_string(), "https://x/setup.exe".to_string()),
            ("Lumen-1.0.dmg".to_string(), "https://x/l.dmg".to_string()),
        ];
        assert_eq!(desktop_download_url(DesktopPlatform::Windows, &assets), "https://x/setup.exe");
        assert_eq!(desktop_download_url(DesktopPlatform::Mac, &assets), "https://x/l.dmg");
        assert_eq!(desktop_download_url(DesktopPlatform::Linux, &assets), RELEASES_PAGE);
        assert_eq!(desktop_download_url(DesktopPlatform::Other, &assets), RELEASES_PAGE);
        let c = Client::new("https://music.example", None);
        assert_eq!(track_download_url(&c, "tidal:1"), "https://music.example/api/tracks/tidal%3A1/stream?download=1");
    }
}
