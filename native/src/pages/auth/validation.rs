//! `core/src/auth/validation.ts`: the registration and password-change rules
//! both clients check before asking the server.
//!
//! TODO(api-merge): replace with the shared port once `core::auth::validation`
//! lands in `crate::api`.

pub struct RegistrationValidation {
    /// The trimmed username, as sent.
    pub username: String,
    pub username_error: Option<&'static str>,
    pub password_error: Option<&'static str>,
}

impl RegistrationValidation {
    pub fn valid(&self) -> bool {
        self.username_error.is_none() && self.password_error.is_none()
    }
    /// The first message to show.
    pub fn error(&self) -> Option<&'static str> {
        self.username_error.or(self.password_error)
    }
}

/// Usernames need 2 Unicode characters, passwords 8 (and at most 256 bytes,
/// the server's limit).
pub fn validate_registration_input(username_input: &str, password: &str) -> RegistrationValidation {
    let username = username_input.trim().to_string();
    let username_error =
        (username.chars().count() < 2).then_some("Username must be at least 2 characters.");
    RegistrationValidation {
        username,
        username_error,
        password_error: password_rule_error(password),
    }
}

pub struct PasswordChangeValidation {
    pub current_error: Option<&'static str>,
    pub password_error: Option<&'static str>,
    pub confirm_error: Option<&'static str>,
}

impl PasswordChangeValidation {
    pub fn valid(&self) -> bool {
        self.error().is_none()
    }
    pub fn error(&self) -> Option<&'static str> {
        self.current_error
            .or(self.password_error)
            .or(self.confirm_error)
    }
}

/// A new password follows the registration rule; the current one is only
/// checked for presence (the server judges whether it's right).
pub fn validate_password_change(
    current: &str,
    next: &str,
    confirm: &str,
) -> PasswordChangeValidation {
    PasswordChangeValidation {
        current_error: current.is_empty().then_some("Enter your current password."),
        password_error: password_rule_error(next),
        confirm_error: (confirm != next).then_some("Passwords don't match."),
    }
}

fn password_rule_error(password: &str) -> Option<&'static str> {
    if password.chars().count() < 8 {
        Some("Password must be at least 8 characters.")
    } else if password.len() > 256 {
        Some("Password must be no more than 256 bytes.")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_rules() {
        let v = validate_registration_input(" a ", "12345678");
        assert_eq!(v.error(), Some("Username must be at least 2 characters."));
        let v = validate_registration_input("  ab ", "1234567");
        assert_eq!(v.username, "ab");
        assert_eq!(v.error(), Some("Password must be at least 8 characters."));
        // Eight characters, but 4 bytes each: 65 of them pass 256 bytes.
        let long: String = std::iter::repeat_n('😀', 65).collect();
        assert_eq!(
            validate_registration_input("ab", &long).error(),
            Some("Password must be no more than 256 bytes.")
        );
        assert!(validate_registration_input("ab", "ééééééééé").valid());
    }

    #[test]
    fn password_change_rules() {
        assert_eq!(
            validate_password_change("", "12345678", "12345678").error(),
            Some("Enter your current password.")
        );
        assert_eq!(
            validate_password_change("x", "12345678", "1234567").error(),
            Some("Passwords don't match.")
        );
        assert!(validate_password_change("x", "12345678", "12345678").valid());
    }
}
