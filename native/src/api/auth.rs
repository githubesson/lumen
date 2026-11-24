//! Sign-in and registration: the auth routes of `core/src/api.ts` and the
//! types of `api-auth-types.ts`.
//!
//! `login`, `logout` and `me` never sign the user out on a 401 (the caller
//! decides); `reset_password` only does when the session itself is gone,
//! since a wrong current password is a 401 too.

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::client::{ApiResult, Behavior, Body, Client, Notify, query, seg};
use super::de::string_or_number;
use super::types::{Me, Role};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct Invite {
    #[serde(default, deserialize_with = "string_or_number")]
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
    #[serde(default, deserialize_with = "string_or_number")]
    pub id: String,
    #[serde(default)]
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

/// A key scripts send as `Authorization: Bearer <key>` to call the API as
/// its owner (`ApiKey`). The key itself only comes back once, from
/// [`create_api_key`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ApiKey {
    #[serde(default, deserialize_with = "string_or_number")]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// The key's first characters, to tell keys apart.
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub last_used_at: Option<String>,
    /// None: lasts until it's revoked.
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// A key just made (`CreatedApiKey`), the only time the key itself is sent.
#[derive(Clone, Debug, PartialEq, Deserialize, Default)]
pub struct CreatedApiKey {
    #[serde(flatten)]
    pub listed: ApiKey,
    #[serde(default)]
    pub key: String,
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

// The server refuses these to API keys; only a signed-in app manages them.

/// `api.listApiKeys`: the user's keys, newest first.
pub fn list_api_keys(c: &Client) -> ApiResult<Vec<ApiKey>> {
    c.get_list("/api/auth/api-keys")
}

/// `api.createApiKey`. `expires_in_days` 0: the key lasts until it's revoked.
pub fn create_api_key(c: &Client, name: &str, expires_in_days: u32) -> ApiResult<CreatedApiKey> {
    c.post("/api/auth/api-keys", json!({ "name": name, "expires_in_days": expires_in_days }))
}

/// `api.deleteApiKey`.
pub fn delete_api_key(c: &Client, id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/auth/api-keys/{}", seg(id)))
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
    fn a_created_key_carries_the_key_beside_the_listed_fields() {
        let made: CreatedApiKey = serde_json::from_str(
            r#"{"id":"k1","name":"Stats","prefix":"lumen_AbCdEf","created_at":"2026-11-24T10:00:00Z","last_used_at":null,"expires_at":null,"key":"lumen_AbCdEfRest"}"#,
        )
        .unwrap();
        assert_eq!(made.key, "lumen_AbCdEfRest");
        assert_eq!(made.listed.prefix, "lumen_AbCdEf");
        assert_eq!(made.listed.expires_at, None);
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
