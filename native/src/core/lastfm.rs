//! `core/src/lastfm/use-lastfm-connection.ts` as a state machine, and
//! `lastFMConnectionState` for the settings row. The page runs requests on
//! `app.net`:
//!
//! - On open: `api::lastfm::get_lastfm_status`, then `status_loaded(r)`;
//!   when that returns a [`LastFmWait`], run it on a worker and hand its
//!   answer to `wait_finished`.
//! - Connect: `connect()` → run `connect_lastfm`; `connect_started(r)` → the
//!   page opens the authorization URL it returns, then `opened(ok)`, which
//!   may return the wait to run.
//! - Disconnect: `disconnect()` → run `disconnect_lastfm`; `disconnected(r)`.

use crate::api::lastfm::{LastFmConnectResponse, LastFmStatus, default_lastfm_poll, wait_for_lastfm_authorization};
use crate::api::tidal::PollOptions;
use crate::api::{ApiError, ApiResult, Cancel, Client, error_message};

/// A wait for the user's approval, to run on a worker.
#[derive(Clone)]
pub struct LastFmWait {
    pub ticket: u64,
    pub options: PollOptions,
    pub cancel: Cancel,
}

impl LastFmWait {
    /// The connected username.
    pub fn run(&self, c: &Client) -> ApiResult<String> {
        wait_for_lastfm_authorization(c, self.options, &self.cancel)
    }
}

#[derive(Default)]
pub struct LastFmConnection {
    pub status: Option<LastFmStatus>,
    pub busy: bool,
    pub error: Option<String>,
    wait: Option<(u64, Cancel)>,
    tickets: u64,
}

impl LastFmConnection {
    /// The status arrived (a failed read shows as "checking", as on the web).
    pub fn status_loaded(&mut self, result: ApiResult<LastFmStatus>) -> Option<LastFmWait> {
        self.status = result.ok();
        self.maybe_wait()
    }

    /// The status says the server waits for approval: start one wait (each
    /// new wait owns a fresh error).
    fn maybe_wait(&mut self) -> Option<LastFmWait> {
        let s = self.status.as_ref()?;
        if !s.configured || s.connected || !s.pending || self.wait.is_some() {
            return None;
        }
        self.error = None;
        self.tickets += 1;
        let cancel = Cancel::new();
        self.wait = Some((self.tickets, cancel.clone()));
        Some(LastFmWait { ticket: self.tickets, options: default_lastfm_poll(), cancel })
    }

    /// The wait finished. A deadline is a failure, not a cancellation: the
    /// row leaves its waiting state so connecting again starts afresh.
    pub fn wait_finished(&mut self, ticket: u64, result: ApiResult<String>) {
        match &self.wait {
            Some((t, c)) if *t == ticket && !c.is_cancelled() => {}
            _ => return,
        }
        self.wait = None;
        match result {
            Ok(username) => {
                let configured = self.status.as_ref().is_none_or(|s| s.configured);
                self.status = Some(LastFmStatus {
                    configured,
                    connected: true,
                    pending: false,
                    username: Some(username),
                    last_error: None,
                });
            }
            Err(e) => {
                if let Some(s) = self.status.as_mut() {
                    s.pending = false;
                }
                self.error = Some(error_message(&e, "Could not complete Last.fm authorization."));
            }
        }
    }

    /// Start connecting: run `connect_lastfm`.
    pub fn connect(&mut self) {
        self.busy = true;
        self.error = None;
    }

    /// `connect_lastfm` answered: the URL to open (the desktop launcher
    /// confirms it opened before the row waits), or `None` with the error.
    pub fn connect_started(&mut self, result: ApiResult<LastFmConnectResponse>) -> Option<String> {
        match result {
            Ok(r) => Some(r.authorization_url),
            Err(e) => {
                self.fail_connect(&e);
                None
            }
        }
    }

    /// The authorization page opened (or not): mark the server's wait and
    /// return the poll to run.
    pub fn opened(&mut self, ok: bool) -> Option<LastFmWait> {
        self.busy = false;
        if !ok {
            self.error = Some("Could not connect Last.fm.".into());
            return None;
        }
        if let Some(s) = self.status.as_mut() {
            s.pending = true;
            s.last_error = None;
        }
        self.maybe_wait()
    }

