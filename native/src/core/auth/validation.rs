//! `core/src/auth/validation.ts`: 2-character usernames and 8-character
//! passwords, in Unicode characters, and the server's 256-byte password cap.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistrationValidation {
    pub username: String,
    pub username_error: Option<&'static str>,
    pub password_error: Option<&'static str>,
    pub valid: bool,
}

pub fn validate_registration_input(username_input: &str, password: &str) -> RegistrationValidation {
    let username = username_input.trim().to_string();
    let username_error = (username.chars().count() < 2).then_some("Username must be at least 2 characters.");
    let password_error = password_rule_error(password);
    RegistrationValidation {
        username,
        username_error,
        password_error,
        valid: username_error.is_none() && password_error.is_none(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PasswordChangeValidation {
    pub current_error: Option<&'static str>,
    pub password_error: Option<&'static str>,
    pub confirm_error: Option<&'static str>,
    pub valid: bool,
}

/// A new password follows the registration rule; the current one is only
/// checked for presence (the server judges it).
pub fn validate_password_change(current: &str, next: &str, confirm: &str) -> PasswordChangeValidation {
    let current_error = current.is_empty().then_some("Enter your current password.");
    let password_error = password_rule_error(next);
    let confirm_error = (confirm != next).then_some("Passwords don't match.");
    PasswordChangeValidation {
        current_error,
        password_error,
        confirm_error,
        valid: current_error.is_none() && password_error.is_none() && confirm_error.is_none(),
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
    fn registration() {
        let v = validate_registration_input(" ab ", "12345678");
        assert_eq!((v.username.as_str(), v.username_error, v.password_error, v.valid), ("ab", None, None, true));
        assert!(validate_registration_input("ab", &"x".repeat(256)).valid);
        assert!(validate_registration_input("ab", &"😀".repeat(64)).valid);
        assert_eq!(validate_registration_input(" a ", "12345678").username_error, Some("Username must be at least 2 characters."));
        assert_eq!(validate_registration_input("ab", "1234567").password_error, Some("Password must be at least 8 characters."));
        assert_eq!(validate_registration_input("ab", &"x".repeat(257)).password_error, Some("Password must be no more than 256 bytes."));
        assert_eq!(validate_registration_input("ab", &"😀".repeat(65)).password_error, Some("Password must be no more than 256 bytes."));
    }

    #[test]
    fn password_change() {
        assert_eq!(
            validate_password_change("old", "12345678", "12345678"),
            PasswordChangeValidation { current_error: None, password_error: None, confirm_error: None, valid: true }
        );
        let v = validate_password_change("old", &"😀".repeat(4), &"😀".repeat(4));
        assert_eq!((v.password_error, v.valid), (Some("Password must be at least 8 characters."), false));
        assert_eq!(validate_password_change("old", "1234567", "1234567").password_error, Some("Password must be at least 8 characters."));
        assert_eq!(
            validate_password_change("old", &"x".repeat(257), &"x".repeat(257)).password_error,
            Some("Password must be no more than 256 bytes.")
        );
        let v = validate_password_change("", "12345678", "12345678");
        assert_eq!((v.current_error, v.valid), (Some("Enter your current password."), false));
        let v = validate_password_change("old", "12345678", "12345679");
        assert_eq!((v.confirm_error, v.valid), (Some("Passwords don't match."), false));
        assert_eq!(validate_password_change("old", "12345678", "").confirm_error, Some("Passwords don't match."));
    }
}
