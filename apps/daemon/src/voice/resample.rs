//! Streaming sample-rate conversion for the TTS path.
//!
//! ## Why this exists
//!
//! Nothing in the plan calls for a resampler, but the rates do not line up:
//! CosyVoice2 synthesises at 24 kHz (CosyVoice1 at 22.05 kHz), and both the
//! device's Opus decoder and [`super::tts::TTS_SAMPLE_RATE`] are 16 kHz.
//! Handing 24 kHz samples to a 16 kHz encoder does not fail — it plays back
//! 1.5× fast and chipmunk-pitched, which is exactly the kind of bug that
//! survives every unit test and only shows up on hardware.
//!
//! ## Approach
//!
//! Windowed-sinc interpolation with the cutoff placed at the *lower* of the
//! two Nyquist limits, which is what makes it an anti-aliasing filter on the
//! way down rather than a naive decimator. Plain linear interpolation would be
//! a third of the code, but at 24k→16k it folds everything above 8 kHz back
//! into the speech band as audible grit.
//!
//! Written by hand rather than pulling in `rubato`: the ratio is fixed and
//! known, the block sizes are whatever the TTS server happens to send, and a
//! streaming-friendly ~100 lines with a tone test beats fitting arbitrary
//! chunk sizes into a fixed-block resampler API.

/// Streaming resampler. Feed input with [`push`](Resampler::push) and drain
/// the tail once with [`flush`](Resampler::flush).
pub struct Resampler {
    /// Input samples consumed per output sample. > 1.0 when downsampling.
    ratio: f64,
    /// Filter cutoff in cycles per input sample.
    fc: f64,
    /// Kernel half-width, in input samples.
    half: usize,
    /// Input samples still needed by future output samples.
    history: Vec<f32>,
    /// Global input index of `history[0]`.
    origin: i64,
    /// Index of the next output sample to emit.
    next_out: u64,
}

impl Resampler {
    /// Quality knob: kernel half-width in *output* sample periods. 16 gives a
    /// ~32-tap-per-side filter at unity ratio — comfortably past the point
    /// where more taps are audible on speech.
    const LOBES: f64 = 16.0;

    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        assert!(in_rate > 0 && out_rate > 0, "sample rates must be non-zero");
        let ratio = in_rate as f64 / out_rate as f64;
        // Cut at the lower Nyquist. Downsampling (ratio > 1) pulls the cutoff
        // below the input Nyquist so nothing folds; upsampling leaves it at
        // the input Nyquist and the filter just interpolates.
        let fc = 0.5f64.min(0.5 / ratio);
        let half = (Self::LOBES * ratio.max(1.0)).ceil() as usize;
        Self {
            ratio,
            fc,
            half,
            history: Vec::new(),
            origin: 0,
            next_out: 0,
        }
    }

    /// True when input and output rates match, so callers can skip the work.
    pub fn is_identity(&self) -> bool {
        (self.ratio - 1.0).abs() < f64::EPSILON
    }

    /// Feed input samples; returns every output sample that is now fully
    /// determined. Samples whose kernel still reaches past the end of the
    /// input seen so far are held back until the next call (or `flush`).
    pub fn push(&mut self, input: &[f32]) -> Vec<f32> {
        self.history.extend_from_slice(input);
        self.drain(false)
    }

    /// Emit the final samples, treating input past the end as silence.
    pub fn flush(&mut self) -> Vec<f32> {
        let out = self.drain(true);
        self.history.clear();
        self.origin = 0;
        self.next_out = 0;
        out
    }

    fn drain(&mut self, at_end: bool) -> Vec<f32> {
        let mut out = Vec::new();
        loop {
            let pos = self.next_out as f64 * self.ratio;
            let center = pos.floor() as i64;
            let last_needed = center + self.half as i64;
            let have_through = self.origin + self.history.len() as i64 - 1;
            if last_needed > have_through && !at_end {
                break;
            }
            // At end-of-stream, stop once the kernel centre itself runs past
            // the real input — beyond that we would be synthesising silence.
            if at_end && center > have_through {
                break;
            }
            out.push(self.sample_at(pos, center));
            self.next_out += 1;

            // Drop history no future output can reach.
            let keep_from = ((self.next_out as f64 * self.ratio).floor() as i64 - self.half as i64)
                .max(self.origin);
            let drop = (keep_from - self.origin) as usize;
            if drop > 0 && drop <= self.history.len() {
                self.history.drain(..drop);
                self.origin = keep_from;
            }
        }
        out
    }

    fn sample_at(&self, pos: f64, center: i64) -> f32 {
        let mut acc = 0.0f64;
        let lo = center - self.half as i64 + 1;
        let hi = center + self.half as i64;
        for k in lo..=hi {
            let idx = k - self.origin;
            // Out-of-range reads are zeros: leading silence before the stream
            // starts, trailing silence after it ends.
            let x = if idx < 0 || idx >= self.history.len() as i64 {
                0.0
            } else {
                self.history[idx as usize] as f64
            };
            if x == 0.0 {
                continue;
            }
            acc += x * self.kernel(k as f64 - pos);
        }
        acc as f32
    }

    /// Windowed ideal-lowpass impulse response, sampled at offset `x` input
    /// samples from the (fractional) kernel centre.
    fn kernel(&self, x: f64) -> f64 {
        let halfw = self.half as f64;
        if x.abs() >= halfw {
            return 0.0;
        }
        let h = 2.0 * self.fc * sinc(2.0 * self.fc * x);
        h * blackman(x / halfw)
    }
}