    fn fail_connect(&mut self, e: &ApiError) {
        self.busy = false;
        self.error = Some(error_message(e, "Could not connect Last.fm."));
    }

    /// Start disconnecting: run `disconnect_lastfm`.
    pub fn disconnect(&mut self) {
        self.busy = true;
        self.error = None;
    }

    pub fn disconnected(&mut self, result: Result<(), ApiError>) {
        self.busy = false;
        match result {
            Ok(()) => {
                let configured = self.status.as_ref().is_none_or(|s| s.configured);
                self.cancel_wait();
                self.status = Some(LastFmStatus { configured, ..Default::default() });
            }
            Err(e) => self.error = Some(error_message(&e, "Could not disconnect Last.fm.")),
        }
    }

    /// The settings row went away: stop waiting.
    pub fn close(&mut self) {
        self.cancel_wait();
    }

    fn cancel_wait(&mut self) {
        if let Some((_, c)) = self.wait.take() {
            c.cancel();
        }
    }

    /// The row's description of this state.
    pub fn view(&self) -> LastFmConnectionState {
        lastfm_connection_state(self.status.as_ref(), self.error.as_deref())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LastFmConnectionKind {
    Checking,
    Unavailable,
    Connected,
    Pending,
    Disconnected,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastFmConnectionState {
    pub kind: LastFmConnectionKind,
    pub description: String,
    pub error: Option<String>,
}

/// `lastFMConnectionState`: where the connection stands, for a settings
/// row. The row's own error wins over the server's last one.
pub fn lastfm_connection_state(status: Option<&LastFmStatus>, error: Option<&str>) -> LastFmConnectionState {
    let error = error
        .filter(|e| !e.is_empty())
        .or_else(|| status.and_then(|s| s.last_error.as_deref()).filter(|e| !e.is_empty()))
        .map(Into::into);
    let (kind, description) = match status {
        None => (LastFmConnectionKind::Checking, "Checking…".to_string()),
        Some(s) if !s.configured => (LastFmConnectionKind::Unavailable, "Not set up on this server.".into()),
        Some(s) if s.connected => (
            LastFmConnectionKind::Connected,
            format!("Scrobbling as {}.", s.username.as_deref().filter(|u| !u.is_empty()).unwrap_or("your account")),
        ),
        Some(s) if s.pending => (LastFmConnectionKind::Pending, "Waiting for you to approve Lumen on Last.fm.".into()),
        Some(_) => (LastFmConnectionKind::Disconnected, "Send what you play to your Last.fm profile.".into()),
    };
    LastFmConnectionState { kind, description, error }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(f: impl FnOnce(&mut LastFmStatus)) -> LastFmStatus {
        let mut s = LastFmStatus { configured: true, ..Default::default() };
        f(&mut s);
        s
    }

    #[test]
    fn walks_the_five_states() {
        assert_eq!(
            lastfm_connection_state(None, None),
            LastFmConnectionState { kind: LastFmConnectionKind::Checking, description: "Checking…".into(), error: None }
        );
        assert_eq!(lastfm_connection_state(Some(&base(|s| s.configured = false)), None).kind, LastFmConnectionKind::Unavailable);
        let d = lastfm_connection_state(Some(&base(|_| {})), None);
        assert_eq!((d.kind, d.description.as_str()), (LastFmConnectionKind::Disconnected, "Send what you play to your Last.fm profile."));
        let p = lastfm_connection_state(Some(&base(|s| s.pending = true)), None);
        assert_eq!((p.kind, p.description.as_str()), (LastFmConnectionKind::Pending, "Waiting for you to approve Lumen on Last.fm."));
        let c = lastfm_connection_state(
            Some(&base(|s| {
                s.connected = true;
                s.username = Some("listener".into());
            })),
            None,
        );
        assert_eq!((c.kind, c.description.as_str()), (LastFmConnectionKind::Connected, "Scrobbling as listener."));
        assert_eq!(
            lastfm_connection_state(Some(&base(|s| s.connected = true)), None).description,
            "Scrobbling as your account."
        );
    }

    #[test]
    fn prefers_the_rows_error() {
        let status = base(|s| s.last_error = Some("Session key revoked.".into()));
        assert_eq!(lastfm_connection_state(Some(&status), None).error.as_deref(), Some("Session key revoked."));
        assert_eq!(
            lastfm_connection_state(Some(&status), Some("Could not connect Last.fm.")).error.as_deref(),
            Some("Could not connect Last.fm.")
        );
        assert_eq!(lastfm_connection_state(Some(&base(|_| {})), None).error, None);
        assert_eq!(lastfm_connection_state(Some(&base(|_| {})), Some("")).error, None);
    }

    // lastfm-connection.test.tsx
    #[test]
    fn connects_then_waits_for_approval() {
        let mut c = LastFmConnection::default();
        assert!(c.status_loaded(Ok(base(|_| {}))).is_none());
        c.connect();
        assert!(c.busy);
        let url = c.connect_started(Ok(LastFmConnectResponse { authorization_url: "https://last.fm/authorize".into() }));
        assert_eq!(url.as_deref(), Some("https://last.fm/authorize"));
        let wait = c.opened(true).expect("a wait");
        assert!(!c.busy);
        assert_eq!(c.view().kind, LastFmConnectionKind::Pending);
        c.wait_finished(wait.ticket, Ok("listener".into()));
        assert_eq!(
            c.status,
            Some(LastFmStatus { configured: true, connected: true, pending: false, username: Some("listener".into()), last_error: None })
        );
    }

    #[test]
    fn a_failed_launch_starts_no_wait() {
        let mut c = LastFmConnection::default();
        c.status_loaded(Ok(base(|_| {})));
        c.connect();
        c.connect_started(Ok(LastFmConnectResponse { authorization_url: "u".into() }));
        assert!(c.opened(false).is_none());
        assert_eq!(c.error.as_deref(), Some("Could not connect Last.fm."));
        assert!(!c.busy);
        assert_eq!(c.status.as_ref().map(|s| s.pending), Some(false));
    }

    #[test]
    fn a_closed_row_ignores_a_late_answer() {
        let mut c = LastFmConnection::default();
        let wait = c.status_loaded(Ok(base(|s| s.pending = true))).expect("a wait");
        c.close();
        assert!(wait.cancel.is_cancelled());
        c.wait_finished(wait.ticket, Ok("late".into()));
        assert_eq!(c.status.as_ref().map(|s| s.connected), Some(false));
    }

    #[test]
    fn a_deadline_ends_the_wait_and_a_new_connect_waits_again() {
        let mut c = LastFmConnection::default();
        let wait = c.status_loaded(Ok(base(|s| s.pending = true))).unwrap();
        let timeout = ApiError { status: 0, message: "The request timed out.".into(), kind: crate::api::ErrorKind::Timeout };
        c.wait_finished(wait.ticket, Err(timeout));
        assert_eq!(c.error.as_deref(), Some("Could not complete Last.fm authorization."));
        assert_eq!(c.status.as_ref().map(|s| s.pending), Some(false));
        c.connect();
        c.connect_started(Ok(LastFmConnectResponse { authorization_url: "u".into() }));
        let again = c.opened(true).expect("a second wait");
        c.wait_finished(again.ticket, Ok("listener".into()));
        assert_eq!(c.status.as_ref().map(|s| s.connected), Some(true));
    }

    #[test]
    fn disconnects() {
        let mut c = LastFmConnection::default();
        c.status_loaded(Ok(base(|s| s.connected = true)));
        c.disconnect();
        c.disconnected(Ok(()));
        assert_eq!(c.status, Some(LastFmStatus { configured: true, ..Default::default() }));
        c.disconnect();
        c.disconnected(Err(ApiError::transport("x")));
        assert_eq!(c.error.as_deref(), Some("Could not disconnect Last.fm."));
    }
}
