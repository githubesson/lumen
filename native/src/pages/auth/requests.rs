//! The requests the signed-out screens and the share page make
//! (`core/src/api.ts`'s `api.login`, `register`, `checkInvite`,
//! `resetPassword`, `logout`, `getPublicTrackShare`), and the messages
//! `core/src/auth/errors.ts` turns their failures into.
//!
//! TODO(api-merge): thin calls on [`Client`] until `crate::api::auth` lands;
//! switch the call sites over and delete this module then.

use serde::Deserialize;
use serde_json::json;

use crate::api::{ApiError, ApiResult, Client, Me, query, seg};

/// `InviteCheck`: the public invite lookup's answer.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct InviteCheck {
    pub valid: bool,
    /// `user` or `admin`, as the server spells it.
    #[serde(default)]
    pub target_role: Option<String>,
}

/// `PublicTrackShare`: what a signed share link shows.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct PublicTrackShare {
    pub track_id: String,
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub album_id: Option<String>,
    #[serde(default)]
    pub start_sec: f64,
    #[serde(default)]
    pub duration_ms: f64,
    #[serde(default)]
    pub preview_duration_sec: Option<f64>,
    pub preview_url: String,
    /// The preview's audio alone, as M4A. Missing from older backends.
    #[serde(default)]
    pub audio_url: Option<String>,
    #[serde(default)]
    pub cover_url: Option<String>,
    pub canonical_url: String,
    pub open_url: String,
}

/// `TrackShareRef`: the parts of a signed share URL.
#[derive(Clone, Debug, PartialEq)]
pub struct TrackShareRef {
    pub track_id: String,
    pub sig: String,
    pub start_sec: u64,
    /// Absent on links minted before snippets had a selectable length.
    pub duration_sec: Option<u64>,
}

pub const MAX_SHARE_SNIPPET_DURATION_SEC: u64 = 120;

/// `parseTrackShareParams`: the route's id and its `t`, `d` and `sig`, or
/// None when the link is malformed.
pub fn parse_track_share_params(
    track_id: &str,
    t: Option<&str>,
    d: Option<&str>,
    sig: Option<&str>,
) -> Option<TrackShareRef> {
    let sig = sig.unwrap_or("");
    if track_id.is_empty() || sig.is_empty() {
        return None;
    }
    // `Number.parseInt(t ?? "0", 10)`: leading digits count, a sign is allowed.
    let start = parse_int_prefix(t.unwrap_or("0"))?;
    if start < 0 {
        return None;
    }
    let duration_sec = match d {
        None => None,
        Some(raw) => {
            // `Number(d)`: the whole string must be a number (blank is 0).
            let v: f64 = if raw.trim().is_empty() {
                0.0
            } else {
                raw.trim().parse().ok()?
            };
            if v.fract() != 0.0 || v <= 0.0 || v > MAX_SHARE_SNIPPET_DURATION_SEC as f64 {
                return None;
            }
            Some(v as u64)
        }
    };
    Some(TrackShareRef {
        track_id: track_id.to_string(),
        sig: sig.to_string(),
        start_sec: start as u64,
        duration_sec,
    })
}

fn parse_int_prefix(s: &str) -> Option<i64> {
    let s = s.trim_start();
    let (neg, rest) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let v: i64 = digits.parse().ok()?;
    Some(if neg { -v } else { v })
}

pub fn login(client: &Client, username: &str, password: &str) -> ApiResult<Me> {
    client.post(
        "/api/auth/login",
        json!({ "username": username, "password": password }),
    )
}

pub fn logout(client: &Client) -> ApiResult<()> {
    client.post_void("/api/auth/logout", None)
}

pub fn me(client: &Client) -> ApiResult<Me> {
    client.get("/api/auth/me")
}

pub fn register(client: &Client, token: &str, username: &str, password: &str) -> ApiResult<Me> {
    client.post(
        "/api/auth/register",
        json!({ "token": token, "username": username, "password": password }),
    )
}

pub fn check_invite(client: &Client, token: &str) -> ApiResult<InviteCheck> {
    client.get(&format!("/api/auth/invite?token={}", seg(token)))
}

pub fn reset_password(
    client: &Client,
    current_password: &str,
    new_password: &str,
) -> ApiResult<()> {
    client.post_void(
        "/api/auth/reset-password",
        Some(json!({ "current_password": current_password, "new_password": new_password })),
    )
}

/// `getPublicTrackShare`.
pub fn public_track_share(client: &Client, share: &TrackShareRef) -> ApiResult<PublicTrackShare> {
    let d = share
        .duration_sec
        .map(|d| d.clamp(1, MAX_SHARE_SNIPPET_DURATION_SEC).to_string());
    let q = query(&[
        ("t", Some(share.start_sec.to_string())),
        ("sig", Some(share.sig.clone())),
        ("d", d),
    ]);
    client.get(&format!(
        "/api/public/share/track/{}{q}",
        seg(&share.track_id)
    ))
}

