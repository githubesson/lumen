//! Ten octave-spaced peaking filters, using the W3C Audio EQ Cookbook.
//! Controls cross the existing mixer command queue as a [`Tuning`], whose
//! pre-gain is worked out off the audio thread. Render allocates nothing;
//! coefficients and gain approach their targets over 20 ms, once per frame.
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

pub const FREQUENCIES: [f64; 10] = [
    31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];
pub const LABELS: [&str; 10] = [
    "31 Hz", "62 Hz", "125 Hz", "250 Hz", "500 Hz", "1 kHz", "2 kHz", "4 kHz", "8 kHz", "16 kHz",
];
pub const PRESETS: [(&str, [f32; 10]); 5] = [
    ("Flat", [0.0; 10]),
    (
        "Bass boost",
        [4.0, 3.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    ),
    (
        "Vocal",
        [-2.0, -2.0, -1.0, 0.0, 1.0, 2.0, 3.0, 2.0, 0.0, -1.0],
    ),
    (
        "Treble boost",
        [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 2.0, 3.0, 4.0],
    ),
    (
        "Warm",
        [2.0, 2.0, 1.0, 0.0, 0.0, 0.0, -1.0, -1.0, -2.0, -2.0],
    ),
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub bands: [f32; 10],
    pub preamp_db: f32,
}

impl Settings {
    pub fn sanitized(mut self) -> Self {
        fn safe(v: f32, lo: f32, hi: f32) -> f32 {
            if v.is_finite() { v.clamp(lo, hi) } else { 0.0 }
        }
        self.bands
            .iter_mut()
            .for_each(|v| *v = safe(*v, -12.0, 12.0));
        self.preamp_db = safe(self.preamp_db, -12.0, 0.0);
        self
    }

    pub fn preset(&self) -> &'static str {
        PRESETS
            .iter()
            .find(|(_, b)| b == &self.bands)
            .map_or("Custom", |(name, _)| *name)
    }

    /// The cut that keeps the cascade's loudest frequency at the preamp's level:
    /// the peak of its magnitude response, over a log-spaced grid from 20 Hz to
    /// 20 kHz plus each band's centre, at whichever of the common output rates
    /// peaks highest (the upper bands widen as the rate rises, so treble
    /// boosts overlap more at 96 and 192 kHz than at 48). Cuts alone need
    /// none. Sample peaks and crossfades can still exceed full scale; this is
    /// not a limiter.
    pub fn headroom_db(&self) -> f32 {
        let s = self.sanitized();
        if s.bands.iter().all(|db| *db <= 0.0) {
            return 0.0;
        }
        type HeadroomCache = OnceLock<Mutex<Option<([u32; 10], f32)>>>;
        let key = s.bands.map(f32::to_bits);
        static CACHE: HeadroomCache = OnceLock::new();
        let cache = CACHE.get_or_init(|| Mutex::new(None));
        if let Ok(guard) = cache.lock()
            && let Some((cached_key, cached_db)) = *guard
            && cached_key == key
        {
            return cached_db;
        }
        let grids = headroom_grids();
        let mut max_ratio = 1.0f64;
        for (idx, &rate) in HEADROOM_RATES.iter().enumerate() {
            max_ratio = max_ratio.max(s.peak_ratio(rate, &grids[idx]));
        }
        let db = if max_ratio > 1.0 { (10.0 * max_ratio.log10()) as f32 } else { 0.0 };
        if let Ok(mut guard) = cache.lock() {
            *guard = Some((key, db));
        }
        db
    }

    /// The cascade's loudest gain at `rate`, in dB, over the grid above.
    #[cfg(test)]
    fn peak_db(&self, rate: u32) -> f64 {
        let ratio = if let Some(idx) = HEADROOM_RATES.iter().position(|&r| r == rate) {
            self.peak_ratio(rate, &headroom_grids()[idx])
        } else {
            let grid = build_grid(rate);
            self.peak_ratio(rate, &grid)
        };
        if ratio > 1.0 { 10.0 * ratio.log10() } else { 0.0 }
    }

    /// Maximum squared magnitude ratio |H(e^jw)|^2 across the precomputed grid.
    fn peak_ratio(&self, rate: u32, grid: &[(f64, f64); HEADROOM_POINTS]) -> f64 {
        // Precompute the frequency-invariant quadratic terms per active band.
        let mut active = [(0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64); 10];
        let mut n_active = 0usize;
        for (i, &hz) in FREQUENCIES.iter().enumerate() {
            let c = peak(rate, hz, self.bands[i]);
            if c.0 == IDENTITY.0 {
                continue;
            }
            let [b0, b1, b2, a1, a2] = c.0;
            active[n_active] = (
                b0 * b0 + b1 * b1 + b2 * b2,
                2.0 * (b0 * b1 + b1 * b2),
                2.0 * b0 * b2,
                1.0 + a1 * a1 + a2 * a2,
                2.0 * (a1 + a1 * a2),
                2.0 * a2,
            );
            n_active += 1;
        }
        if n_active == 0 {
            return 1.0;
        }
        let bands = &active[..n_active];
        let mut max_ratio = 1.0f64;
        for &(c1, c2) in grid {
            let mut ratio = 1.0f64;
            for &(n0, n1, n2, d0, d1, d2) in bands {
                let num = n0 + n1 * c1 + n2 * c2;
                let den = d0 + d1 * c1 + d2 * c2;
                ratio *= num / den;
            }
            if ratio > max_ratio {
                max_ratio = ratio;
            }
        }
        max_ratio
    }
}

