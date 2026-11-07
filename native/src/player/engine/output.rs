//! The output device (`audioOutput.ts`, and the browser's audio sink): a
//! thread that opens the chosen device (or the system default, following it
//! when it changes), lists the devices for Settings, and reopens when a
//! device goes away. Without a device (none plugged in, or a Linux build
//! without `--features alsa`) the mix still plays, silently, on a clock, so
//! the player behaves the same.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::net::LateWaker;

use super::OutFormat;
use super::mixer::Mixer;

/// An output device as Settings lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputDevice {
    /// Stable across launches (cpal's device id, e.g. `wasapi:{…}`).
    pub device_id: String,
    pub label: String,
}

/// What the output thread publishes.
#[derive(Default)]
pub struct OutputShared {
    pub format: Mutex<OutFormat>,
    pub devices: Mutex<Vec<OutputDevice>>,
    /// The last failure to open a device, for the Settings row.
    pub error: Mutex<Option<String>>,
    /// The chosen device wasn't found, so the default plays (the web forgets the choice).
    pub lost: AtomicBool,
    /// Devices can be listed and chosen.
    pub supported: AtomicBool,
    /// Moves whenever `devices` or `error` change, so the player redraws
    /// (the Settings row lists them).
    pub changes: AtomicU64,
}

impl OutputShared {
    /// The devices or the error changed: count it and wake the UI.
    fn changed(&self, waker: &LateWaker) {
        self.changes.fetch_add(1, Ordering::Relaxed);
        waker.wake();
    }
}

pub enum OutputCmd {
    Select(Option<String>),
    Refresh,
}

pub fn start(mixer: Arc<Mutex<Mixer>>, shared: Arc<OutputShared>, waker: LateWaker, device: Option<String>) -> Sender<OutputCmd> {
    let (tx, rx) = channel();
    let _ = std::thread::Builder::new().name("lumen-output".into()).spawn(move || run(mixer, shared, waker, rx, device));
    tx
}

