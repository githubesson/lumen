//! A decoded stream on its way to the output: its channels mapped to the
//! output's and its rate converted (rubato's FFT resampler, which suits
//! the fixed integer ratios of audio rates), as a browser does for any
//! source whose rate isn't the device's.

use rubato::{FftFixedIn, Resampler as _};

use super::OutFormat;

/// Channel mapping, then resampling, for one source format.
pub struct Pipeline {
    src_channels: usize,
    src_rate: u32,
    out: OutFormat,
    mapped: Vec<f32>,
    resampler: Option<Resampler>,
    buf: Vec<f32>,
}

impl Pipeline {
    pub fn new(src_rate: u32, src_channels: usize, out: OutFormat) -> Pipeline {
        let resampler = (src_rate != out.rate).then(|| Resampler::new(src_rate, out.rate, out.channels));
        Pipeline { src_channels: src_channels.max(1), src_rate, out, mapped: Vec::new(), resampler, buf: Vec::new() }
    }

    pub fn matches(&self, src_rate: u32, src_channels: usize, out: OutFormat) -> bool {
        self.src_rate == src_rate && self.src_channels == src_channels.max(1) && self.out == out
    }

    /// Convert interleaved source samples; the output is interleaved at the output format.
    pub fn process(&mut self, input: &[f32]) -> &[f32] {
        map_channels(input, self.src_channels, self.out.channels, &mut self.mapped);
        match &mut self.resampler {
            None => &self.mapped,
            Some(r) => {
                self.buf.clear();
                r.push(&self.mapped, &mut self.buf);
                &self.buf
            }
        }
    }

    /// The resampler's tail, at the end of the stream.
    pub fn flush(&mut self) -> &[f32] {
        self.buf.clear();
        if let Some(r) = &mut self.resampler {
            r.flush(&mut self.buf);
        }
        &self.buf
    }
}

/// `input` (interleaved, `from` channels) as `to` channels. Mono plays on
/// both front speakers; surround folds down to stereo (ITU, LFE dropped).
pub fn map_channels(input: &[f32], from: usize, to: usize, out: &mut Vec<f32>) {
    out.clear();
    let frames = input.len() / from;
    out.reserve(frames * to);
    if from == to {
        out.extend_from_slice(&input[..frames * from]);
        return;
    }
    const H: f32 = std::f32::consts::FRAC_1_SQRT_2;
    for f in input.chunks_exact(from) {
        match (from, to) {
            (1, _) => {
                out.push(f[0]);
                if to > 1 {
                    out.push(f[0]);
                }
                out.extend(std::iter::repeat_n(0.0, to.saturating_sub(2)));
            }
            (2, 1) => out.push((f[0] + f[1]) * 0.5),
            (_, 1) => out.push(f.iter().sum::<f32>() / from as f32),
            (_, 2) => {
                // FL FR FC LFE BL BR (SL SR): the WAV/FLAC order.
                let c = f.get(2).copied().unwrap_or(0.0);
                let (bl, br) = (f.get(4).copied().unwrap_or(0.0), f.get(5).copied().unwrap_or(0.0));
                let (sl, sr) = (f.get(6).copied().unwrap_or(0.0), f.get(7).copied().unwrap_or(0.0));
                let norm = 1.0 / (1.0 + H + H);
                out.push((f[0] + H * c + H * (bl + sl)) * norm);
                out.push((f[1] + H * c + H * (br + sr)) * norm);
            }
            _ => {
                // More speakers than the source has: the source's channels
                // in order, silence on the rest.
                for i in 0..to {
                    out.push(f.get(i).copied().unwrap_or(0.0));
                }
            }
        }
    }
}

/// A streaming wrapper over rubato: any number of frames in, the matching
/// frames out, with the resampler's delay removed and its tail flushed.
pub struct Resampler {
    inner: FftFixedIn<f32>,
    channels: usize,
    pending: Vec<Vec<f32>>,
    out: Vec<Vec<f32>>,
    /// Leading frames still to drop (the filter's delay).
    delay: usize,
    in_frames: u64,
    out_frames: u64,
    ratio: f64,
}

