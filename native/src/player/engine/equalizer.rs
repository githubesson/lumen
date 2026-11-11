//! Ten octave-spaced peaking filters, using the W3C Audio EQ Cookbook.
//! Controls cross the existing mixer command queue. Render allocates nothing;
//! coefficients and gain approach their targets over 20 ms, once per frame.
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

    /// Conservative headroom for the entire cascade, not just its loudest band.
    /// Original sample peaks/crossfades can still exceed full scale; this is not a limiter.
    pub fn headroom_db(&self) -> f32 {
        self.sanitized().bands.iter().map(|v| v.max(0.0)).sum()
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

#[derive(Clone, Copy, Default)]
struct History {
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}
impl History {
    fn sample(&mut self, x: f64, c: Coeff) -> f64 {
        let [b0, b1, b2, a1, a2] = c.0;
        let y = b0 * x + b1 * self.x1 + b2 * self.x2 - a1 * self.y1 - a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = if y.abs() < 1e-30 { 0.0 } else { y };
        self.y1
    }
}

pub struct Equalizer {
    rate: u32,
    channels: usize,
    settings: Settings,
    coeff: [Coeff; 10],
    target: [Coeff; 10],
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
            settings: Settings::default(),
            coeff: [IDENTITY; 10],
            target: [IDENTITY; 10],
            history: vec![[History::default(); 10]; channels.max(1)],
            gain: 1.0,
            target_gain: 1.0,
            remaining: 0,
            bypass: true,
        }
    }

    pub fn configure(&mut self, settings: Settings) {
        self.settings = settings.sanitized();
        self.target = std::array::from_fn(|i| {
            peak(
                self.rate,
                FREQUENCIES[i],
                if self.settings.enabled {
                    self.settings.bands[i]
                } else {
                    0.0
                },
            )
        });
        let db = if self.settings.enabled {
            self.settings.preamp_db - self.settings.headroom_db()
        } else {
            0.0
        };
        self.target_gain = 10.0f64.powf(db as f64 / 20.0);
        self.remaining = (self.rate / 50).max(1);
        self.bypass = false;
    }

    pub fn reformat(&mut self, rate: u32, channels: usize) {
        let settings = self.settings;
        *self = Self::new(rate, channels);
        self.configure(settings);
    }

    pub fn reset_history(&mut self) {
        self.history.fill([History::default(); 10]);
    }

    pub fn process(&mut self, samples: &mut [f32]) {
        if self.bypass {
            return;
        }
        for frame in samples.chunks_exact_mut(self.channels) {
            if self.remaining > 0 {
                let n = self.remaining as f64;
                for (current, target) in self.coeff.iter_mut().zip(self.target) {
                    for (c, t) in current.0.iter_mut().zip(target.0) {
                        *c += (t - *c) / n;
                    }
                }
                self.gain += (self.target_gain - self.gain) / n;
                self.remaining -= 1;
            }
            for (sample, history) in frame.iter_mut().zip(&mut self.history) {
                let mut x = *sample as f64;
                for (state, c) in history.iter_mut().zip(self.coeff) {
                    x = state.sample(x, c);
                }
                *sample = (x * self.gain) as f32;
            }
        }
        if self.remaining == 0
            && self.target_gain == 1.0
            && self.target.iter().all(|c| c.0 == IDENTITY.0)
        {
            self.bypass = true;
            self.reset_history();
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
        eq.configure(Settings {
            enabled: true,
            ..Settings::default()
        });
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
                eq.configure(s);
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
        eq.configure(s);
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
        eq.configure(Settings {
            enabled: true,
            preamp_db: -12.0,
            ..Settings::default()
        });
        let mut dc = vec![0.25; 2000];
        eq.process(&mut dc);
        assert!((dc[0] - 0.25).abs() < 0.001);
        assert!(dc.windows(2).all(|w| (w[1] - w[0]).abs() < 0.001));
        eq.configure(Settings::default());
        eq.process(&mut dc);
        let original = tone(48000, 100.0, 1000, 1);
        let mut data = original.clone();
        eq.process(&mut data);
        assert_eq!(data, original);
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
        eq.configure(s);
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
}