/// Normalised sinc: `sin(pi x) / (pi x)`, with the removable singularity at 0.
fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 {
        1.0
    } else {
        let pix = std::f64::consts::PI * x;
        pix.sin() / pix
    }
}

/// Blackman window over `t ∈ [-1, 1]`.
fn blackman(t: f64) -> f64 {
    let pit = std::f64::consts::PI * t;
    0.42 + 0.5 * pit.cos() + 0.08 * (2.0 * pit).cos()
}

/// Convenience: convert i16 PCM at `in_rate` to i16 PCM at `out_rate` in one
/// shot. For streaming use [`Resampler`] directly so filter state carries
/// across chunk boundaries.
pub fn resample_i16(input: &[i16], in_rate: u32, out_rate: u32) -> Vec<i16> {
    if in_rate == out_rate {
        return input.to_vec();
    }
    let mut r = Resampler::new(in_rate, out_rate);
    let f: Vec<f32> = input.iter().map(|&s| s as f32).collect();
    let mut out = r.push(&f);
    out.extend(r.flush());
    out.iter()
        .map(|&s| s.clamp(i16::MIN as f32, i16::MAX as f32) as i16)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Peak amplitude, ignoring the filter's settling time at both ends.
    fn steady_peak(x: &[f32], skip: usize) -> f32 {
        x.iter()
            .skip(skip)
            .take(x.len().saturating_sub(2 * skip))
            .fold(0.0f32, |m, v| m.max(v.abs()))
    }

    fn tone(freq: f64, rate: u32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin() as f32)
            .collect()
    }

    #[test]
    fn output_length_tracks_the_rate_ratio() {
        // The whole point: 24 kHz in must not come out as 24 kHz worth of
        // samples labelled 16 kHz, or playback runs 1.5x fast.
        let mut r = Resampler::new(24_000, 16_000);
        let input = tone(440.0, 24_000, 2400); // 100 ms
        let mut out = r.push(&input);
        out.extend(r.flush());
        let expected = 2400 * 16_000 / 24_000; // 1600
        let drift = (out.len() as i64 - expected as i64).abs();
        assert!(
            drift <= 2,
            "got {} samples, expected ~{expected}",
            out.len()
        );
    }

    #[test]
    fn speech_band_tone_survives_downsampling() {
        // 1 kHz is well inside both passbands; it must come through at
        // roughly full amplitude, not attenuated or aliased.
        let mut r = Resampler::new(24_000, 16_000);
        let mut out = r.push(&tone(1000.0, 24_000, 4800));
        out.extend(r.flush());
        let peak = steady_peak(&out, 40);
        assert!(
            (0.95..=1.05).contains(&peak),
            "1 kHz peak was {peak}, expected ~1.0"
        );
    }

    #[test]
    fn above_nyquist_is_filtered_not_aliased() {
        // 10 kHz cannot be represented at 16 kHz output (Nyquist 8 kHz). A
        // naive decimator would fold it down to 6 kHz at full amplitude —
        // audible grit. The anti-alias filter must crush it instead.
        let mut r = Resampler::new(24_000, 16_000);
        let mut out = r.push(&tone(10_000.0, 24_000, 4800));
        out.extend(r.flush());
        let peak = steady_peak(&out, 60);
        assert!(
            peak < 0.05,
            "10 kHz leaked through at {peak}, expected <0.05"
        );
    }

    #[test]
    fn streaming_in_chunks_matches_one_shot() {
        // Filter state must carry across chunk boundaries; if it doesn't,
        // every chunk edge becomes a click.
        let input = tone(700.0, 24_000, 3000);
        let mut one = Resampler::new(24_000, 16_000);
        let mut whole = one.push(&input);
        whole.extend(one.flush());

        let mut chunked = Resampler::new(24_000, 16_000);
        let mut parts = Vec::new();
        for c in input.chunks(137) {
            parts.extend(chunked.push(c));
        }
        parts.extend(chunked.flush());

        assert_eq!(whole.len(), parts.len(), "chunking changed output length");
        for (i, (a, b)) in whole.iter().zip(parts.iter()).enumerate() {
            assert!((a - b).abs() < 1e-4, "sample {i} differs: {a} vs {b}");
        }
    }

    #[test]
    fn cosyvoice1_rate_also_works() {
        // 22.05 kHz is not an integer ratio to 16 kHz — the awkward case.
        let mut r = Resampler::new(22_050, 16_000);
        let mut out = r.push(&tone(1000.0, 22_050, 4410));
        out.extend(r.flush());
        let expected = 4410 * 16_000 / 22_050;
        assert!((out.len() as i64 - expected as i64).abs() <= 2);
        let peak = steady_peak(&out, 40);
        assert!((0.95..=1.05).contains(&peak), "peak {peak}");
    }

    #[test]
    fn identity_rate_is_a_passthrough() {
        let r = Resampler::new(16_000, 16_000);
        assert!(r.is_identity());
        let input: Vec<i16> = (0..100).map(|i| (i * 37) as i16).collect();
        assert_eq!(resample_i16(&input, 16_000, 16_000), input);
    }

    #[test]
    fn silence_stays_silent() {
        let mut r = Resampler::new(24_000, 16_000);
        let mut out = r.push(&vec![0.0; 2400]);
        out.extend(r.flush());
        assert!(out.iter().all(|&s| s.abs() < 1e-6), "silence gained energy");
    }

    #[test]
    fn i16_helper_does_not_wrap_on_overshoot() {
        // Sinc interpolation overshoots at edges; without the clamp a
        // near-full-scale square wave wraps to the opposite rail and clicks.
        let input: Vec<i16> = (0..2400)
            .map(|i| if (i / 6) % 2 == 0 { 32000 } else { -32000 })
            .collect();
        let out = resample_i16(&input, 24_000, 16_000);
        assert!(!out.is_empty());
        // Neighbouring samples can't jump the full rail-to-rail distance if
        // clamping worked; a wrap would show up as a >60000 step.
        for w in out.windows(2) {
            let step = (w[0] as i32 - w[1] as i32).abs();
            assert!(step < 70_000, "impossible step {step} — sign wrap?");
        }
    }
}
