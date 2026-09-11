//! Device-local FunASR voice input for the chat composer.
//!
//! Audio never leaves the machine. The first install downloads a pinned,
//! checksummed FunASR llama.cpp runtime and GGUF models into app data. Capture
//! is owned by the Tauri process (so macOS attributes microphone permission to
//! the signed app); inference runs in the isolated upstream binary.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

const ENGINE_VERSION: &str = "1.4.15";
const MODEL_URL: &str = "https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/90c1c61912018b70ada0fcc024ea24aca62f2e63/sensevoice-small-q8.gguf";
const MODEL_SHA256: &str = "4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5";
const VAD_URL: &str = "https://huggingface.co/FunAudioLLM/fsmn-vad-GGUF/resolve/6840bae4c5c92ee8c04faaf4db23dd0105098d7f/fsmn-vad.gguf";
const VAD_SHA256: &str = "1270f2559c495f4e7b6e739541151027d360761a3fda43fc147034f5719f5479";

const MODEL_BYTES: u64 = 254_208_320;
const VAD_BYTES: u64 = 1_720_512;
const TOTAL_BYTES: u64 = MODEL_BYTES + VAD_BYTES;

#[derive(Default)]
pub struct VoiceInputState {
    listening: AtomicBool,
    installing: AtomicBool,
    stop: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInputStatus {
    supported: bool,
    installed: bool,
    installing: bool,
    listening: bool,
    engine_version: &'static str,
    download_bytes: u64,
    reason: Option<String>,
}

fn install_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("voice")
        .join(format!("funasr-{ENGINE_VERSION}")))
}

fn runtime_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join("llama-funasr-sensevoice")
}

fn model_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join("sensevoice-small-q8.gguf")
}

fn vad_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join("fsmn-vad.gguf")
}

fn is_installed(root: &std::path::Path) -> bool {
    runtime_path(root).is_file() && model_path(root).is_file() && vad_path(root).is_file()
}

fn platform_support() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Local FunASR currently requires macOS".to_string())
    }
}

#[tauri::command]
pub fn voice_input_status(
    app: AppHandle,
    state: State<'_, VoiceInputState>,
) -> Result<VoiceInputStatus, String> {
    let support = platform_support();
    let root = install_dir(&app)?;
    Ok(VoiceInputStatus {
        supported: support.is_ok(),
        installed: support.is_ok() && is_installed(&root),
        installing: state.installing.load(Ordering::SeqCst),
        listening: state.listening.load(Ordering::SeqCst),
        engine_version: ENGINE_VERSION,
        download_bytes: TOTAL_BYTES,
        reason: support.err(),
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    bytes_downloaded: u64,
    total_bytes: u64,
    stage: &'static str,
}

#[cfg(target_os = "macos")]
fn download_checked(
    app: &AppHandle,
    url: &str,
    expected_sha256: &str,
    destination: &std::path::Path,
    offset: u64,
    stage: &'static str,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};

    let client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(30 * 60))
        .build()
        .map_err(|error| format!("prepare {stage} download: {error}"))?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|error| format!("download {stage}: {error}"))?
        .error_for_status()
        .map_err(|error| format!("download {stage}: {error}"))?;
    let mut file =
        std::fs::File::create(destination).map_err(|error| format!("create {stage}: {error}"))?;
    let mut hash = Sha256::new();
    let mut downloaded = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = response
            .read(&mut buffer)
            .map_err(|error| format!("read {stage}: {error}"))?;
        if count == 0 {
            break;
        }
        file.write_all(&buffer[..count])
            .map_err(|error| format!("write {stage}: {error}"))?;
        hash.update(&buffer[..count]);
        downloaded += count as u64;
        let _ = app.emit(
            "voice:install-progress",
            InstallProgress {
                bytes_downloaded: offset + downloaded,
                total_bytes: TOTAL_BYTES,
                stage,
            },
        );
    }
    file.sync_all()
        .map_err(|error| format!("sync {stage}: {error}"))?;
    let actual = format!("{:x}", hash.finalize());
    if actual != expected_sha256 {
        return Err(format!("{stage} checksum mismatch"));
    }
    Ok(())
}