/// The output rates the headroom covers: the equalizer runs at the device's.
const HEADROOM_RATES: [u32; 4] = [44_100, 48_000, 96_000, 192_000];
const LOG_POINTS: usize = 512;
const HEADROOM_POINTS: usize = LOG_POINTS + 10;

fn build_grid(rate: u32) -> [(f64, f64); HEADROOM_POINTS] {
    let mut out = [(0.0f64, 0.0f64); HEADROOM_POINTS];
    for (i, slot) in out[..LOG_POINTS].iter_mut().enumerate() {
        let hz = 20.0 * 1000.0f64.powf(i as f64 / (LOG_POINTS - 1) as f64);
        let w = std::f64::consts::TAU * hz / rate as f64;
        *slot = (w.cos(), (2.0 * w).cos());
    }
    for (i, &hz) in FREQUENCIES.iter().enumerate() {
        let w = std::f64::consts::TAU * hz / rate as f64;
        out[LOG_POINTS + i] = (w.cos(), (2.0 * w).cos());
    }
    out
}

fn headroom_grids() -> &'static [[(f64, f64); HEADROOM_POINTS]; 4] {
    static GRIDS: OnceLock<[[(f64, f64); HEADROOM_POINTS]; 4]> = OnceLock::new();
    GRIDS.get_or_init(|| std::array::from_fn(|i| build_grid(HEADROOM_RATES[i])))
}

/// Settings and the pre-gain they need, worked out on the control side
/// (`Engine::set_equalizer`) so the audio thread only applies them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Tuning {
    pub settings: Settings,
    pub gain_db: f32,
}

impl Tuning {
    pub fn new(settings: Settings) -> Self {
        let settings = settings.sanitized();
        let gain_db = if settings.enabled {
            settings.preamp_db - settings.headroom_db()
        } else {
            0.0
        };
        Tuning { settings, gain_db }
    }
}

#[derive(Clone, Copy, Debug)]
struct Coeff([f64; 5]);
const IDENTITY: Coeff = Coeff([1.0, 0.0, 0.0, 0.0, 0.0]);

fn peak(rate: u32, hz: f64, db: f32) -> Coeff {
    // Never fold an unsupported band back into the audible range.
    if rate == 0 || hz >= rate as f64 * 0.49 || db == 0.0 {
        return IDENTITY;
    }
    let a = 10.0f64.powf(db as f64 / 40.0);
    let w = std::f64::consts::TAU * hz / rate as f64;
    let alpha = w.sin() / (2.0 * std::f64::consts::SQRT_2);
    let den = 1.0 + alpha / a;
    Coeff([
        (1.0 + alpha * a) / den,
        -2.0 * w.cos() / den,
        (1.0 - alpha * a) / den,
        -2.0 * w.cos() / den,
        (1.0 - alpha / a) / den,
    ])
}

/// The cascade's gain at `hz`, in dB: each biquad's |H(e^jw)|.
#[cfg(test)]
fn magnitude_db(cascade: &[Coeff; 10], rate: u32, hz: f64) -> f64 {
    let w = std::f64::consts::TAU * hz / rate as f64;
    let (c1, c2) = (w.cos(), (2.0 * w).cos());
    cascade
        .iter()
        .map(|Coeff([b0, b1, b2, a1, a2])| {
            let num = b0 * b0 + b1 * b1 + b2 * b2 + 2.0 * (b0 * b1 + b1 * b2) * c1 + 2.0 * b0 * b2 * c2;
            let den = 1.0 + a1 * a1 + a2 * a2 + 2.0 * (a1 + a1 * a2) * c1 + 2.0 * a2 * c2;
            10.0 * (num / den).log10()
        })
        .sum()
}

