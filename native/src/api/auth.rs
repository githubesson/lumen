//! Sign-in and registration: the auth routes of `core/src/api.ts` and the
//! types of `api-auth-types.ts`.
//!
//! `login`, `logout` and `me` never sign the user out on a 401 (the caller
//! decides); `reset_password` only does when the session itself is gone,
//! since a wrong current password is a 401 too.

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::client::{ApiResult, Behavior, Body, Client, Notify, query};
use super::types::{Me, Role};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct Invite {
    pub id: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub target_role: Role,
    #[serde(default)]
    pub max_uses: u64,
    #[serde(default)]
    pub uses: u64,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub revoked_at: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct AdminUser {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub role: Role,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub must_reset_password: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub last_login_at: Option<String>,
}

/// The public invite check (`GET /api/auth/invite`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct InviteCheck {
    #[serde(default)]
    pub valid: bool,
    #[serde(default)]
    pub target_role: Option<Role>,
}

/// `api.login`. Call [`Client::advance_auth_generation`] once it lands.
pub fn login(c: &Client, username: &str, password: &str) -> ApiResult<Me> {
    let body = Body::Json(json!({ "username": username, "password": password }));
    c.request("POST", "/api/auth/login", body, &[], &Behavior::no_sign_out())?.json()
}

/// `api.logout`.
pub fn logout(c: &Client) -> ApiResult<()> {
    c.request("POST", "/api/auth/logout", Body::None, &[], &Behavior::no_sign_out()).map(|_| ())
}

/// `api.me`: the session's user. A 401 here means signed out, which the
/// caller handles (it may be an older request than the current session).
pub fn me(c: &Client) -> ApiResult<Me> {
    c.get_with("/api/auth/me", &Behavior::no_sign_out())
}

/// `api.register` with an invite token.
pub fn register(c: &Client, token: &str, username: &str, password: &str) -> ApiResult<Me> {
    c.post("/api/auth/register", json!({ "token": token, "username": username, "password": password }))
}

/// `api.checkInvite`.
pub fn check_invite(c: &Client, token: &str) -> ApiResult<InviteCheck> {
    c.get(&format!("/api/auth/invite{}", query(&[("token", Some(token.to_string()))])))
}

fn session_gone(body: &str) -> bool {
    body != "invalid credentials"
}

/// `api.resetPassword`.
pub fn reset_password(c: &Client, current_password: &str, new_password: &str) -> ApiResult<()> {
    let body = Body::Json(json!({ "current_password": current_password, "new_password": new_password }));
    let behavior = Behavior { notify: Notify::When(session_gone), ..Default::default() };
    c.request("POST", "/api/auth/reset-password", body, &[], &behavior).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wrong_password_keeps_the_session() {
        assert!(!session_gone("invalid credentials"));
        assert!(session_gone("unauthorized"));
        assert!(session_gone(""));
    }

    #[test]
    fn invites_decode_from_older_servers() {
        let inv: Invite = serde_json::from_str(
            r#"{"id":"i1","target_role":"admin","max_uses":5,"uses":1,"expires_at":null,"created_at":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(inv.target_role, Role::Admin);
        assert_eq!(inv.expires_at, None);
        assert_eq!(inv.token, None);
    }
}