#[tauri::command]
pub fn voice_input_install(
    app: AppHandle,
    state: State<'_, VoiceInputState>,
) -> Result<(), String> {
    platform_support()?;
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err("FunASR installation is already running".to_string());
    }

    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let result = install_engine(&app_for_thread);
        if let Some(shared) = app_for_thread.try_state::<VoiceInputState>() {
            shared.installing.store(false, Ordering::SeqCst);
        }
        match result {
            Ok(()) => {
                let _ = app_for_thread.emit("voice:install-finished", serde_json::json!({}));
            }
            Err(message) => {
                let _ = app_for_thread.emit(
                    "voice:error",
                    serde_json::json!({ "code": "install_failed", "message": message }),
                );
            }
        }
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_engine(app: &AppHandle) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let final_dir = install_dir(app)?;
    if is_installed(&final_dir) {
        return Ok(());
    }
    let parent = final_dir
        .parent()
        .ok_or("invalid voice install directory")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = tempfile::Builder::new()
        .prefix("funasr-install-")
        .tempdir_in(parent)
        .map_err(|error| error.to_string())?;
    let bundled_runtime =
        crate::commands::amuxd_supervisor::locate_bundled_sidecar("llama-funasr-sensevoice")
            .ok_or("Bundled FunASR runtime is missing")?;
    std::fs::copy(&bundled_runtime, runtime_path(temp.path()))
        .map_err(|error| format!("copy FunASR runtime: {error}"))?;
    download_checked(
        app,
        MODEL_URL,
        MODEL_SHA256,
        &model_path(temp.path()),
        0,
        "model",
    )?;
    download_checked(
        app,
        VAD_URL,
        VAD_SHA256,
        &vad_path(temp.path()),
        MODEL_BYTES,
        "vad",
    )?;
    let runtime = runtime_path(temp.path());
    let mut permissions = std::fs::metadata(&runtime)
        .map_err(|error| error.to_string())?
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&runtime, permissions).map_err(|error| error.to_string())?;
    if final_dir.exists() {
        std::fs::remove_dir_all(&final_dir).map_err(|error| error.to_string())?;
    }
    std::fs::rename(temp.keep(), &final_dir).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn install_engine(_app: &AppHandle) -> Result<(), String> {
    platform_support()
}

#[tauri::command]
pub fn voice_input_start(
    app: AppHandle,
    state: State<'_, VoiceInputState>,
    recording_id: String,
) -> Result<(), String> {
    platform_support()?;
    let root = install_dir(&app)?;
    if !is_installed(&root) {
        return Err("FunASR is not installed".to_string());
    }
    if state.listening.swap(true, Ordering::SeqCst) {
        return Err("Microphone is already in use by voice input".to_string());
    }
    let stop = Arc::new(AtomicBool::new(false));
    *state.stop.lock().map_err(|error| error.to_string())? = Some(stop.clone());
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        let result =
            macos::capture_and_transcribe(app_for_thread.clone(), root, stop, recording_id.clone());
        #[cfg(not(target_os = "macos"))]
        let result: Result<(), String> = Err("unsupported platform".to_string());
        if let Some(shared) = app_for_thread.try_state::<VoiceInputState>() {
            shared.listening.store(false, Ordering::SeqCst);
            if let Ok(mut guard) = shared.stop.lock() {
                *guard = None;
            }
        }
        if let Err(message) = result {
            let _ = app_for_thread.emit(
                "voice:error",
                serde_json::json!({ "code": "recording_failed", "message": message }),
            );
        }
        let _ = app_for_thread.emit(
            "voice:stopped",
            serde_json::json!({ "recordingId": recording_id }),
        );
    });
    Ok(())
}

