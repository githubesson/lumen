//! The server's address as the sign-in and Welcome screens show it (`hostOf`
//! in `Login.tsx`, `new URL(server).host` in `Welcome.tsx`). Checking an
//! address (`config:test-server`) is the desktop layer's:
//! [`crate::desktop::test_server`].

/// `new URL(url).host`, or `url` itself when it doesn't parse.
pub fn host_of(url: &str) -> String {
    url::Url::parse(url).map_or_else(|_| url.to_string(), |u| crate::desktop::url_host(&u).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_read_like_new_url() {
        assert_eq!(host_of("https://music.example.com"), "music.example.com");
        assert_eq!(host_of("https://h.com:443"), "h.com");
        assert_eq!(host_of("http://localhost:8080"), "localhost:8080");
        assert_eq!(host_of("https://[::1]:4000"), "[::1]:4000");
        assert_eq!(host_of("not a url"), "not a url");
    }
}