/// `trackSharePreviewVideoUrl`: the snippet's generated MP4 (cover + audio).
pub fn preview_video_url(client: &Client, share: &TrackShareRef) -> String {
    let d = share.duration_sec.map(|d| d.to_string());
    let q = query(&[
        ("t", Some(share.start_sec.to_string())),
        ("d", d),
        ("sig", Some(share.sig.clone())),
    ]);
    client.url(&format!(
        "/api/public/preview-videos/{}.mp4{q}",
        seg(&share.track_id)
    ))
}

/// A request that never got an HTTP response: the network failed or the
/// deadline passed (anything that isn't an `ApiError` in the web client).
fn unanswered(e: &ApiError) -> bool {
    e.status == 0
}

const UNREACHABLE: &str = "Couldn't reach the server. Check your connection and try again.";

/// `loginErrorMessage`.
pub fn login_error_message(e: &ApiError) -> String {
    if unanswered(e) {
        return UNREACHABLE.into();
    }
    match e.status {
        401 => "Invalid username or password.",
        // The server only says so after a correct password.
        403 => "This account has been disabled.",
        429 => "Too many sign-in attempts. Try again later.",
        _ => "Sign in failed. Please try again.",
    }
    .into()
}

/// `registrationErrorMessage`.
pub fn registration_error_message(e: &ApiError) -> String {
    if unanswered(e) {
        return "Couldn't create your account. Check your connection and try again.".into();
    }
    match e.status {
        409 => "That username is already taken.".into(),
        429 => "Too many registration attempts. Try again later.".into(),
        // "invalid invite" or "invite is no longer usable", both 400s.
        _ if e.message.contains("invite") => {
            "This invite is no longer usable. Ask an admin for a new one.".into()
        }
        _ if !e.message.is_empty() => e.message.clone(),
        s => format!("Registration failed ({s})."),
    }
}

/// `inviteCheckErrorMessage`: the check answers `valid: false` for a dead
/// invite, so a failure says nothing about the invite itself.
pub fn invite_check_error_message(e: &ApiError) -> String {
    if e.status == 429 {
        "Too many invite checks. Wait a minute and try again."
    } else if unanswered(e) {
        "Couldn't verify this invite. Check your connection and try again."
    } else {
        "Couldn't verify this invite. Try again."
    }
    .into()
}

/// `passwordChangeErrorMessage`.
pub fn password_change_error_message(e: &ApiError) -> String {
    if unanswered(e) {
        return UNREACHABLE.into();
    }
    match e.status {
        401 => "Your current password is incorrect.".into(),
        429 => "Too many attempts. Try again later.".into(),
        _ if !e.message.is_empty() => e.message.clone(),
        _ => "Couldn't change your password.".into(),
    }
}

/// `errorMessage(err, fallback)`: the server's message, else `fallback`.
pub fn error_message(e: &ApiError, fallback: &str) -> String {
    if !unanswered(e) && !e.message.is_empty() {
        e.message.clone()
    } else {
        fallback.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(status: u16, message: &str) -> ApiError {
        ApiError {
            status,
            message: message.into(),
        }
    }

    #[test]
    fn messages_follow_errors_ts() {
        assert_eq!(
            login_error_message(&err(401, "invalid credentials")),
            "Invalid username or password."
        );
        assert_eq!(
            login_error_message(&err(0, "Couldn't reach the server.")),
            UNREACHABLE
        );
        assert_eq!(
            login_error_message(&err(500, "boom")),
            "Sign in failed. Please try again."
        );
        assert_eq!(
            registration_error_message(&err(400, "invalid invite")),
            "This invite is no longer usable. Ask an admin for a new one."
        );
        assert_eq!(
            registration_error_message(&err(400, "")),
            "Registration failed (400)."
        );
        assert_eq!(
            invite_check_error_message(&err(500, "x")),
            "Couldn't verify this invite. Try again."
        );
        assert_eq!(
            password_change_error_message(&err(401, "invalid credentials")),
            "Your current password is incorrect."
        );
    }

    #[test]
    fn share_params_parse_like_core() {
        let r = parse_track_share_params("t-1", Some("45"), Some("30"), Some("sig")).unwrap();
        assert_eq!((r.start_sec, r.duration_sec), (45, Some(30)));
        assert_eq!(
            parse_track_share_params("t-1", None, None, Some("s"))
                .unwrap()
                .start_sec,
            0
        );
        assert!(parse_track_share_params("t-1", Some("x"), None, Some("s")).is_none());
        assert!(parse_track_share_params("t-1", Some("5"), Some("121"), Some("s")).is_none());
        assert!(parse_track_share_params("t-1", Some("5"), Some("2.5"), Some("s")).is_none());
        assert!(parse_track_share_params("t-1", Some("5"), None, None).is_none());
        assert_eq!(
            parse_track_share_params("t-1", Some("12abc"), None, Some("s"))
                .unwrap()
                .start_sec,
            12
        );
    }
}
