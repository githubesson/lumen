//! `core/src/share-link-session.ts` as a plain state machine: the share
//! link for the clip window being edited. A link is minted on first use
//! and reused while the window stays put; asks for the same window while a
//! mint is in flight wait for it (their actions queue up); `invalidate`
//! when the window moves, and a link still being minted for the old window
//! never becomes [`ShareLinkSession::share_url`] (it still answers the
//! actions that waited for it, as the web's promise does).
//!
//! ```ignore
//! match page.session.ensure(&id, start, dur, Action::Copy) {
//!     Ensure::Ready(url, action) => run(action, Ok(url)),
//!     Ensure::Mint(ticket) => app.net.run(
//!         move || api::share::create_track_share_link(&c, &id, start as f64, dur as f64).map(|l| l.url),
//!         move |app, r| { let f = app.page.session.finish(ticket, r); for a in f.actions { run(a, f.url.clone()) } },
//!     ),
//!     Ensure::Waiting => {}
//! }
//! ```

use crate::api::ApiError;

/// Proof of which mint a result belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MintTicket(u64);

pub enum Ensure<A> {
    /// The window's link is known.
    Ready(String, A),
    /// Mint it, then hand the result to [`ShareLinkSession::finish`].
    Mint(MintTicket),
    /// A mint for this window is under way; the action waits for it.
    Waiting,
}

enum State<A> {
    Minting { ticket: MintTicket, waiting: Vec<A> },
    Ready(String),
}

struct Session<A> {
    key: String,
    state: State<A>,
}

/// A mint's outcome and the actions that waited for it.
pub struct Finished<A> {
    pub url: Result<String, ApiError>,
    pub actions: Vec<A>,
}

pub struct ShareLinkSession<A> {
    share_url: Option<String>,
    session: Option<Session<A>>,
    /// Mints still out for windows that moved, with the actions that
    /// waited for them.
    stale: Vec<(MintTicket, Vec<A>)>,
    next_ticket: u64,
}

impl<A> Default for ShareLinkSession<A> {
    fn default() -> Self {
        ShareLinkSession { share_url: None, session: None, stale: Vec::new(), next_ticket: 0 }
    }
}

fn key(track_id: &str, start_sec: u64, duration_sec: u32) -> String {
    format!("{track_id}:{start_sec}:{duration_sec}")
}

impl<A> ShareLinkSession<A> {
    /// The current window's link, once minted.
    pub fn share_url(&self) -> Option<&str> {
        self.share_url.as_deref()
    }

    /// `ensureUrl`: the link for this window, minting it on first use.
    pub fn ensure(&mut self, track_id: &str, start_sec: u64, duration_sec: u32, action: A) -> Ensure<A> {
        let k = key(track_id, start_sec, duration_sec);
        if let Some(s) = self.session.as_mut().filter(|s| s.key == k) {
            return match &mut s.state {
                State::Ready(url) => Ensure::Ready(url.clone(), action),
                State::Minting { waiting, .. } => {
                    waiting.push(action);
                    Ensure::Waiting
                }
            };
        }
        self.forget_session();
        self.next_ticket += 1;
        let ticket = MintTicket(self.next_ticket);
        self.session = Some(Session { key: k, state: State::Minting { ticket, waiting: vec![action] } });
        Ensure::Mint(ticket)
    }

    /// A mint landed. A failure isn't kept, so the next attempt tries
    /// again; a stale mint (the window moved) still answers its callers but
    /// never shows as the session's link.
    pub fn finish(&mut self, ticket: MintTicket, result: Result<String, ApiError>) -> Finished<A> {
        let current = matches!(
            &self.session,
            Some(Session { state: State::Minting { ticket: t, .. }, .. }) if *t == ticket
        );
        if !current {
            let actions = match self.stale.iter().position(|(t, _)| *t == ticket) {
                Some(i) => self.stale.swap_remove(i).1,
                None => Vec::new(),
            };
            return Finished { url: result, actions };
        }
        let session = self.session.take().expect("current session");
        let State::Minting { waiting, .. } = session.state else { unreachable!() };
        if let Ok(url) = &result {
            self.share_url = Some(url.clone());
            self.session = Some(Session { key: session.key, state: State::Ready(url.clone()) });
        }
        Finished { url: result, actions: waiting }
    }

    /// The window moved: forget its link.
    pub fn invalidate(&mut self) {
        self.forget_session();
        self.share_url = None;
    }

    /// Drop the session, keeping a mint still under way answerable.
    fn forget_session(&mut self) {
        if let Some(Session { state: State::Minting { ticket, waiting }, .. }) = self.session.take() {
            self.stale.push((ticket, waiting));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each waiting action with the link, when there is one.
    fn ready(f: Finished<u32>) -> Vec<(u32, String)> {
        match f.url {
            Ok(url) => f.actions.into_iter().map(|a| (a, url.clone())).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn mint(e: Ensure<u32>) -> MintTicket {
        match e {
            Ensure::Mint(t) => t,
            _ => panic!("expected a mint"),
        }
    }

    #[test]
    fn mints_once_per_window_and_reuses_the_link() {
        let mut s = ShareLinkSession::default();
        let t = mint(s.ensure("t1", 10, 30, 1));
        let f = s.finish(t, Ok("https://l/s/1".into()));
        assert_eq!(ready(f), [(1, "https://l/s/1".to_string())]);
        assert!(matches!(s.ensure("t1", 10, 30, 2), Ensure::Ready(u, 2) if u == "https://l/s/1"));
        assert_eq!(s.share_url(), Some("https://l/s/1"));
    }

    #[test]
    fn shares_one_mint_between_concurrent_asks() {
        let mut s = ShareLinkSession::default();
        let t = mint(s.ensure("t1", 0, 30, 1));
        assert!(matches!(s.ensure("t1", 0, 30, 2), Ensure::Waiting));
        assert_eq!(ready(s.finish(t, Ok("u".into()))), [(1, "u".to_string()), (2, "u".to_string())]);
    }

    #[test]
    fn mints_again_for_a_moved_window() {
        let mut s = ShareLinkSession::default();
        let t = mint(s.ensure("t1", 0, 30, 1));
        s.finish(t, Ok("old".into()));
        s.invalidate();
        assert_eq!(s.share_url(), None);
        let t = mint(s.ensure("t1", 5, 30, 2));
        s.finish(t, Ok("new".into()));
        assert_eq!(s.share_url(), Some("new"));
    }

    #[test]
    fn never_shows_a_link_that_lands_after_its_window_moved() {
        let mut s = ShareLinkSession::default();
        let stale = mint(s.ensure("t1", 0, 30, 1));
        s.invalidate();
        let fresh = mint(s.ensure("t1", 5, 30, 2));
        s.finish(fresh, Ok("fresh".into()));
        let late = s.finish(stale, Ok("stale".into()));
        assert_eq!(late.url.as_deref(), Ok("stale"));
        // The action that waited for it still gets its link.
        assert_eq!(ready(late), [(1, "stale".to_string())]);
        assert_eq!(s.share_url(), Some("fresh"));
    }

    #[test]
    fn forgets_a_failed_mint() {
        let mut s = ShareLinkSession::default();
        let t = mint(s.ensure("t1", 0, 30, 1));
        let f = s.finish(t, Err(ApiError::transport("nope")));
        assert!(f.url.is_err());
        assert_eq!(s.share_url(), None);
        let t = mint(s.ensure("t1", 0, 30, 2));
        assert_eq!(ready(s.finish(t, Ok("u".into()))), [(2, "u".to_string())]);
    }
}
