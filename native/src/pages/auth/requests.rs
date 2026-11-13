//! The requests the signed-out screens make (`core/src/api.ts`'s
//! `api.login`, `register`, `checkInvite`, `resetPassword`, `logout`), and
//! the messages `core/src/auth/errors.ts` turns their failures into. The
//! share page's are `crate::api::share`'s.
//!
//! The session calls are `crate::api::auth`'s plus the auth generation's
//! advance a sign-in makes; the messages are `crate::core::auth::errors`'.

use crate::api::{ApiResult, Client, Me};

pub use crate::api::auth::InviteCheck;

// The session calls go through the API layer, whose `me` and `logout` never
// fire the app-wide 401 sign-out and whose login moves the auth generation.
pub fn login(client: &Client, username: &str, password: &str) -> ApiResult<Me> {
    let me = crate::api::auth::login(client, username, password)?;
    client.advance_auth_generation();
    Ok(me)
}

pub fn logout(client: &Client) -> ApiResult<()> {
    crate::api::auth::logout(client)
}

pub fn me(client: &Client) -> ApiResult<Me> {
    crate::api::auth::me(client)
}

pub fn register(client: &Client, token: &str, username: &str, password: &str) -> ApiResult<Me> {
    let me = crate::api::auth::register(client, token, username, password)?;
    client.advance_auth_generation();
    Ok(me)
}

pub fn check_invite(client: &Client, token: &str) -> ApiResult<InviteCheck> {
    crate::api::auth::check_invite(client, token)
}

pub fn reset_password(
    client: &Client,
    current_password: &str,
    new_password: &str,
) -> ApiResult<()> {
    crate::api::auth::reset_password(client, current_password, new_password)
}

pub use crate::core::auth::errors::{
    invite_check_error_message, login_error_message, password_change_error_message, registration_error_message,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::ApiError;

    fn err(status: u16, message: &str) -> ApiError {
        if status == 0 {
            ApiError { status, message: message.into(), kind: crate::api::client::ErrorKind::Network, retry_after_seconds: None }
        } else {
            ApiError::http(status, message)
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
            "Couldn't reach the server. Check your connection and try again."
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
}
