//! `core/src/tidal/use-tidal-device-login.ts` as a state machine: linking
//! TIDAL accounts through the device-code flow and unlinking them, with the
//! screen's notice and error. The page runs the requests on `app.net` and
//! reports back:
//!
//! 1. `start()` → true: run `api::tidal::start_tidal_auth`, then `started(r)`.
//! 2. `started` → `Some(StartedFlow)`: open `url` (then `opened(..)`), and run
//!    `flow.poll.run(&client)` on a worker, then `poll_finished(ticket, r)`.
//! 3. `poll_finished` → `PollOutcome::Linked`: refresh the TIDAL status.
//! 4. `unlink(id)` → true: run `remove_tidal_account`, then `unlinked(r)`;
//!    when that says so, refresh the status, then `unlink_settled()`.
//!
//! `close()` (the screen went away) cancels the poll; its late answer is
//! ignored.

use crate::api::tidal::{PollOptions, TidalAuthPoll, TidalAuthStart, TidalAuthState, wait_for_tidal_authorization};
use crate::api::{ApiError, ApiResult, Cancel, Client, error_message};
use crate::core::dates;

/// TIDAL can hand out its verification link without a scheme
/// ("link.tidal.com/ABCDE"): those get https when they point at TIDAL;
/// anything else passes through for the platform's URL check to reject.
pub fn normalize_tidal_verification_url(raw: &str) -> String {
    let trimmed = raw.trim();
    let has_scheme = trimmed.split_once(':').is_some_and(|(scheme, _)| {
        let mut cs = scheme.chars();
        cs.next().is_some_and(|c| c.is_ascii_alphabetic())
            && cs.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    if trimmed.is_empty() || has_scheme {
        return trimmed.to_string();
    }
    let candidate = format!("https://{}", trimmed.strip_prefix("//").unwrap_or(trimmed));
    if let Ok(url) = url::Url::parse(&candidate)
        && let Some(host) = url.host_str()
        && (host == "tidal.com" || host.ends_with(".tidal.com"))
    {
        return url.to_string();
    }
    trimmed.to_string()
}

/// `tidalAuthorizationTimeoutMs`: poll until a little after the code
/// expires, so the server's "expired" arrives first.
pub fn tidal_authorization_timeout_ms(expires_at: &str, now_ms: i64) -> Option<u64> {
    let expires_in = dates::parse(expires_at)? - now_ms;
    Some((expires_in + 5000).max(2500) as u64)
}

/// `tidalSignInMessage`: how a finished device login turned out.
pub fn tidal_sign_in_message(result: &TidalAuthPoll) -> String {
    if result.state == TidalAuthState::Linked {
        return match result.account.as_ref().map(|a| a.user_id.as_str()).filter(|u| !u.is_empty()) {
            Some(user) => format!("TIDAL account {user} linked."),
            None => "TIDAL account linked.".into(),
        };
    }
    match result.message.as_deref().filter(|m| !m.is_empty()) {
        Some(m) => m.to_string(),
        None => format!("TIDAL sign-in {}.", result.state.as_str()),
    }
}

/// The wait for a started login, to run on a worker.
#[derive(Clone)]
pub struct PollJob {
    pub ticket: u64,
    pub flow_id: String,
    pub options: PollOptions,
    pub cancel: Cancel,
}

impl PollJob {
    pub fn run(&self, c: &Client) -> ApiResult<TidalAuthPoll> {
        wait_for_tidal_authorization(c, &self.flow_id, self.options, &self.cancel)
    }
}

/// A login that started: open `url`, run `poll`.
pub struct StartedFlow {
    pub url: String,
    pub poll: PollJob,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PollOutcome {
    /// An account was linked: refresh the status (and close a browser sheet).
    Linked,
    /// It ended without one; `error` says why.
    Ended,
    /// A cancelled poll's late answer.
    Ignored,
}

/// The page's view of the flow (`useTidalDeviceLogin`'s state).
#[derive(Default)]
pub struct TidalDeviceLogin {
    pub flow: Option<TidalAuthStart>,
    pub starting: bool,
    pub unlinking_id: Option<String>,
    pub error: Option<String>,
    pub notice: Option<String>,
    poll: Option<(u64, Cancel)>,
    tickets: u64,
}

impl TidalDeviceLogin {
    /// Start a device login; false while one is starting or under way.
    pub fn start(&mut self) -> bool {
        if self.starting || self.flow.is_some() {
            return false;
        }
        self.starting = true;
        self.error = None;
        self.notice = None;
        true
    }

    /// `startTidalAuth` answered: the page to open and the wait to run, or
    /// `None` (and the server's reason in `error`).
    pub fn started(&mut self, result: ApiResult<TidalAuthStart>, now_ms: i64) -> Option<StartedFlow> {
        self.starting = false;
        let flow = match result {
            Ok(flow) => flow,
            Err(e) => {
                self.error = Some(error_message(&e, "Could not start TIDAL sign-in."));
                return None;
            }
        };
        self.cancel_poll();
        self.tickets += 1;
        let cancel = Cancel::new();
        self.poll = Some((self.tickets, cancel.clone()));
        let timeout = tidal_authorization_timeout_ms(&flow.expires_at, now_ms);
        let poll = PollJob { ticket: self.tickets, flow_id: flow.flow_id.clone(), options: PollOptions::new(2500, timeout), cancel };
        let url = normalize_tidal_verification_url(&flow.verification_url);
        self.flow = Some(flow);
        Some(StartedFlow { url, poll })
    }

    /// Opening the page failed: say so (the wait goes on, so it can be
    /// reopened). `reason` is the platform's, when it knows one.
    pub fn open_failed(&mut self, reason: Option<&str>) {
        self.error = Some(reason.filter(|r| !r.is_empty()).unwrap_or("Could not open the TIDAL sign-in page.").to_string());
    }

    /// The page to open again for the current login.
    pub fn reopen(&mut self) -> Option<String> {
        let url = normalize_tidal_verification_url(&self.flow.as_ref()?.verification_url);
        self.error = None;
        Some(url)
    }

    /// The wait finished. A poll that hit the request deadline is a
    /// failure, not a cancellation.
    pub fn poll_finished(&mut self, ticket: u64, result: ApiResult<TidalAuthPoll>) -> PollOutcome {
        match &self.poll {
            Some((t, cancel)) if *t == ticket && !cancel.is_cancelled() => {}
            _ => return PollOutcome::Ignored,
        }
        self.poll = None;
        self.flow = None;
        match result {
            Ok(r) if r.state == TidalAuthState::Linked => {
                self.error = None;
                self.notice = Some(tidal_sign_in_message(&r));
                PollOutcome::Linked
            }
            Ok(r) => {
                self.error = Some(tidal_sign_in_message(&r));
                PollOutcome::Ended
            }
            Err(e) => {
                self.error = Some(error_message(&e, "Could not complete TIDAL sign-in."));
                PollOutcome::Ended
            }
        }
    }

    /// Unlink an account; false while another unlink runs.
    pub fn unlink(&mut self, account_id: &str) -> bool {
        if self.unlinking_id.is_some() {
            return false;
        }
        self.unlinking_id = Some(account_id.to_string());
        self.error = None;
        self.notice = None;
        true
    }

    /// The unlink answered. True: refresh the status, then call
    /// [`TidalDeviceLogin::unlink_settled`] (the row stays busy until the
    /// refreshed list drops it).
    pub fn unlinked(&mut self, result: Result<(), ApiError>) -> bool {
        match result {
            Ok(()) => {
                self.notice = Some("TIDAL account unlinked.".into());
                true
            }
            Err(e) => {
                self.error = Some(error_message(&e, "Could not unlink the TIDAL account."));
                self.unlinking_id = None;
                false
            }
        }
    }

    pub fn unlink_settled(&mut self) {
        self.unlinking_id = None;
    }

    pub fn clear_error(&mut self) {
        self.error = None;
    }

    /// The screen closed: stop waiting.
    pub fn close(&mut self) {
        self.cancel_poll();
    }

    fn cancel_poll(&mut self) {
        if let Some((_, c)) = self.poll.take() {
            c.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::tidal::TidalAccount;

    #[test]
    fn normalizes_verification_links() {
        assert_eq!(normalize_tidal_verification_url(" link.tidal.com/ABCDE "), "https://link.tidal.com/ABCDE");
        assert_eq!(normalize_tidal_verification_url("//tidal.com/device"), "https://tidal.com/device");
        assert_eq!(normalize_tidal_verification_url("https://link.tidal.com/X"), "https://link.tidal.com/X");
        assert_eq!(normalize_tidal_verification_url("eviltidal.com/x"), "eviltidal.com/x");
        assert_eq!(normalize_tidal_verification_url("javascript:alert(1)"), "javascript:alert(1)");
        assert_eq!(normalize_tidal_verification_url("  "), "");
    }

    #[test]
    fn waits_until_a_little_after_expiry() {
        let now = dates::parse("2026-10-02T12:00:00.000Z").unwrap();
        assert_eq!(tidal_authorization_timeout_ms("2026-10-02T12:05:00.000Z", now), Some(305_000));
        assert_eq!(tidal_authorization_timeout_ms("2026-10-02T11:00:00.000Z", now), Some(2500));
        assert_eq!(tidal_authorization_timeout_ms("", now), None);
    }

    fn poll(state: TidalAuthState, user: Option<&str>, message: Option<&str>) -> TidalAuthPoll {
        TidalAuthPoll {
            state,
            message: message.map(Into::into),
            account: user.map(|u| TidalAccount { id: "a".into(), user_id: u.into(), removable: true }),
        }
    }

    #[test]
    fn sign_in_messages() {
        assert_eq!(tidal_sign_in_message(&poll(TidalAuthState::Linked, Some("1234"), None)), "TIDAL account 1234 linked.");
        assert_eq!(tidal_sign_in_message(&poll(TidalAuthState::Linked, None, None)), "TIDAL account linked.");
        assert_eq!(tidal_sign_in_message(&poll(TidalAuthState::Denied, None, None)), "TIDAL sign-in denied.");
        assert_eq!(tidal_sign_in_message(&poll(TidalAuthState::Expired, None, Some("Code expired."))), "Code expired.");
    }

    fn flow() -> TidalAuthStart {
        TidalAuthStart {
            flow_id: "flow-1".into(),
            verification_url: "link.tidal.com/ABCDE".into(),
            user_code: None,
            expires_at: "2026-10-02T12:05:00.000Z".into(),
        }
    }

    fn now() -> i64 {
        dates::parse("2026-10-02T12:00:00Z").unwrap()
    }

    // tidal-device-login.test.tsx
    #[test]
    fn opens_the_page_and_reports_the_linked_account() {
        let mut s = TidalDeviceLogin::default();
        assert!(s.start());
        let started = s.started(Ok(flow()), now()).unwrap();
        assert_eq!(started.url, "https://link.tidal.com/ABCDE");
        assert_eq!(s.flow.as_ref().map(|f| f.flow_id.as_str()), Some("flow-1"));
        assert!(!s.starting);
        assert_eq!(started.poll.flow_id, "flow-1");
        assert_eq!(started.poll.options.timeout.as_millis(), 305_000);
        let outcome = s.poll_finished(started.poll.ticket, Ok(poll(TidalAuthState::Linked, Some("1234"), None)));
        assert_eq!(outcome, PollOutcome::Linked);
        assert!(s.flow.is_none());
        assert_eq!(s.notice.as_deref(), Some("TIDAL account 1234 linked."));
        assert_eq!(s.error, None);
    }

    #[test]
    fn reports_a_refused_sign_in() {
        let mut s = TidalDeviceLogin::default();
        s.start();
        let started = s.started(Ok(flow()), now()).unwrap();
        assert_eq!(s.poll_finished(started.poll.ticket, Ok(poll(TidalAuthState::Denied, None, None))), PollOutcome::Ended);
        assert_eq!(s.error.as_deref(), Some("TIDAL sign-in denied."));
        assert!(s.flow.is_none() && s.notice.is_none());
    }

    #[test]
    fn shows_why_a_login_cant_start() {
        let mut s = TidalDeviceLogin::default();
        s.start();
        assert!(s.started(Err(ApiError::http(503, "hifi-api unavailable")), now()).is_none());
        assert_eq!(s.error.as_deref(), Some("hifi-api unavailable"));
        assert!(!s.starting && s.flow.is_none());
    }

    #[test]
    fn keeps_waiting_when_the_page_didnt_open() {
        let mut s = TidalDeviceLogin::default();
        s.start();
        s.started(Ok(flow()), now()).unwrap();
        s.open_failed(Some("The browser blocked the authorization window."));
        assert_eq!(s.error.as_deref(), Some("The browser blocked the authorization window."));
        assert!(s.flow.is_some());
        s.open_failed(None);
        assert_eq!(s.error.as_deref(), Some("Could not open the TIDAL sign-in page."));
        assert_eq!(s.reopen().as_deref(), Some("https://link.tidal.com/ABCDE"));
        assert_eq!(s.error, None);
    }

    #[test]
    fn ignores_a_second_start() {
        let mut s = TidalDeviceLogin::default();
        assert!(s.start());
        assert!(!s.start());
        assert!(s.starting);
        s.started(Ok(flow()), now());
        assert!(!s.start());
    }

    #[test]
    fn a_closed_screen_ignores_the_late_answer() {
        let mut s = TidalDeviceLogin::default();
        s.start();
        let started = s.started(Ok(flow()), now()).unwrap();
        s.close();
        assert!(started.poll.cancel.is_cancelled());
        assert_eq!(
            s.poll_finished(started.poll.ticket, Ok(poll(TidalAuthState::Linked, Some("1"), None))),
            PollOutcome::Ignored
        );
        assert_eq!(s.notice, None);
    }

    #[test]
    fn a_deadline_is_a_failure() {
        let mut s = TidalDeviceLogin::default();
        s.start();
        let started = s.started(Ok(flow()), now()).unwrap();
        let timeout = ApiError { status: 0, message: "The request timed out.".into(), kind: crate::api::ErrorKind::Timeout };
        assert_eq!(s.poll_finished(started.poll.ticket, Err(timeout)), PollOutcome::Ended);
        assert_eq!(s.error.as_deref(), Some("Could not complete TIDAL sign-in."));
        assert!(s.flow.is_none());
    }

    #[test]
    fn unlinking() {
        let mut s = TidalDeviceLogin::default();
        assert!(s.unlink("acc-1"));
        assert!(!s.unlink("acc-2"));
        assert!(s.unlinked(Ok(())));
        assert_eq!(s.unlinking_id.as_deref(), Some("acc-1"));
        assert_eq!(s.notice.as_deref(), Some("TIDAL account unlinked."));
        s.unlink_settled();
        assert_eq!(s.unlinking_id, None);

        assert!(s.unlink("acc-1"));
        assert!(!s.unlinked(Err(ApiError::http(500, "internal error"))));
        assert_eq!(s.error.as_deref(), Some("internal error"));
        assert_eq!(s.notice, None);
        assert_eq!(s.unlinking_id, None);
        s.clear_error();
        assert_eq!(s.error, None);
    }
}