fn run(mixer: Arc<Mutex<Mixer>>, shared: Arc<OutputShared>, waker: LateWaker, rx: Receiver<OutputCmd>, mut selected: Option<String>) {
    shared.supported.store(device::SUPPORTED, Ordering::Relaxed);
    let refresh = |shared: &OutputShared| *shared.devices.lock().unwrap() = device::list();
    refresh(&shared);
    let failed = Arc::new(AtomicBool::new(false));
    let mut stream: Option<device::Stream> = None;
    let mut default_id: Option<String> = None;
    let mut retry_at = Instant::now();
    let mut clock = Instant::now();
    let mut scratch = Vec::new();
    loop {
        if stream.is_none() && device::SUPPORTED && Instant::now() >= retry_at {
            match device::open(selected.as_deref(), &mixer, &failed) {
                Ok(opened) => {
                    *shared.format.lock().unwrap() = opened.format;
                    *shared.error.lock().unwrap() = None;
                    default_id = if selected.is_none() { opened.id } else { None };
                    stream = Some(opened.stream);
                    shared.changed(&waker);
                }
                Err(device::OpenError::NotFound) => {
                    // The chosen device is gone: play on the default, and say so.
                    selected = None;
                    shared.lost.store(true, Ordering::Relaxed);
                    *shared.error.lock().unwrap() = Some("Requested device not found".into());
                    shared.changed(&waker);
                    continue;
                }
                Err(device::OpenError::Failed(message)) => {
                    *shared.error.lock().unwrap() = Some(message);
                    retry_at = Instant::now() + Duration::from_secs(3);
                    shared.changed(&waker);
                }
            }
            clock = Instant::now();
        }
        // Without a device the mix plays on this thread's clock.
        let wait = if stream.is_none() {
            let elapsed = clock.elapsed();
            clock = Instant::now();
            let mut m = mixer.lock().unwrap();
            let format = m.format();
            let frames = ((elapsed.as_secs_f64().min(0.1)) * format.rate as f64) as usize;
            scratch.resize(frames * format.channels, 0.0);
            m.render(&mut scratch);
            Duration::from_millis(10)
        } else {
            Duration::from_secs(2)
        };
        match rx.recv_timeout(wait) {
            Ok(OutputCmd::Select(device)) => {
                if device != selected {
                    selected = device;
                    stream = None;
                    retry_at = Instant::now();
                }
            }
            Ok(OutputCmd::Refresh) => {
                refresh(&shared);
                shared.changed(&waker);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if failed.swap(false, Ordering::Relaxed) {
            // The device went away or changed: open again (the list has changed too).
            stream = None;
            retry_at = Instant::now();
            refresh(&shared);
            shared.changed(&waker);
        }
        if stream.is_some() && selected.is_none() && device::default_id() != default_id {
            // The system default moved: follow it, as the browser does.
            stream = None;
            retry_at = Instant::now();
            refresh(&shared);
            shared.changed(&waker);
        }
    }
}

#[cfg(any(windows, target_os = "macos", feature = "alsa"))]
mod device {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, SampleFormat, SizedSample};

    use super::super::OutFormat;
    use super::super::mixer::Mixer;
    use super::OutputDevice;

    pub const SUPPORTED: bool = true;
    pub type Stream = cpal::Stream;

    pub struct Opened {
        pub stream: Stream,
        pub format: OutFormat,
        pub id: Option<String>,
    }

    pub enum OpenError {
        NotFound,
        Failed(String),
    }

    fn label(device: &cpal::Device) -> String {
        device.description().map(|d| d.name().to_string()).unwrap_or_else(|_| device.to_string())
    }

    pub fn list() -> Vec<OutputDevice> {
        let host = cpal::default_host();
        let Ok(devices) = host.output_devices() else { return Vec::new() };
        devices
            .filter_map(|d| Some(OutputDevice { device_id: d.id().ok()?.to_string(), label: label(&d) }))
            .collect()
    }

    pub fn default_id() -> Option<String> {
        cpal::default_host().default_output_device().and_then(|d| d.id().ok()).map(|id| id.to_string())
    }

    pub fn open(selected: Option<&str>, mixer: &Arc<Mutex<Mixer>>, failed: &Arc<AtomicBool>) -> Result<Opened, OpenError> {
        let host = cpal::default_host();
        let device = match selected {
            Some(id) => {
                let parsed: cpal::DeviceId = id.parse().map_err(|_| OpenError::NotFound)?;
                host.device_by_id(&parsed).ok_or(OpenError::NotFound)?
            }
            None => host.default_output_device().ok_or_else(|| OpenError::Failed("No audio output device".into()))?,
        };
        let id = device.id().ok().map(|id| id.to_string());
        let supported = device.default_output_config().map_err(|e| OpenError::Failed(e.to_string()))?;
        let config = supported.config();
        let format = OutFormat { rate: config.sample_rate, channels: config.channels as usize };
        mixer.lock().unwrap().set_format(format);
        let stream = match supported.sample_format() {
            SampleFormat::F32 => build::<f32>(&device, config, mixer, failed),
            SampleFormat::F64 => build::<f64>(&device, config, mixer, failed),
            SampleFormat::I16 => build::<i16>(&device, config, mixer, failed),
            SampleFormat::U16 => build::<u16>(&device, config, mixer, failed),
            SampleFormat::I32 => build::<i32>(&device, config, mixer, failed),
            SampleFormat::U32 => build::<u32>(&device, config, mixer, failed),
            SampleFormat::I8 => build::<i8>(&device, config, mixer, failed),
            SampleFormat::U8 => build::<u8>(&device, config, mixer, failed),
            other => return Err(OpenError::Failed(format!("Unsupported sample format {other:?}"))),
        }
        .map_err(|e| OpenError::Failed(e.to_string()))?;
        stream.play().map_err(|e| OpenError::Failed(e.to_string()))?;
        Ok(Opened { stream, format, id })
    }

    fn build<T: SizedSample + FromSample<f32>>(
        device: &cpal::Device,
        config: cpal::StreamConfig,
        mixer: &Arc<Mutex<Mixer>>,
        failed: &Arc<AtomicBool>,
    ) -> Result<cpal::Stream, cpal::Error> {
        let mixer = mixer.clone();
        let failed = failed.clone();
        let mut scratch: Vec<f32> = Vec::new();
        device.build_output_stream::<T, _, _>(
            config,
            move |data: &mut [T], _| {
                if scratch.len() < data.len() {
                    scratch.resize(data.len(), 0.0);
                }
                let buf = &mut scratch[..data.len()];
                match mixer.try_lock() {
                    Ok(mut m) => m.render(buf),
                    Err(_) => buf.fill(0.0),
                }
                for (out, s) in data.iter_mut().zip(buf.iter()) {
                    *out = T::from_sample(*s);
                }
            },
            move |_err| failed.store(true, Ordering::Relaxed),
            None,
        )
    }
}

#[cfg(not(any(windows, target_os = "macos", feature = "alsa")))]
mod device {
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};

    use super::super::OutFormat;
    use super::super::mixer::Mixer;
    use super::OutputDevice;

    pub const SUPPORTED: bool = false;
    pub struct Stream;

    pub struct Opened {
        pub stream: Stream,
        pub format: OutFormat,
        pub id: Option<String>,
    }

    pub enum OpenError {
        #[cfg_attr(not(windows), allow(dead_code))]
        NotFound,
        Failed(String),
    }

    pub fn list() -> Vec<OutputDevice> {
        Vec::new()
    }

    pub fn default_id() -> Option<String> {
        None
    }

    pub fn open(_: Option<&str>, _: &Arc<Mutex<Mixer>>, _: &Arc<AtomicBool>) -> Result<Opened, OpenError> {
        Err(OpenError::Failed("No audio output on this build".into()))
    }
}
