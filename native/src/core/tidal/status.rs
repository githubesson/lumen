//! `core/src/tidal/status.ts`: what the TIDAL admin screen shows about the
//! hifi-api proxy, its linked accounts and auto-download.

use crate::api::tidal::{TidalAccount, TidalAutoDownloadStatus, TidalStatus};

/// What the proxy reports, with the defaults it falls back to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TidalStatusDetails {
    pub proxy: String,
    pub country: String,
    pub quality: String,
    pub version: String,
}

fn or(v: Option<&String>, fallback: &str) -> String {
    v.filter(|s| !s.is_empty()).cloned().unwrap_or_else(|| fallback.to_string())
}

pub fn tidal_status_details(status: Option<&TidalStatus>) -> TidalStatusDetails {
    TidalStatusDetails {
        proxy: or(status.and_then(|s| s.proxy_url.as_ref()), "not configured"),
        country: or(status.and_then(|s| s.country_code.as_ref()), "US"),
        quality: or(status.and_then(|s| s.quality.as_ref()), "LOSSLESS"),
        version: or(status.and_then(|s| s.version.as_ref()), "unknown"),
    }
}

/// Every error to show, each once: the screen's own, then the proxy's and
/// its account controls'.
pub fn tidal_status_errors(screen_error: Option<&str>, status: Option<&TidalStatus>) -> Vec<String> {
    let candidates = [
        screen_error,
        status.and_then(|s| s.error.as_deref()),
        status.and_then(|s| s.management_error.as_deref()),
    ];
    let mut out: Vec<String> = Vec::new();
    for e in candidates.into_iter().flatten() {
        if !e.is_empty() && !out.iter().any(|o| o == e) {
            out.push(e.to_string());
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TidalProxyState {
    Checking,
    Online,
    Offline,
}

/// The proxy badge: checking while the status loads, then whether it answered.
pub fn tidal_proxy_state(status: Option<&TidalStatus>, loading: bool) -> TidalProxyState {
    if loading {
        TidalProxyState::Checking
    } else if status.is_some_and(|s| s.connected) {
        TidalProxyState::Online
    } else {
        TidalProxyState::Offline
    }
}

/// Explain that account controls need the Lumen hifi-api extension: only
/// for a loaded status that says so.
pub fn tidal_management_unsupported(status: Option<&TidalStatus>) -> bool {
    status.is_some_and(|s| !s.management_supported)
}

/// Whether "Link account" is available: an online proxy with account
/// controls, and no sign-in or unlink under way.
pub fn can_link_tidal_account(status: Option<&TidalStatus>, starting: bool, unlinking: bool, has_flow: bool) -> bool {
    status.is_some_and(|s| s.connected && s.management_supported) && !starting && !unlinking && !has_flow
}

/// "Account 12345".
pub fn tidal_account_label(account: &TidalAccount) -> String {
    format!("Account {}", if account.user_id.is_empty() { "unknown" } else { &account.user_id })
}

/// Where a linked account comes from: Lumen can unlink only its own.
pub fn tidal_account_source(account: &TidalAccount) -> &'static str {
    if account.removable { "Managed by Lumen" } else { "Configured by environment" }
}

/// Why auto-download can't save files right now, if it can't.
pub fn tidal_auto_download_problems(status: Option<&TidalAutoDownloadStatus>) -> Vec<String> {
    let Some(s) = status else { return Vec::new() };
    let mut out = Vec::new();
    if !s.ffmpeg {
        out.push("ffmpeg is not installed on the server, so downloads are paused.".to_string());
    }
    if let Some(e) = s.destination_error.as_deref().filter(|e| !e.is_empty()) {
        out.push(format!("Download folder unavailable: {e}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(f: impl FnOnce(&mut TidalStatus)) -> TidalStatus {
        let mut s = TidalStatus { connected: true, management_supported: true, ..Default::default() };
        f(&mut s);
        s
    }

    fn auto(f: impl FnOnce(&mut TidalAutoDownloadStatus)) -> TidalAutoDownloadStatus {
        let mut s = TidalAutoDownloadStatus { subdir: "TIDAL".into(), ffmpeg: true, ..Default::default() };
        f(&mut s);
        s
    }

    #[test]
    fn details_fill_in_defaults() {
        let d = |p: &str, c: &str, q: &str, v: &str| TidalStatusDetails {
            proxy: p.into(),
            country: c.into(),
            quality: q.into(),
            version: v.into(),
        };
        assert_eq!(tidal_status_details(None), d("not configured", "US", "LOSSLESS", "unknown"));
        let s = status(|s| {
            s.proxy_url = Some("http://hifi:8000".into());
            s.country_code = Some("GB".into());
            s.quality = Some("HI_RES_LOSSLESS".into());
            s.version = Some("2.4".into());
        });
        assert_eq!(tidal_status_details(Some(&s)), d("http://hifi:8000", "GB", "HI_RES_LOSSLESS", "2.4"));
    }

    #[test]
    fn errors_once_each() {
        assert!(tidal_status_errors(None, None).is_empty());
        let s = status(|s| {
            s.error = Some("proxy unreachable".into());
            s.management_error = Some("extension missing".into());
        });
        assert_eq!(
            tidal_status_errors(Some("Could not unlink the TIDAL account."), Some(&s)),
            ["Could not unlink the TIDAL account.", "proxy unreachable", "extension missing"]
        );
        let s = status(|s| {
            s.error = Some("proxy unreachable".into());
            s.management_error = Some(String::new());
        });
        assert_eq!(tidal_status_errors(Some("proxy unreachable"), Some(&s)), ["proxy unreachable"]);
    }

    #[test]
    fn auto_download_problems() {
        assert!(tidal_auto_download_problems(None).is_empty());
        assert!(tidal_auto_download_problems(Some(&auto(|_| {}))).is_empty());
        let both = auto(|s| {
            s.ffmpeg = false;
            s.destination_error = Some("permission denied".into());
        });
        assert_eq!(
            tidal_auto_download_problems(Some(&both)),
            [
                "ffmpeg is not installed on the server, so downloads are paused.",
                "Download folder unavailable: permission denied"
            ]
        );
        let one = auto(|s| s.destination_error = Some("missing".into()));
        assert_eq!(tidal_auto_download_problems(Some(&one)), ["Download folder unavailable: missing"]);
    }

    #[test]
    fn admin_display() {
        let ok = status(|_| {});
        assert_eq!(tidal_proxy_state(None, true), TidalProxyState::Checking);
        assert_eq!(tidal_proxy_state(Some(&ok), true), TidalProxyState::Checking);
        assert_eq!(tidal_proxy_state(Some(&ok), false), TidalProxyState::Online);
        assert_eq!(tidal_proxy_state(Some(&status(|s| s.connected = false)), false), TidalProxyState::Offline);
        assert_eq!(tidal_proxy_state(None, false), TidalProxyState::Offline);
        assert!(tidal_management_unsupported(Some(&status(|s| s.management_supported = false))));
        assert!(!tidal_management_unsupported(Some(&ok)));
        assert!(!tidal_management_unsupported(None));
        assert!(can_link_tidal_account(Some(&ok), false, false, false));
        assert!(!can_link_tidal_account(None, false, false, false));
        assert!(!can_link_tidal_account(Some(&status(|s| s.connected = false)), false, false, false));
        assert!(!can_link_tidal_account(Some(&status(|s| s.management_supported = false)), false, false, false));
        assert!(!can_link_tidal_account(Some(&ok), true, false, false));
        assert!(!can_link_tidal_account(Some(&ok), false, true, false));
        assert!(!can_link_tidal_account(Some(&ok), false, false, true));
        let acc = |user: &str, removable| TidalAccount { id: "a".into(), user_id: user.into(), removable };
        assert_eq!(tidal_account_label(&acc("42", true)), "Account 42");
        assert_eq!(tidal_account_label(&acc("", true)), "Account unknown");
        assert_eq!(tidal_account_source(&acc("1", true)), "Managed by Lumen");
        assert_eq!(tidal_account_source(&acc("1", false)), "Configured by environment");
    }
}