#[tauri::command]
pub fn voice_input_stop(state: State<'_, VoiceInputState>) -> Result<(), String> {
    if let Some(stop) = state.stop.lock().map_err(|error| error.to_string())?.take() {
        stop.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::collections::VecDeque;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    const SAMPLE_RATE: u32 = 16_000;
    const STEP_MS: usize = 100;
    const STEP_SAMPLES: usize = SAMPLE_RATE as usize * STEP_MS / 1000;
    const SILENCE_STEPS: usize = 8;
    const PRE_ROLL_STEPS: usize = 3;
    const MIN_SPEECH_SAMPLES: usize = SAMPLE_RATE as usize * 4 / 10;
    const MAX_SEGMENT_SAMPLES: usize = SAMPLE_RATE as usize * 20;
    const RMS_SPEECH_THRESHOLD: f32 = 0.012;

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct SegmentPayload {
        recording_id: String,
        segment_id: String,
        text: String,
        started_at_ms: u64,
        ended_at_ms: u64,
        speaker_cluster_id: Option<String>,
        speaker_profile_id: Option<String>,
    }

    pub fn capture_and_transcribe(
        app: AppHandle,
        root: std::path::PathBuf,
        stop: Arc<AtomicBool>,
        recording_id: String,
    ) -> Result<(), String> {
        let (audio_tx, audio_rx) = mpsc::channel::<Vec<f32>>();
        let (segment_tx, segment_rx) = mpsc::channel::<Vec<f32>>();
        let inference_app = app.clone();
        let inference_root = root.clone();
        let inference = std::thread::spawn(move || {
            for samples in segment_rx {
                match transcribe_segment(&inference_root, &samples) {
                    Ok(text) if !text.is_empty() => {
                        let _ = inference_app.emit(
                            "voice:segment",
                            SegmentPayload {
                                segment_id: uuid::Uuid::new_v4().to_string(),
                                recording_id: recording_id.clone(),
                                text,
                                started_at_ms: 0,
                                ended_at_ms: (samples.len() as u64 * 1000) / SAMPLE_RATE as u64,
                                speaker_cluster_id: None,
                                speaker_profile_id: None,
                            },
                        );
                    }
                    Ok(_) => {}
                    Err(message) => {
                        let _ = inference_app.emit(
                            "voice:error",
                            serde_json::json!({ "code": "transcription_failed", "message": message }),
                        );
                    }
                }
            }
        });

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or("No default input device")?;
        let supported = device
            .default_input_config()
            .map_err(|error| format!("Default input config: {error}"))?;
        let source_rate = supported.sample_rate();
        let channels = supported.channels() as usize;
        let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
        let stream = build_stream(&device, &supported, channels, buffer.clone())?;
        stream
            .play()
            .map_err(|error| format!("Start microphone: {error}"))?;
        let pump_stop = stop.clone();
        let pump = std::thread::spawn(move || {
            let source_step = source_rate as usize * STEP_MS / 1000;
            while !pump_stop.load(Ordering::SeqCst) {
                let chunk = {
                    let mut samples = buffer.lock().unwrap_or_else(|error| error.into_inner());
                    if samples.len() >= source_step {
                        samples.drain(..source_step).collect::<Vec<_>>()
                    } else {
                        Vec::new()
                    }
                };
                if !chunk.is_empty() && audio_tx.send(resample(&chunk, source_rate)).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });

        let started = Instant::now();
        let mut pre_roll = VecDeque::<Vec<f32>>::with_capacity(PRE_ROLL_STEPS);
        let mut active = Vec::<f32>::new();
        let mut silence = 0_usize;
        while !stop.load(Ordering::SeqCst) {
            let chunk = match audio_rx.recv_timeout(Duration::from_millis(150)) {
                Ok(chunk) => chunk,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let rms = (chunk.iter().map(|sample| sample * sample).sum::<f32>()
                / chunk.len().max(1) as f32)
                .sqrt();
            let speech = rms >= RMS_SPEECH_THRESHOLD;
            let _ = app.emit(
                "voice:level",
                serde_json::json!({
                    "rms": rms,
                    "elapsedMs": started.elapsed().as_millis() as u64,
                }),
            );
            if active.is_empty() {
                pre_roll.push_back(chunk.clone());
                while pre_roll.len() > PRE_ROLL_STEPS {
                    pre_roll.pop_front();
                }
                if speech {
                    for prior in pre_roll.drain(..) {
                        active.extend(prior);
                    }
                    silence = 0;
                }
                continue;
            }
            active.extend(chunk);
            silence = if speech { 0 } else { silence + 1 };
            if silence >= SILENCE_STEPS || active.len() >= MAX_SEGMENT_SAMPLES {
                finalize(&segment_tx, &mut active, silence);
                silence = 0;
            }
        }
        drop(stream);
        let _ = pump.join();
        finalize(&segment_tx, &mut active, silence);
        drop(segment_tx);
        let _ = inference.join();
        Ok(())
    }

    fn finalize(sender: &mpsc::Sender<Vec<f32>>, active: &mut Vec<f32>, silence_steps: usize) {
        let trim_steps = silence_steps.saturating_sub(2);
        active.truncate(active.len().saturating_sub(trim_steps * STEP_SAMPLES));
        if active.len() >= MIN_SPEECH_SAMPLES {
            let _ = sender.send(std::mem::take(active));
        } else {
            active.clear();
        }
    }

    fn resample(samples: &[f32], source_rate: u32) -> Vec<f32> {
        if source_rate == SAMPLE_RATE || samples.is_empty() {
            return samples.to_vec();
        }
        let output_len = samples.len() as u64 * SAMPLE_RATE as u64 / source_rate as u64;
        (0..output_len as usize)
            .map(|index| {
                let position = index as f64 * (samples.len() - 1) as f64
                    / (output_len.saturating_sub(1).max(1)) as f64;
                let lower = position.floor() as usize;
                let upper = (lower + 1).min(samples.len() - 1);
                let fraction = (position - lower as f64) as f32;
                samples[lower] + (samples[upper] - samples[lower]) * fraction
            })
            .collect()
    }

    fn build_stream(
        device: &cpal::Device,
        supported: &cpal::SupportedStreamConfig,
        channels: usize,
        buffer: Arc<Mutex<Vec<f32>>>,
    ) -> Result<cpal::Stream, String> {
        let config = supported.clone().into();
        let on_error = |error| log::error!("voice microphone stream: {error}");
        match supported.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _| push_mono(&buffer, data.chunks(channels).map(mean_f32)),
                on_error,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    push_mono(
                        &buffer,
                        data.chunks(channels).map(|frame| {
                            frame
                                .iter()
                                .map(|sample| *sample as f32 / i16::MAX as f32)
                                .sum::<f32>()
                                / frame.len().max(1) as f32
                        }),
                    )
                },
                on_error,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    push_mono(
                        &buffer,
                        data.chunks(channels).map(|frame| {
                            frame
                                .iter()
                                .map(|sample| (*sample as f32 / u16::MAX as f32) * 2.0 - 1.0)
                                .sum::<f32>()
                                / frame.len().max(1) as f32
                        }),
                    )
                },
                on_error,
                None,
            ),
            format => return Err(format!("Unsupported microphone sample format: {format:?}")),
        }
        .map_err(|error| format!("Build microphone stream: {error}"))
    }

    fn mean_f32(frame: &[f32]) -> f32 {
        frame.iter().sum::<f32>() / frame.len().max(1) as f32
    }

    fn push_mono(values: &Arc<Mutex<Vec<f32>>>, input: impl Iterator<Item = f32>) {
        values
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .extend(input);
    }

    fn transcribe_segment(root: &std::path::Path, samples: &[f32]) -> Result<String, String> {
        let temp = tempfile::Builder::new()
            .prefix("teamclu-voice-")
            .suffix(".wav")
            .tempfile()
            .map_err(|error| error.to_string())?;
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer =
            hound::WavWriter::new(temp.reopen().map_err(|error| error.to_string())?, spec)
                .map_err(|error| error.to_string())?;
        for sample in samples {
            writer
                .write_sample((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                .map_err(|error| error.to_string())?;
        }
        writer.finalize().map_err(|error| error.to_string())?;
        let output = std::process::Command::new(runtime_path(root))
            .arg("-m")
            .arg(model_path(root))
            .arg("--vad")
            .arg(vad_path(root))
            .arg("-a")
            .arg(temp.path())
            .output()
            .map_err(|error| format!("start FunASR: {error}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let raw = String::from_utf8_lossy(&output.stdout);
        let tag = regex::Regex::new(r"<\|[^|>]+\|>").expect("static voice tag regex");
        Ok(tag.replace_all(raw.trim(), "").trim().to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn resample_preserves_duration() {
            let input = vec![0.25_f32; 48_000];
            let output = resample(&input, 48_000);
            assert_eq!(output.len(), 16_000);
        }

        #[test]
        fn finalize_ignores_short_noise() {
            let (sender, receiver) = mpsc::channel();
            let mut active = vec![0.2_f32; MIN_SPEECH_SAMPLES - 1];
            finalize(&sender, &mut active, 0);
            assert!(receiver.try_recv().is_err());
            assert!(active.is_empty());
        }

        #[test]
        fn finalize_emits_speech_and_trims_excess_silence() {
            let (sender, receiver) = mpsc::channel();
            let original_len = MIN_SPEECH_SAMPLES + SILENCE_STEPS * STEP_SAMPLES;
            let mut active = vec![0.2_f32; original_len];
            finalize(&sender, &mut active, SILENCE_STEPS);
            let segment = receiver.try_recv().expect("final segment");
            assert_eq!(
                segment.len(),
                original_len - (SILENCE_STEPS - 2) * STEP_SAMPLES
            );
            assert!(active.is_empty());
        }
    }
}
