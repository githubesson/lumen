//! `core/src/admin/invite-links.ts`: the mobile app's registration deep
//! link, the message an admin shares, and reading a token back out of
//! whatever the invitee pastes.

const INVITE_SCHEME: &str = "musiclibrarymobile";

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

fn is_invite_token(s: &str) -> bool {
    s.chars().count() >= 16 && s.chars().all(is_token_char)
}

fn token_from_url(candidate: &str) -> Option<String> {
    let url = url::Url::parse(candidate).ok()?;
    let token = url.query_pairs().find(|(k, _)| k == "token").map(|(_, v)| v.trim().to_string())?;
    is_invite_token(&token).then_some(token)
}

/// `extractInviteToken`: a raw token, a registration URL, or the whole
/// shared message. The public invite check is the judge of whether it's real.
pub fn extract_invite_token(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if is_invite_token(trimmed) {
        return Some(trimmed.to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    let mut at = 0;
    while at < lower.len() {
        let next = ["http://", "https://", "musiclibrarymobile://"]
            .iter()
            .filter_map(|p| lower[at..].find(p).map(|i| at + i))
            .min();
        let Some(start) = next else { break };
        let end = trimmed[start..]
            .find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\''))
            .map_or(trimmed.len(), |i| start + i);
        let candidate = trimmed[start..end].trim_end_matches([')', ',', '.', ';']);
        if let Some(token) = token_from_url(candidate) {
            return Some(token);
        }
        at = end.max(start + 1);
    }
    // "token: …" or "invite token: …".
    let mut from = 0;
    while let Some(i) = lower[from..].find("token") {
        let after = &trimmed[from + i + 5..];
        if let Some(rest) = after.trim_start().strip_prefix(':') {
            let token: String = rest.trim_start().chars().take_while(|c| is_token_char(*c)).collect();
            if is_invite_token(&token) {
                return Some(token);
            }
        }
        from += i + 5;
    }
    None
}

/// The mobile app's deep link that opens registration with `token`.
pub fn build_invite_registration_url(token: &str) -> String {
    format!("{INVITE_SCHEME}://register?token={}", crate::api::seg(token))
}

/// What an admin shares: the deep link, with the raw token as a fallback.
pub fn build_invite_share_message(token: &str) -> String {
    [
        "You've been invited to Lumen.",
        "",
        "Open this link on a device with Lumen installed:",
        &build_invite_registration_url(token),
        "",
        "If the link doesn't open, open Lumen, choose Create account, and paste this invite token:",
        token,
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyz_ABCDEFGH-1234567";

    #[test]
    fn links() {
        assert_eq!(build_invite_registration_url(TOKEN), format!("musiclibrarymobile://register?token={TOKEN}"));
        assert_eq!(build_invite_registration_url("token with spaces"), "musiclibrarymobile://register?token=token%20with%20spaces");
    }

    #[test]
    fn extracts_tokens() {
        assert_eq!(extract_invite_token(&format!("  {TOKEN}\n")).as_deref(), Some(TOKEN));
        let enc = crate::api::seg(TOKEN);
        assert_eq!(extract_invite_token(&format!("musiclibrarymobile://register?token={enc}")).as_deref(), Some(TOKEN));
        assert_eq!(extract_invite_token(&format!("https://lumen.example/register?token={enc}")).as_deref(), Some(TOKEN));
        assert_eq!(extract_invite_token(&build_invite_share_message(TOKEN)).as_deref(), Some(TOKEN));
        let message = build_invite_share_message(TOKEN);
        assert!(message.contains(&build_invite_registration_url(TOKEN)));
        assert!(message.contains(&format!("invite token:\n{TOKEN}")));
        assert_eq!(extract_invite_token(&format!("Your token: {TOKEN}.")).as_deref(), Some(TOKEN));
    }

    #[test]
    fn rejects_what_isnt_one() {
        assert_eq!(extract_invite_token(""), None);
        assert_eq!(extract_invite_token("please create an account"), None);
        assert_eq!(extract_invite_token("not+a+url-safe+token"), None);
        assert_eq!(extract_invite_token("https://lumen.example/register"), None);
    }
}