impl Resampler {
    pub fn new(from: u32, to: u32, channels: usize) -> Resampler {
        let inner = FftFixedIn::<f32>::new(from as usize, to as usize, 1024, 2, channels).expect("valid sample rates");
        let delay = inner.output_delay();
        let out = vec![vec![0.0; inner.output_frames_max()]; channels];
        Resampler {
            inner,
            channels,
            pending: vec![Vec::new(); channels],
            out,
            delay,
            in_frames: 0,
            out_frames: 0,
            ratio: to as f64 / from as f64,
        }
    }

    pub fn push(&mut self, interleaved: &[f32], dst: &mut Vec<f32>) {
        let frames = interleaved.len() / self.channels;
        for f in interleaved.chunks_exact(self.channels) {
            for (c, s) in f.iter().enumerate() {
                self.pending[c].push(*s);
            }
        }
        self.in_frames += frames as u64;
        loop {
            let need = self.inner.input_frames_next();
            if self.pending[0].len() < need {
                break;
            }
            let Ok((used, written)) = self.inner.process_into_buffer(&self.pending, &mut self.out, None) else { break };
            for ch in &mut self.pending {
                ch.drain(..used);
            }
            self.emit(written, dst, u64::MAX);
        }
    }

    pub fn flush(&mut self, dst: &mut Vec<f32>) {
        let expected = (self.in_frames as f64 * self.ratio).round() as u64;
        let mut guard = 0;
        while self.out_frames < expected && guard < 64 {
            guard += 1;
            let input = (!self.pending[0].is_empty()).then_some(&self.pending[..]);
            let Ok((used, written)) = self.inner.process_partial_into_buffer(input, &mut self.out, None) else { break };
            for ch in &mut self.pending {
                let n = used.min(ch.len());
                ch.drain(..n);
            }
            self.emit(written, dst, expected);
        }
        for ch in &mut self.pending {
            ch.clear();
        }
    }

    fn emit(&mut self, written: usize, dst: &mut Vec<f32>, limit: u64) {
        let skip = self.delay.min(written);
        self.delay -= skip;
        let room = limit.saturating_sub(self.out_frames) as usize;
        let take = (written - skip).min(room);
        for i in skip..skip + take {
            for c in 0..self.channels {
                dst.push(self.out[c][i]);
            }
        }
        self.out_frames += take as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_channels() {
        let mut out = Vec::new();
        map_channels(&[0.5, -0.5], 1, 2, &mut out);
        assert_eq!(out, [0.5, 0.5, -0.5, -0.5]);
        map_channels(&[1.0, 0.0], 2, 1, &mut out);
        assert_eq!(out, [0.5]);
        map_channels(&[0.1, 0.2], 2, 4, &mut out);
        assert_eq!(out, [0.1, 0.2, 0.0, 0.0]);
        map_channels(&[1.0, 1.0, 0.0, 9.0, 0.0, 0.0], 6, 2, &mut out);
        let n = 1.0 / (1.0 + std::f32::consts::SQRT_2);
        assert!((out[0] - n).abs() < 1e-6 && (out[1] - n).abs() < 1e-6, "LFE is dropped");
    }

    /// A sine resampled from 44.1 to 48 kHz keeps its length, pitch and level.
    #[test]
    fn resamples_without_losing_or_shifting_audio() {
        let (from, to, hz) = (44_100u32, 48_000u32, 1000.0f64);
        let frames = 44_100 * 2 + 123;
        let input: Vec<f32> = (0..frames)
            .flat_map(|i| {
                let s = (2.0 * std::f64::consts::PI * hz * i as f64 / from as f64).sin() as f32 * 0.5;
                [s, -s]
            })
            .collect();
        let mut r = Resampler::new(from, to, 2);
        let mut out = Vec::new();
        for chunk in input.chunks(2 * 777) {
            r.push(chunk, &mut out);
        }
        r.flush(&mut out);
        let expected = (frames as f64 * to as f64 / from as f64).round() as usize;
        assert_eq!(out.len() / 2, expected);
        // In phase with the ideal output (the filter's delay is gone), away from the edges.
        for i in (2000..expected - 2000).step_by(997) {
            let ideal = (2.0 * std::f64::consts::PI * hz * i as f64 / to as f64).sin() as f32 * 0.5;
            assert!((out[i * 2] - ideal).abs() < 0.01, "frame {i}: {} vs {ideal}", out[i * 2]);
            assert!((out[i * 2 + 1] + ideal).abs() < 0.01);
        }
    }
}