#[derive(Clone, Copy, Default)]
struct History {
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}
impl History {
    fn sample(&mut self, x: f64, c: Coeff) -> f64 {
        // A NaN or infinity would stay in the history and silence the band for good.
        let x = if x.is_finite() { x } else { 0.0 };
        let [b0, b1, b2, a1, a2] = c.0;
        let y = b0 * x + b1 * self.x1 + b2 * self.x2 - a1 * self.y1 - a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = if !y.is_finite() || y.abs() < 1e-30 { 0.0 } else { y };
        self.y1
    }
}

pub struct Equalizer {
    rate: u32,
    channels: usize,
    tuning: Tuning,
    coeff: [Coeff; 10],
    target: [Coeff; 10],
    /// Indices of bands whose coefficients are non-identity (or ramping).
    active: [usize; 10],
    active_len: usize,
    // Allocated on construction/output reconfiguration, never in process().
    history: Vec<[History; 10]>,
    gain: f64,
    target_gain: f64,
    remaining: u32,
    bypass: bool,
}

impl Equalizer {
    pub fn new(rate: u32, channels: usize) -> Self {
        Self {
            rate,
            channels: channels.max(1),
            tuning: Tuning::default(),
            coeff: [IDENTITY; 10],
            target: [IDENTITY; 10],
            active: [0; 10],
            active_len: 0,
            history: vec![[History::default(); 10]; channels.max(1)],
            gain: 1.0,
            target_gain: 1.0,
            remaining: 0,
            bypass: true,
        }
    }

    fn refresh_active(&mut self, include_target: bool) {
        let mut len = 0;
        for i in 0..10 {
            let active = self.coeff[i].0 != IDENTITY.0
                || (include_target && self.target[i].0 != IDENTITY.0);
            if active {
                self.active[len] = i;
                len += 1;
            }
        }
        self.active_len = len;
    }

    pub fn configure(&mut self, tuning: Tuning) {
        self.tuning = tuning;
        let settings = tuning.settings;
        self.target = std::array::from_fn(|i| {
            peak(
                self.rate,
                FREQUENCIES[i],
                if settings.enabled { settings.bands[i] } else { 0.0 },
            )
        });
        self.target_gain = 10.0f64.powf(tuning.gain_db as f64 / 20.0);
        self.remaining = (self.rate / 50).max(1);
        self.refresh_active(true);
        self.bypass = false;
    }

    pub fn reformat(&mut self, rate: u32, channels: usize) {
        let tuning = self.tuning;
        *self = Self::new(rate, channels);
        self.configure(tuning);
    }

    pub fn reset_history(&mut self) {
        self.history.fill([History::default(); 10]);
    }

