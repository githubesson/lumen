//! `core/src/auth/errors.ts`: what sign-in, registration, the invite check
//! and a password change say when they fail. A failure that isn't an API
//! error never got an answer: the network, or the client's deadline.

use crate::api::ApiError;

const UNREACHABLE: &str = "Couldn't reach the server. Check your connection and try again.";

pub fn login_error_message(err: &ApiError) -> String {
    if !err.is_api_error() {
        return UNREACHABLE.into();
    }
    match err.status {
        401 => "Invalid username or password.",
        // The server only says so after a correct password.
        403 => "This account has been disabled.",
        429 => "Too many sign-in attempts. Try again later.",
        _ => "Sign in failed. Please try again.",
    }
    .into()
}

pub fn registration_error_message(err: &ApiError) -> String {
    if !err.is_api_error() {
        return "Couldn't create your account. Check your connection and try again.".into();
    }
    match err.status {
        409 => "That username is already taken.".into(),
        429 => "Too many registration attempts. Try again later.".into(),
        // "invalid invite" or "invite is no longer usable", both 400s.
        _ if err.message.contains("invite") => "This invite is no longer usable. Ask an admin for a new one.".into(),
        _ if !err.message.is_empty() => err.message.clone(),
        s => format!("Registration failed ({s})."),
    }
}

/// For the public invite check, which answers `valid: false` for a dead invite.
pub fn invite_check_error_message(err: &ApiError) -> String {
    if err.has_status(429) {
        "Too many invite checks. Wait a minute and try again.".into()
    } else if err.is_api_error() {
        "Couldn't verify this invite. Try again.".into()
    } else {
        "Couldn't verify this invite. Check your connection and try again.".into()
    }
}

pub fn password_change_error_message(err: &ApiError) -> String {
    if !err.is_api_error() {
        return UNREACHABLE.into();
    }
    match err.status {
        401 => "Your current password is incorrect.".into(),
        429 => "Too many attempts. Try again later.".into(),
        _ if !err.message.is_empty() => err.message.clone(),
        _ => "Couldn't change your password.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::ErrorKind;

    fn e(status: u16, msg: &str) -> ApiError {
        ApiError::http(status, msg)
    }

    fn offline() -> ApiError {
        ApiError::transport("Network request failed")
    }

    fn timed_out() -> ApiError {
        ApiError { status: 0, message: "The operation was aborted.".into(), kind: ErrorKind::Timeout }
    }

    #[test]
    fn login() {
        assert_eq!(login_error_message(&e(401, "invalid credentials")), "Invalid username or password.");
        assert_eq!(login_error_message(&e(403, "account disabled")), "This account has been disabled.");
        assert_eq!(login_error_message(&e(429, "too many failed attempts; try again later")), "Too many sign-in attempts. Try again later.");
        assert_eq!(login_error_message(&e(429, "rate limit exceeded")), "Too many sign-in attempts. Try again later.");
        assert_eq!(login_error_message(&e(503, "service unavailable")), "Sign in failed. Please try again.");
        assert_eq!(login_error_message(&e(502, "<html><body>Bad Gateway</body></html>")), "Sign in failed. Please try again.");
        assert_eq!(login_error_message(&offline()), UNREACHABLE);
        assert_eq!(login_error_message(&timed_out()), UNREACHABLE);
    }

    #[test]
    fn registration() {
        assert_eq!(registration_error_message(&e(409, "username taken")), "That username is already taken.");
        assert_eq!(registration_error_message(&e(429, "rate limit exceeded")), "Too many registration attempts. Try again later.");
        let dead = "This invite is no longer usable. Ask an admin for a new one.";
        assert_eq!(registration_error_message(&e(400, "invalid invite")), dead);
        assert_eq!(registration_error_message(&e(400, "invite is no longer usable")), dead);
        assert_eq!(registration_error_message(&e(400, "password too long")), "password too long");
        assert_eq!(registration_error_message(&e(500, "")), "Registration failed (500).");
        assert_eq!(registration_error_message(&offline()), "Couldn't create your account. Check your connection and try again.");
    }

    #[test]
    fn invite_check() {
        assert_eq!(invite_check_error_message(&offline()), "Couldn't verify this invite. Check your connection and try again.");
        assert_eq!(invite_check_error_message(&e(500, "internal error")), "Couldn't verify this invite. Try again.");
        assert_eq!(invite_check_error_message(&e(429, "rate limit exceeded")), "Too many invite checks. Wait a minute and try again.");
    }

    #[test]
    fn password_change() {
        assert_eq!(password_change_error_message(&e(401, "invalid credentials")), "Your current password is incorrect.");
        assert_eq!(password_change_error_message(&e(429, "rate limit exceeded")), "Too many attempts. Try again later.");
        assert_eq!(password_change_error_message(&e(400, "password too short (min 8 chars)")), "password too short (min 8 chars)");
        assert_eq!(password_change_error_message(&e(500, "")), "Couldn't change your password.");
        assert_eq!(password_change_error_message(&offline()), UNREACHABLE);
    }
}
