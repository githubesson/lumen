//! Where the app is: the web app's URL (`pathname` + `search`), kept as a
//! path and its query so the page logic ported from React Router (Library's
//! drill-down params, Home's `?customize`, Admin's `?section`) reads the
//! same values. History works like the browser's: push, replace, back.

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Location {
    pub path: String,
    pub query: Vec<(String, String)>,
}

impl Location {
    /// Parses `/library?view=albums&album=x`.
    pub fn parse(s: &str) -> Location {
        let (path, search) = s.split_once('?').unwrap_or((s, ""));
        let query = search
            .split('&')
            .filter(|p| !p.is_empty())
            .map(|p| {
                let (k, v) = p.split_once('=').unwrap_or((p, ""));
                (decode(k), decode(v))
            })
            .collect();
        let path = if path.is_empty() { "/".to_string() } else { path.to_string() };
        Location { path, query }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    pub fn has(&self, key: &str) -> bool {
        self.query.iter().any(|(k, _)| k == key)
    }

    /// With `key` set to `value` (or removed for None), keeping the order.
    pub fn with(&self, key: &str, value: Option<&str>) -> Location {
        let mut next = self.clone();
        match value {
            Some(v) => {
                if let Some(slot) = next.query.iter_mut().find(|(k, _)| k == key) {
                    slot.1 = v.to_string();
                } else {
                    next.query.push((key.to_string(), v.to_string()));
                }
            }
            None => next.query.retain(|(k, _)| k != key),
        }
        next
    }

    pub fn search(&self) -> String {
        if self.query.is_empty() {
            return String::new();
        }
        let parts: Vec<String> =
            self.query.iter().map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v))).collect();
        format!("?{}", parts.join("&"))
    }

    pub fn href(&self) -> String {
        format!("{}{}", self.path, self.search())
    }

    pub fn is(&self, path: &str) -> bool {
        self.path == path
    }

    pub fn starts_with(&self, prefix: &str) -> bool {
        self.path.starts_with(prefix)
    }

    /// The `:id` of `/playlists/:id`.
    pub fn segment(&self, index: usize) -> Option<&str> {
        self.path.split('/').filter(|s| !s.is_empty()).nth(index)
    }
}

fn decode(s: &str) -> String {
    urlencoding::decode(&s.replace('+', " ")).map(|c| c.into_owned()).unwrap_or_else(|_| s.to_string())
}

/// Browser-style history.
#[derive(Clone, Debug, Default)]
pub struct History {
    pub entries: Vec<Location>,
    pub index: usize,
}

impl History {
    pub fn new(start: Location) -> History {
        History { entries: vec![start], index: 0 }
    }

    pub fn current(&self) -> &Location {
        &self.entries[self.index]
    }

    pub fn push(&mut self, loc: Location) {
        if *self.current() == loc {
            return;
        }
        self.entries.truncate(self.index + 1);
        self.entries.push(loc);
        self.index = self.entries.len() - 1;
        // A long session keeps a bounded history.
        if self.entries.len() > 200 {
            let drop = self.entries.len() - 200;
            self.entries.drain(..drop);
            self.index -= drop;
        }
    }

    pub fn replace(&mut self, loc: Location) {
        self.entries[self.index] = loc;
    }

    pub fn back(&mut self) -> bool {
        if self.index == 0 {
            return false;
        }
        self.index -= 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats() {
        let l = Location::parse("/library?view=albums&q=a%20b");
        assert_eq!(l.path, "/library");
        assert_eq!(l.get("view"), Some("albums"));
        assert_eq!(l.get("q"), Some("a b"));
        assert_eq!(l.href(), "/library?view=albums&q=a%20b");
        assert_eq!(Location::parse("/playlists/p1").segment(1), Some("p1"));
    }
}