    pub fn process(&mut self, samples: &mut [f32]) {
        if self.bypass {
            return;
        }
        let ch = self.channels;
        let mut rest = samples;
        if self.remaining > 0 {
            let ramp_frames = (rest.len() / ch).min(self.remaining as usize);
            let (ramp_slice, tail) = rest.split_at_mut(ramp_frames * ch);
            for frame in ramp_slice.chunks_exact_mut(ch) {
                let n = self.remaining as f64;
                for &b in &self.active[..self.active_len] {
                    let target = self.target[b].0;
                    for (c, t) in self.coeff[b].0.iter_mut().zip(target) {
                        *c += (t - *c) / n;
                    }
                }
                self.gain += (self.target_gain - self.gain) / n;
                self.remaining -= 1;
                let active = &self.active[..self.active_len];
                for (sample, history) in frame.iter_mut().zip(&mut self.history) {
                    let mut x = *sample as f64;
                    if active.is_empty() {
                        if !x.is_finite() {
                            x = 0.0;
                        }
                    } else {
                        for &b in active {
                            x = history[b].sample(x, self.coeff[b]);
                        }
                    }
                    *sample = (x * self.gain) as f32;
                }
            }
            if self.remaining == 0 {
                // Snap exact target coefficients so newly-flat bands drop out of `active`.
                self.coeff = self.target;
                self.gain = self.target_gain;
                self.refresh_active(false);
                // Clear history of bands that returned to identity so future ramps start clean.
                for i in 0..10 {
                    if self.coeff[i].0 == IDENTITY.0 {
                        for h in &mut self.history {
                            h[i] = History::default();
                        }
                    }
                }
                if self.target_gain == 1.0 && self.active_len == 0 {
                    self.bypass = true;
                    self.reset_history();
                    return;
                }
            }
            rest = tail;
        }
        if rest.is_empty() {
            return;
        }
        let active = &self.active[..self.active_len];
        let gain = self.gain;
        if active.is_empty() {
            if gain != 1.0 {
                for sample in rest.iter_mut() {
                    let x = *sample as f64;
                    *sample = if x.is_finite() { (x * gain) as f32 } else { 0.0 };
                }
            }
            return;
        }
        for frame in rest.chunks_exact_mut(ch) {
            for (sample, history) in frame.iter_mut().zip(&mut self.history) {
                let mut x = *sample as f64;
                for &b in active {
                    x = history[b].sample(x, self.coeff[b]);
                }
                *sample = (x * gain) as f32;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tone(rate: u32, hz: f64, frames: usize, channels: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|i| {
                std::iter::repeat_n(
                    (0.1 * (std::f64::consts::TAU * hz * i as f64 / rate as f64).sin()) as f32,
                    channels,
                )
            })
            .collect()
    }
    fn rms(s: &[f32]) -> f64 {
        (s.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / s.len() as f64).sqrt()
    }
    #[test]
    fn bypass_and_flat_preserve_samples() {
        let original = tone(48000, 997.0, 4800, 2);
        let mut data = original.clone();
        let mut eq = Equalizer::new(48000, 2);
        eq.process(&mut data);
        assert_eq!(data, original);
        eq.configure(Tuning::new(Settings {
            enabled: true,
            ..Settings::default()
        }));
        eq.process(&mut data);
        assert_eq!(data, original);
    }
    #[test]
    fn each_band_measures_requested_cut_at_center() {
        for rate in [44100, 48000, 96000] {
            for (i, hz) in FREQUENCIES.iter().enumerate() {
                let mut eq = Equalizer::new(rate, 2);
                let mut s = Settings {
                    enabled: true,
                    ..Settings::default()
                };
                s.bands[i] = -6.0;
                eq.configure(Tuning::new(s));
                let mut data = tone(rate, *hz, rate as usize, 2);
                let before = rms(&data[rate as usize..]);
                eq.process(&mut data);
                let db = 20.0 * (rms(&data[rate as usize..]) / before).log10();
                assert!((db + 6.0).abs() < 0.12, "{rate} {hz}: {db}");
            }
        }
    }
    #[test]
    fn boost_has_headroom_and_channels_do_not_leak() {
        let mut eq = Equalizer::new(48000, 2);
        let mut s = Settings {
            enabled: true,
            ..Settings::default()
        };
        s.bands[5] = 12.0;
        eq.configure(Tuning::new(s));
        let mut data = tone(48000, 1000.0, 48000, 2);
        for frame in data.chunks_mut(2) {
            frame[1] = 0.0;
        }
        eq.process(&mut data);
        assert!(data.chunks(2).all(|f| f[1] == 0.0));
        let left: Vec<_> = data[48000..].chunks(2).map(|f| f[0]).collect();
        assert!((rms(&left) - 0.1 / 2.0f64.sqrt()).abs() < 0.001);
    }
    #[test]
    fn changes_ramp_and_bypass_returns_to_exact_original() {
        let mut eq = Equalizer::new(48000, 1);
        eq.configure(Tuning::new(Settings {
            enabled: true,
            preamp_db: -12.0,
            ..Settings::default()
        }));
        let mut dc = vec![0.25; 2000];
        eq.process(&mut dc);
        assert!((dc[0] - 0.25).abs() < 0.001);
        assert!(dc.windows(2).all(|w| (w[1] - w[0]).abs() < 0.001));
        eq.configure(Tuning::default());
        eq.process(&mut dc);
        let original = tone(48000, 100.0, 1000, 1);
        let mut data = original.clone();
        eq.process(&mut data);
        assert_eq!(data, original);
    }
    #[test]
    fn headroom_follows_the_cascades_real_peak() {
        let flat = Settings {
            enabled: true,
            ..Settings::default()
        };
        assert_eq!(flat.headroom_db(), 0.0);
        assert_eq!(Tuning::new(flat).gain_db, 0.0);
        let cut = Settings {
            bands: [-12.0; 10],
            ..flat
        };
        assert_eq!(cut.headroom_db(), 0.0, "cuts need no headroom");
        let mut one = flat;
        one.bands[5] = 12.0;
        assert!((one.headroom_db() - 12.0).abs() < 0.01, "{}", one.headroom_db());
        // Every band at +12: neighbouring bands overlap to about +18 dB, not 120.
        let all = Settings {
            bands: [12.0; 10],
            ..flat
        };
        let db = all.headroom_db();
        assert!((17.0..20.0).contains(&db), "{db}");
        for (name, bands) in PRESETS {
            let db = Settings { bands, ..flat }.headroom_db();
            let loudest = bands.iter().fold(0.0f32, |m, b| m.max(*b));
            assert!(db >= loudest - 0.01 && db < loudest + 3.0, "{name}: {db}");
        }
    }
    #[test]
    fn treble_boosts_have_headroom_at_high_rates() {
        let flat = Settings {
            enabled: true,
            ..Settings::default()
        };
        let mut highs = flat;
        highs.bands[8] = 12.0;
        highs.bands[9] = 12.0;
        let treble = Settings { bands: PRESETS[3].1, ..flat };
        for s in [highs, treble] {
            let gain_db = Tuning::new(s).gain_db as f64;
            // The upper bands are wider at 96 and 192 kHz, so they peak higher there.
            assert!(s.peak_db(192_000) > s.peak_db(48_000) + 0.3, "{s:?}");
            for rate in HEADROOM_RATES {
                let cascade: [Coeff; 10] = std::array::from_fn(|i| peak(rate, FREQUENCIES[i], s.bands[i]));
                for i in 0..2000 {
                    let hz = 20.0 * 1000.0f64.powf(i as f64 / 1999.0);
                    let db = magnitude_db(&cascade, rate, hz) + gain_db;
                    assert!(db < 0.01, "{rate} {hz}: {db}");
                }
            }
        }
        // And measured: a tone at the 192 kHz cascade's loudest frequency
        // comes out no louder than it went in.
        let rate = 192_000;
        let cascade: [Coeff; 10] = std::array::from_fn(|i| peak(rate, FREQUENCIES[i], highs.bands[i]));
        let hz = (0..2000)
            .map(|i| 4000.0 * 5.0f64.powf(i as f64 / 1999.0))
            .max_by(|a, b| magnitude_db(&cascade, rate, *a).total_cmp(&magnitude_db(&cascade, rate, *b)))
            .unwrap();
        let mut eq = Equalizer::new(rate, 1);
        eq.configure(Tuning::new(highs));
        let mut data = tone(rate, hz, rate as usize, 1);
        let before = rms(&data[rate as usize / 2..]);
        eq.process(&mut data);
        let db = 20.0 * (rms(&data[rate as usize / 2..]) / before).log10();
        assert!((-0.5..0.05).contains(&db), "{hz}: {db}");
    }
    #[test]
    fn every_band_boosted_stays_audible() {
        let mut eq = Equalizer::new(48000, 2);
        eq.configure(Tuning::new(Settings {
            enabled: true,
            bands: [12.0; 10],
            preamp_db: 0.0,
        }));
        for hz in [62.0, 1000.0, 8000.0] {
            let mut data = tone(48000, hz, 48000, 2);
            let before = rms(&data[48000..]);
            eq.process(&mut data);
            let db = 20.0 * (rms(&data[48000..]) / before).log10();
            assert!((-3.0..0.1).contains(&db), "{hz}: {db}");
        }
    }
    #[test]
    fn a_non_finite_sample_does_not_stick() {
        let mut eq = Equalizer::new(48000, 1);
        let mut s = Settings {
            enabled: true,
            ..Settings::default()
        };
        s.bands[2] = 6.0;
        eq.configure(Tuning::new(s));
        let mut data = tone(48000, 125.0, 4800, 1);
        data[100] = f32::NAN;
        data[200] = f32::INFINITY;
        eq.process(&mut data);
        assert!(data.iter().all(|s| s.is_finite()));
        assert!(rms(&data[2400..]) > 0.05);
    }
    #[test]
    fn malformed_settings_and_low_rate_remain_finite() {
        let mut eq = Equalizer::new(8000, 6);
        let mut s = Settings {
            enabled: true,
            bands: [120.0; 10],
            preamp_db: f32::NAN,
        };
        s.bands[0] = f32::INFINITY;
        eq.configure(Tuning::new(s));
        let mut data = tone(8000, 100.0, 8000, 6);
        eq.process(&mut data);
        assert!(data.iter().all(|s| s.is_finite()));
        eq.reformat(96000, 2);
        let mut data = tone(96000, 16000.0, 2000, 2);
        eq.process(&mut data);
        assert!(data.iter().all(|s| s.is_finite()));
        let old: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(old, Settings::default());
        assert_eq!(
            serde_json::from_str::<Settings>(&serde_json::to_string(&s.sanitized()).unwrap())
                .unwrap(),
            s.sanitized()
        );
    }

    #[test]
    fn fast_headroom_matches_reference_sweep() {
        fn reference_headroom_db(s: Settings) -> f32 {
            let s = s.sanitized();
            if !s.enabled || s.bands.iter().all(|&g| g <= 0.0) {
                return 0.0;
            }
            let mut max_db = 0.0f64;
            for rate in HEADROOM_RATES {
                let filters: [Coeff; 10] = std::array::from_fn(|i| peak(rate, FREQUENCIES[i], s.bands[i]));
                let log_freqs = (0..LOG_POINTS).map(|i| 20.0 * 1000.0f64.powf(i as f64 / (LOG_POINTS - 1) as f64));
                for hz in log_freqs.chain(FREQUENCIES) {
                    let db = magnitude_db(&filters, rate, hz);
                    if db > max_db {
                        max_db = db;
                    }
                }
            }
            max_db as f32
        }
        let cases: &[[f32; 10]] = &[
            [0.0; 10],
            [6.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 12.0],
            [-6.0, -3.0, 0.0, -4.0, -12.0, 0.0, 0.0, -1.0, -2.0, -6.0],
            [12.0; 10],
            [6.0, 4.5, 2.0, -1.5, -3.0, 1.0, 3.5, 5.0, 4.0, 2.5],
            [-12.0, 12.0, -12.0, 12.0, -12.0, 12.0, -12.0, 12.0, -12.0, 12.0],
            [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0],
            [8.0, 8.0, 0.0, 0.0, -6.0, -6.0, 0.0, 0.0, 9.0, 9.0],
        ];
        for &bands in cases {
            let s = Settings { enabled: true, bands, preamp_db: 0.0 };
            let got = s.headroom_db();
            let expected = reference_headroom_db(s);
            assert!(
                (got - expected).abs() < 1e-4,
                "headroom mismatch for {bands:?}: got {got}, expected {expected}"
            );
            // Second call hits the cache and must return the exact same bits.
            assert_eq!(s.headroom_db().to_bits(), got.to_bits());
        }
    }

    #[test]
    fn active_band_skipping_matches_full_chain() {
        let mut s = Settings { enabled: true, bands: [0.0; 10], preamp_db: -2.0 };
        s.bands[1] = 5.0;
        s.bands[6] = -4.0;
        let tuning = Tuning::new(s);
        let mut eq = Equalizer::new(48_000, 2);
        eq.configure(tuning);
        let mut input: Vec<f32> = (0..4000)
            .flat_map(|i| {
                let l = (0.2 * (std::f64::consts::TAU * 62.0 * i as f64 / 48_000.0).sin()
                    + 0.15 * (std::f64::consts::TAU * 2000.0 * i as f64 / 48_000.0).sin()) as f32;
                let r = (0.15 * (std::f64::consts::TAU * 500.0 * i as f64 / 48_000.0).cos()) as f32;
                [l, r]
            })
            .collect();
        let mut got = input.clone();
        eq.process(&mut got);

        // Naive reference: run all 10 biquads on every sample with the same ramp.
        let mut coeff = [IDENTITY; 10];
        let target: [Coeff; 10] = std::array::from_fn(|i| peak(48_000, FREQUENCIES[i], s.bands[i]));
        let mut gain = 1.0f64;
        let target_gain = 10.0f64.powf(tuning.gain_db as f64 / 20.0);
        let mut rem = 48_000 / 50;
        let mut hist = [[History::default(); 10]; 2];
        for frame in input.as_chunks_mut::<2>().0 {
            if rem > 0 {
                let n = rem as f64;
                for i in 0..10 {
                    for (c, t) in coeff[i].0.iter_mut().zip(target[i].0) {
                        *c += (t - *c) / n;
                    }
                }
                gain += (target_gain - gain) / n;
                rem -= 1;
            }
            for (sample, h) in frame.iter_mut().zip(&mut hist) {
                let mut x = *sample as f64;
                for i in 0..10 {
                    x = h[i].sample(x, coeff[i]);
                }
                *sample = (x * gain) as f32;
            }
        }
        let max_err = got.iter().zip(&input).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(max_err < 1e-6, "active-band skipping diverged by {max_err}");
    }
}
