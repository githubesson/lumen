//! The first-run and change-server check (`config:test-server` in
//! `electron/ipc.ts`): is there a Lumen server at this address? Forgiving
//! about what's typed (no scheme, a pasted page URL), and answering with the
//! server's origin, after any redirect.

use std::time::Duration;

/// A typed address, read the way `new URL(...)` reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct Address {
    /// `http` or `https`.
    pub scheme: String,
    /// `host[:port]`, the default port left out (`URL.host`).
    pub host: String,
}

impl Address {
    pub fn origin(&self) -> String {
        format!("{}://{}", self.scheme, self.host)
    }
}

/// The address `raw` names, or the message the Welcome screen shows.
pub fn parse_address(raw: &str) -> Result<Address, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("Enter your server's address.".into());
    }
    let full = if has_scheme(text) {
        text.to_string()
    } else {
        format!("https://{text}")
    };
    let bad = || "That doesn't look like a web address.".to_string();
    let (scheme, rest) = full.split_once("://").ok_or_else(bad)?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("The address must start with http:// or https://.".into());
    }
    // The authority runs to the path, query or fragment (`\` counts as `/`
    // in http(s) URLs).
    let end = rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host_port = match authority.rsplit_once('@') {
        Some((userinfo, host)) => {
            if !userinfo.is_empty() && userinfo != ":" {
                return Err("Leave the username and password out of the address.".into());
            }
            host
        }
        None => authority,
    };
    let (host, port) = split_port(host_port).ok_or_else(bad)?;
    let valid = match host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        // An IPv6 literal: hex digits, colons and (for a v4 tail) dots.
        Some(v6) => !v6.is_empty() && v6.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.'),
        None => !host.is_empty() && !host.chars().any(forbidden_host_char),
    };
    if !valid {
        return Err(bad());
    }
    let host = host.to_ascii_lowercase();
    let default_port = if scheme == "https" { 443 } else { 80 };
    let host = match port {
        Some(p) if p != default_port => format!("{host}:{p}"),
        _ => host,
    };
    Ok(Address { scheme, host })
}

/// `^[a-z][a-z\d+.-]*://`, case-insensitively.
fn has_scheme(text: &str) -> bool {
    let Some(i) = text.find("://") else {
        return false;
    };
    let s = &text[..i];
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// `host` and its port; None when the port isn't a number up to 65535.
fn split_port(host_port: &str) -> Option<(&str, Option<u16>)> {
    let (host, port) = if host_port.starts_with('[') {
        let close = host_port.find(']')?;
        let (h, rest) = host_port.split_at(close + 1);
        match rest {
            "" => (h, None),
            _ => (h, Some(rest.strip_prefix(':')?)),
        }
    } else {
        match host_port.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (host_port, None),
        }
    };
    let port = match port {
        None | Some("") => None,
        Some(p) if p.chars().all(|c| c.is_ascii_digit()) => {
            Some(p.parse::<u32>().ok().filter(|&n| n <= 65535)? as u16)
        }
        Some(_) => return None,
    };
    Some((host, port))
}

/// The WHATWG URL spec's forbidden host code points (brackets aside, which
/// only an IPv6 literal has).
fn forbidden_host_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            ' ' | '#' | '%' | '/' | ':' | '<' | '>' | '?' | '@' | '\\' | '^' | '|'
        )
}

/// `testDesktopServer(address)`: `{origin}/api/health` must answer
/// `{"ok": true}` within 8 s. Blocking: run it on `app.net`.
pub fn test_server(raw: &str) -> Result<String, String> {
    let target = parse_address(raw)?;
    let host = target.host.clone();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(8)))
        .user_agent(concat!("Lumen-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let mut response = agent
        .get(format!("{}/api/health", target.origin()))
        .header("Cache-Control", "no-store")
        .call()
        .map_err(|e| match e {
            ureq::Error::Timeout(_) => format!("{host} didn't answer in time."),
            _ => {
                format!("Couldn't reach {host}. Check the address and that the server is running.")
            }
        })?;
    let not_lumen = || format!("{host} answered, but it isn't a Lumen server.");
    if !response.status().is_success() {
        return Err(not_lumen());
    }
    let final_uri = ureq::ResponseExt::get_uri(&response).to_string();
    let body: serde_json::Value = response.body_mut().read_json().map_err(|_| not_lumen())?;
    if body.get("ok") != Some(&serde_json::Value::Bool(true)) {
        return Err(not_lumen());
    }
    // `new URL(response.url || target.href).origin`.
    Ok(parse_address(&final_uri)
        .map(|a| a.origin())
        .unwrap_or_else(|_| target.origin()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(s: &str) -> Result<String, String> {
        parse_address(s).map(|a| a.origin())
    }

    #[test]
    fn addresses_read_like_new_url() {
        assert_eq!(
            origin("music.example.com").unwrap(),
            "https://music.example.com"
        );
        assert_eq!(
            origin(" HTTP://Music.Example.com:80/library?x=1 ").unwrap(),
            "http://music.example.com"
        );
        assert_eq!(
            origin("http://localhost:8080").unwrap(),
            "http://localhost:8080"
        );
        assert_eq!(origin("https://h.com:443").unwrap(), "https://h.com");
        assert_eq!(origin("[::1]:4000").unwrap(), "https://[::1]:4000");
        assert_eq!(
            parse_address("music.example.com:4000").unwrap().host,
            "music.example.com:4000"
        );
        assert_eq!(origin("").unwrap_err(), "Enter your server's address.");
        assert_eq!(
            origin("ftp://x.com").unwrap_err(),
            "The address must start with http:// or https://."
        );
        assert_eq!(
            origin("https://me:pw@x.com").unwrap_err(),
            "Leave the username and password out of the address."
        );
        assert_eq!(
            origin("bad host").unwrap_err(),
            "That doesn't look like a web address."
        );
        assert_eq!(
            origin("x.com:99999").unwrap_err(),
            "That doesn't look like a web address."
        );
        assert_eq!(
            origin("mailto:me").unwrap_err(),
            "That doesn't look like a web address."
        );
    }
}
