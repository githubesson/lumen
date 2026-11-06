//! The web's `lib/replayData.ts`: a Replay period's numbers as the Replay
//! page and Home's period panels load and cache them, so either warms the
//! other. Asked for by day; an all-time series the server cut short is
//! asked for again by month, cached under its own key.

use std::collections::HashMap;

use crate::api::stats::{ReplayData, get_replay};
use crate::api::{ApiResult, Client};

use super::figures::{ReplayQueries, ReplayQuery, replay_series_complete};

/// Where the Replay page remembers which past years have plays (its pills).
pub const REPLAY_YEARS_KEY: &str = "replay:years";

/// The answers by cache key, and the years with plays (the web keeps both
/// in its resource cache).
#[derive(Clone, Debug, Default)]
pub struct ReplayCache {
    entries: HashMap<String, ReplayData>,
    years: Option<Vec<i32>>,
}

impl ReplayCache {
    pub fn get(&self, key: &str) -> Option<&ReplayData> {
        self.entries.get(key)
    }

    /// The years with plays from the last answer, if any came.
    pub fn years(&self) -> Option<&[i32]> {
        self.years.as_deref()
    }

    /// `readReplayCache`: the period's last answer, by day or by month.
    pub fn read(&self, request: &ReplayQueries) -> Option<&ReplayData> {
        self.get(&request.daily.cache_key)
            .or_else(|| request.monthly.as_ref().and_then(|m| self.get(&m.cache_key)))
    }

    /// Whether all time already came back by month (ask by month at once).
    pub fn has_monthly(&self, request: &ReplayQueries) -> bool {
        request.monthly.as_ref().is_some_and(|m| self.entries.contains_key(&m.cache_key))
    }

    /// `storeReplay`: one answer per period, under the key of the query that
    /// gave it; also notes the years with plays.
    pub fn store(&mut self, request: &ReplayQueries, query: &ReplayQuery, data: ReplayData) {
        let other = if *query == request.daily { request.monthly.as_ref() } else { Some(&request.daily) };
        if let Some(o) = other {
            self.entries.remove(&o.cache_key);
        }
        self.years = Some(data.available_years.clone());
        self.entries.insert(query.cache_key.clone(), data);
    }
}

/// `fetchReplay`: by day, falling back to by month when an all-time series
/// came back cut short (or straight away when `monthly_known`). Says which
/// query answered.
pub fn fetch_replay(c: &Client, request: &ReplayQueries, monthly_known: bool) -> ApiResult<(ReplayQuery, ReplayData)> {
    if let Some(m) = request.monthly.as_ref().filter(|_| monthly_known) {
        return Ok((m.clone(), get_replay(c, &m.params)?));
    }
    let data = get_replay(c, &request.daily.params)?;
    match &request.monthly {
        Some(m) if !replay_series_complete(data.summary.total_plays, &data.activity) => {
            Ok((m.clone(), get_replay(c, &m.params)?))
        }
        _ => Ok((request.daily.clone(), data)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::testing::{MockServer, Res};
    use crate::core::replay::figures::replay_queries;
    use crate::core::replay::period::Period;

    fn body(total: u64, plays: u64) -> String {
        format!(
            r#"{{"summary":{{"total_plays":{total},"total_ms":0,"unique_tracks":0,"unique_artists":0}},"top_tracks":[],"top_artists":[],
            "top_albums":[],"top_genres":[],"activity":[{{"bucket_start":"2026-01-01T00:00:00Z","plays":{plays}}}],"bucket":"day","available_years":[2025]}}"#
        )
    }

    #[test]
    fn falls_back_to_months_for_a_cut_short_history() {
        let server = MockServer::start(vec![Res::json(&body(10, 4)), Res::json(&body(10, 10))]);
        let q = replay_queries(Period::All, 0);
        let (query, data) = fetch_replay(&server.client(), &q, false).unwrap();
        assert_eq!(query, q.monthly.clone().unwrap());
        assert_eq!(data.summary.total_plays, 10);
        let reqs = server.requests();
        assert!(reqs[0].path.contains("bucket=day") && reqs[1].path.contains("bucket=month"));

        let mut cache = ReplayCache::default();
        cache.store(&q, &query, data);
        assert!(cache.has_monthly(&q) && cache.read(&q).is_some());
        assert_eq!(cache.years(), Some(&[2025][..]));
        // A later daily answer replaces the monthly one.
        cache.store(&q, &q.daily, ReplayData::default());
        assert!(!cache.has_monthly(&q));
    }

    #[test]
    fn keeps_a_complete_daily_answer() {
        let server = MockServer::start(vec![Res::json(&body(4, 4))]);
        let q = replay_queries(Period::Year(2025), 0);
        let (query, _) = fetch_replay(&server.client(), &q, false).unwrap();
        assert_eq!(query, q.daily);
        assert_eq!(server.requests().len(), 1);
    }
}
