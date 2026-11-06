//! Last.fm scrobbling (`getLastFMStatus`, `connectLastFM`,
//! `waitForLastFMAuthorization`, `disconnectLastFM`). The settings row's
//! state machine is `core::lastfm`.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::client::{ApiError, ApiResult, Cancel, Client};
use super::tidal::PollOptions;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct LastFmStatus {
    #[serde(default)]
    pub configured: bool,
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct LastFmConnectResponse {
    pub authorization_url: String,
}

#[derive(Deserialize)]
struct Completed {
    #[serde(default)]
    username: String,
}

pub fn get_lastfm_status(c: &Client) -> ApiResult<LastFmStatus> {
    c.get("/api/integrations/lastfm")
}

/// Start connecting: the page where the user approves Lumen.
pub fn connect_lastfm(c: &Client) -> ApiResult<LastFmConnectResponse> {
    c.post_empty("/api/integrations/lastfm/connect")
}

pub fn disconnect_lastfm(c: &Client) -> ApiResult<()> {
    c.delete_void("/api/integrations/lastfm")
}

/// The default polling for [`wait_for_lastfm_authorization`]: every 3 s for
/// up to 10 minutes.
pub fn default_lastfm_poll() -> PollOptions {
    PollOptions::new(3000, None)
}

/// `waitForLastFMAuthorization`: ask the server to finish the connection
/// until the user has approved it (409 means not yet). The connected
/// username, a 408 at the deadline, or [`ApiError::aborted`].
pub fn wait_for_lastfm_authorization(c: &Client, options: PollOptions, cancel: &Cancel) -> ApiResult<String> {
    let deadline = Instant::now() + options.timeout;
    loop {
        cancel.check()?;
        match c.post_empty::<Completed>("/api/integrations/lastfm/complete") {
            Ok(done) => return Ok(done.username),
            Err(e) if e.has_status(409) => {}
            Err(e) => return Err(e),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ApiError::local(408, "Timed out waiting for Last.fm authorization. You can try again."));
        }
        if !cancel.sleep(options.interval.min(remaining)) {
            return Err(ApiError::aborted());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::testing::{MockServer, Res};

    #[test]
    fn waits_through_409s_until_approved() {
        let server = MockServer::start(vec![
            Res::new(409).body("pending"),
            Res::json(r#"{"username":"listener"}"#),
        ]);
        let name = wait_for_lastfm_authorization(&server.client(), PollOptions::new(500, None), &Cancel::new()).unwrap();
        assert_eq!(name, "listener");
        assert_eq!(server.requests().len(), 2);
    }

    #[test]
    fn other_failures_end_the_wait() {
        let server = MockServer::start(vec![Res::new(500).body("boom")]);
        let err = wait_for_lastfm_authorization(&server.client(), PollOptions::new(500, None), &Cancel::new()).unwrap_err();
        assert_eq!((err.status, err.message.as_str()), (500, "boom"));
    }

    #[test]
    fn times_out_with_a_408() {
        let server = MockServer::start(vec![Res::new(409)]);
        let err =
            wait_for_lastfm_authorization(&server.client(), PollOptions::new(500, Some(500)), &Cancel::new()).unwrap_err();
        assert_eq!(err.status, 408);
        assert_eq!(err.message, "Timed out waiting for Last.fm authorization. You can try again.");
    }
}
