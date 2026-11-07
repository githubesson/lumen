//! The local player's side of the adapter's events (`use-player-core.ts`'s
//! listeners) and its 250 ms tick (`timeupdate` and the clock sampler).

use super::*;

impl LocalPlayer {
    /// Drain the adapter's events and handle each.
    pub fn pump_events(&mut self) -> bool {
        let mut any = false;
        while let Some(event) = self.adapter.next_event() {
            self.handle(event);
            any = true;
        }
        any
    }

    pub fn handle(&mut self, event: AdapterEvent) {
        match event {
            AdapterEvent::LoadedMetadata => {
                self.duration = self.adapter.duration();
                self.current_time = quantize_time(self.adapter.current_time(), self.adapter.duration());
                self.publish_hint = true;
            }
            AdapterEvent::Ended => {
                // A selection that replaced the ended track loads on its own.
                if let Some(cur) = &self.current
                    && self.loaded_track_id.as_deref() != Some(cur.id.as_str())
                {
                    return;
                }
                if self.repeat == Repeat::One {
                    // Each loop is a fresh play and listen.
                    self.playback_reported = None;
                    self.reset_listening();
                    if let Some(cur) = &self.current {
                        self.effects.push(Effect::NowPlaying { track_id: cur.id.clone() });
                    }
                    self.adapter.seek(0.0);
                    self.start_playback();
                } else {
                    self.advance(0.0);
                }
            }
            AdapterEvent::Seeked => {
                self.current_time = quantize_time(self.adapter.current_time(), self.adapter.duration());
                self.publish_hint = true;
            }
            AdapterEvent::Play => {
                self.listening_tick = Some(self.clock.mono());
                self.is_playing = true;
            }
            AdapterEvent::Pause => {
                self.sync_listened_time();
                self.listening_tick = None;
                self.current_time = quantize_time(self.adapter.current_time(), self.adapter.duration());
                self.playback_attempt += 1;
                self.is_playing = false;
            }
            AdapterEvent::Error => self.on_error(),
        }
        self.commit();
    }

    fn sync_listened_time(&mut self) {
        let now = self.clock.mono();
        if let Some(previous) = self.listening_tick
            && self.is_playing
        {
            self.listened_seconds += (now - previous).max(0.0);
        }
        self.listening_tick = self.is_playing.then_some(now);
    }

    /// The `error` handler: stop on the failed track (playing it again
    /// retries), say so at once, and ask the server why.
    fn on_error(&mut self) {
        self.playback_attempt += 1;
        self.is_playing = false;
        let Some(track) = self.current.clone() else { return };
        self.next_token += 1;
        let token = self.next_token;
        self.failure = Some(Failure { track_id: track.id.clone(), token });
        let uri = match (&self.loaded_track_id, &self.loaded_uri) {
            (Some(id), Some(uri)) if *id == track.id => uri.clone(),
            _ => self.stream_url(&track.id),
        };
        let url = self.stream_url(&track.id);
        let streamed = uri == url;
        self.error = Some(PlaybackError {
            track_id: track.id.clone(),
            summary: PLAYBACK_ERROR_FALLBACK.into(),
            details: PlaybackErrorDetails {
                at_ms: self.clock.unix_ms(),
                source: failed_source(&uri),
                player: detail_line(self.adapter.error_detail().as_deref()),
                server: if streamed { ServerAnswer::Asking } else { ServerAnswer::NotAsked },
            },
        });
        self.probe = None;
        if streamed {
            self.probe = Some(token);
            let tidal = is_tidal_track(&track);
            self.effects.push(Effect::Probe { token, url, first_byte: !tidal, tidal });
        }
    }

    /// A probe's answer: replaces the failure's message while it's still the
    /// same failure. Only TIDAL streams fail for a reason worth the bar.
    pub fn probe_done(&mut self, token: u64, tidal: bool, probe: StreamProbe) {
        if self.probe != Some(token) {
            return;
        }
        self.probe = None;
        if self.failure.as_ref().is_some_and(|f| f.token == token)
            && let Some(error) = &mut self.error
        {
            error.summary = match probe.reason {
                Some(reason) if tidal => reason,
                _ => PLAYBACK_ERROR_FALLBACK.into(),
            };
            error.details.server = ServerAnswer::Answered(probe.answer);
        }
    }

    /// The 250 ms tick while playing (the web's `timeupdate` and its clock
    /// sampler): advance the clock, prepare the next track, report plays and
    /// scrobbles, and start smooth mix's fade. True when the clock moved.
    pub fn tick(&mut self) -> bool {
        if !self.is_playing {
            return false;
        }
        self.sync_listened_time();
        let now = self.adapter.current_time();
        let d = self.adapter.duration();
        // The next entry's place: nothing below changes the queue.
        let next = self.next_to_prepare();
        if let Some(i) = next
            && d > 0.0
            && now / d >= NEXT_TRACK_PREPARE_RATIO
            && self.prepared_next.as_ref().map(|p| &p.0) != Some(&self.queue[i].id)
        {
            let id = self.queue[i].id.clone();
            let uri = self.stream_url(&id);
            self.prepared_next = Some((id, uri.clone()));
            self.adapter.prepare_next(&uri);
        }
        if let Some(cur) = &self.current
            && self.playback_reported.as_ref() != Some(&cur.id)
            && should_report_play(now, d)
        {
            self.playback_reported = Some(cur.id.clone());
            let completion = if d > 0.0 { now / d } else { 0.0 };
            self.effects.push(Effect::RecordPlay { track_id: cur.id.clone(), completion });
        }
        let threshold = if d > 0.0 { (d / 2.0).min(240.0) } else { f64::INFINITY };
        if let Some(cur) = &self.current
            && d > 30.0
            && self.listened_seconds >= threshold
            && self.lastfm_scrobbled.as_ref() != Some(&cur.id)
        {
            self.lastfm_scrobbled = Some(cur.id.clone());
            self.effects.push(Effect::Scrobble {
                track_id: cur.id.clone(),
                started_at: self.track_started_at,
                listened_seconds: self.listened_seconds,
            });
        }
        // Smooth mix: start the next track before this one ends, so the fade
        // ends with it. A short next song fades in over half its length at most.
        let fade = self.crossfade_seconds;
        let remaining = d - now;
        if let (Some(cur), Some(next)) = (&self.current, next.map(|i| &self.queue[i])) {
            let next_seconds = next.duration_ms as f64 / 1000.0;
            let fade_length = if next_seconds > 0.0 { fade.min(next_seconds / 2.0) } else { fade };
            if fade > 0.0
                && self.prepared_next.as_ref().map(|p| &p.0) == Some(&next.id)
                && d > 0.0
                && remaining <= fade_length
                && remaining >= MIN_CROSSFADE_SEC
                && !continues_album(cur, next)
            {
                self.advance(remaining);
            }
        }
        let before = self.current_time;
        if self.is_playing {
            self.current_time = quantize_time(self.adapter.current_time(), self.adapter.duration());
        }
        self.commit();
        self.current_time != before
    }
}
