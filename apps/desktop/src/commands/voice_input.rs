//! Device-local FunASR voice input for the chat composer.
//!
//! Audio never leaves the machine. The first install copies the bundled FunASR
//! runtime and downloads a pinned, checksummed GGUF model into app data. Capture
//! is owned by the Tauri process (so macOS attributes microphone permission to
//! the signed app); inference runs in the isolated upstream binary.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

const ENGINE_VERSION: &str = "1.4.15";
#[cfg(target_os = "macos")]
const MODEL_REVISION: &str = "90c1c61912018b70ada0fcc024ea24aca62f2e63";
#[cfg(target_os = "macos")]
const MODEL_BASE_URL: &str = "https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF/resolve";
#[cfg(target_os = "macos")]
const Q8_MODEL_SHA256: &str = "4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5";
#[cfg(target_os = "macos")]
const F16_MODEL_SHA256: &str = "2389039651f4574dbd674f1f1e296b8b1147b2e19a5fd9c2cd69e82669c78d8e";
#[cfg(target_os = "macos")]
const VAD_URL: &str = "https://huggingface.co/FunAudioLLM/fsmn-vad-GGUF/resolve/6840bae4c5c92ee8c04faaf4db23dd0105098d7f/fsmn-vad.gguf";
#[cfg(target_os = "macos")]
const VAD_SHA256: &str = "1270f2559c495f4e7b6e739541151027d360761a3fda43fc147034f5719f5479";
#[cfg(target_os = "macos")]
const SPEAKER_MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx";
#[cfg(target_os = "macos")]
const SPEAKER_MODEL_SHA256: &str =
    "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11";

#[cfg(target_os = "macos")]
const Q8_MODEL_BYTES: u64 = 254_208_320;
#[cfg(target_os = "macos")]
const F16_MODEL_BYTES: u64 = 470_197_600;
#[cfg(target_os = "macos")]
const VAD_BYTES: u64 = 1_720_512;
#[cfg(target_os = "macos")]
const SPEAKER_MODEL_BYTES: u64 = 28_281_138;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VoiceModelVariant {
    Q8,
    F16,
}

struct VoiceModelSpec {
    file_name: &'static str,
    #[cfg(target_os = "macos")]
    sha256: &'static str,
    #[cfg(target_os = "macos")]
    bytes: u64,
}

impl VoiceModelVariant {
    fn spec(self) -> VoiceModelSpec {
        match self {
            Self::Q8 => VoiceModelSpec {
                file_name: "sensevoice-small-q8.gguf",
                #[cfg(target_os = "macos")]
                sha256: Q8_MODEL_SHA256,
                #[cfg(target_os = "macos")]
                bytes: Q8_MODEL_BYTES,
            },
            Self::F16 => VoiceModelSpec {
                file_name: "sensevoice-small-f16.gguf",
                #[cfg(target_os = "macos")]
                sha256: F16_MODEL_SHA256,
                #[cfg(target_os = "macos")]
                bytes: F16_MODEL_BYTES,
            },
        }
    }

    #[cfg(target_os = "macos")]
    fn id(self) -> &'static str {
        match self {
            Self::Q8 => "q8",
            Self::F16 => "f16",
        }
    }
}

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
    installed_model: Option<VoiceModelVariant>,
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

fn model_path(root: &std::path::Path, variant: VoiceModelVariant) -> std::path::PathBuf {
    root.join(variant.spec().file_name)
}

fn vad_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join("fsmn-vad.gguf")
}

fn speaker_model_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join("3dspeaker-campplus-zh-common.onnx")
}

fn model_marker_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join("model-variant")
}

fn base_installed_variant(root: &std::path::Path) -> Option<VoiceModelVariant> {
    if !runtime_path(root).is_file() || !vad_path(root).is_file() {
        return None;
    }
    let marked = std::fs::read_to_string(model_marker_path(root)).ok();
    let preferred = match marked.as_deref().map(str::trim) {
        Some("f16") => Some(VoiceModelVariant::F16),
        Some("q8") => Some(VoiceModelVariant::Q8),
        _ => None,
    };
    preferred
        .filter(|variant| model_path(root, *variant).is_file())
        .or_else(|| {
            [VoiceModelVariant::Q8, VoiceModelVariant::F16]
                .into_iter()
                .find(|variant| model_path(root, *variant).is_file())
        })
}

fn installed_variant(root: &std::path::Path) -> Option<VoiceModelVariant> {
    speaker_model_path(root)
        .is_file()
        .then(|| base_installed_variant(root))
        .flatten()
}

#[cfg(target_os = "macos")]
fn is_variant_installed(root: &std::path::Path, variant: VoiceModelVariant) -> bool {
    installed_variant(root) == Some(variant)
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
    let installed = support.is_ok() && installed_variant(&root).is_some();
    let installed_model = support
        .is_ok()
        .then(|| base_installed_variant(&root))
        .flatten();
    Ok(VoiceInputStatus {
        supported: support.is_ok(),
        installed,
        installing: state.installing.load(Ordering::SeqCst),
        listening: state.listening.load(Ordering::SeqCst),
        engine_version: ENGINE_VERSION,
        installed_model,
        reason: support.err(),
    })
}

#[cfg(target_os = "macos")]
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
    total_bytes: u64,
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
                total_bytes,
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

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn stage_or_download_checked(
    app: &AppHandle,
    existing: &std::path::Path,
    url: &str,
    expected_sha256: &str,
    expected_bytes: u64,
    destination: &std::path::Path,
    offset: u64,
    total_bytes: u64,
    stage: &'static str,
) -> Result<(), String> {
    let reusable = existing
        .metadata()
        .map(|metadata| metadata.len() == expected_bytes)
        .unwrap_or(false);
    if reusable {
        std::fs::copy(existing, destination).map_err(|error| format!("copy {stage}: {error}"))?;
        let _ = app.emit(
            "voice:install-progress",
            InstallProgress {
                bytes_downloaded: offset + expected_bytes,
                total_bytes,
                stage,
            },
        );
        return Ok(());
    }
    download_checked(
        app,
        url,
        expected_sha256,
        destination,
        offset,
        total_bytes,
        stage,
    )
}

#[tauri::command]
pub fn voice_input_install(
    app: AppHandle,
    state: State<'_, VoiceInputState>,
    model_variant: VoiceModelVariant,
) -> Result<(), String> {
    platform_support()?;
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err("FunASR installation is already running".to_string());
    }

    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let result = install_engine(&app_for_thread, model_variant);
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
fn install_engine(app: &AppHandle, model_variant: VoiceModelVariant) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let final_dir = install_dir(app)?;
    if is_variant_installed(&final_dir, model_variant) {
        return Ok(());
    }
    let model = model_variant.spec();
    let total_bytes = model.bytes + VAD_BYTES + SPEAKER_MODEL_BYTES;
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
    let model_url = format!("{MODEL_BASE_URL}/{MODEL_REVISION}/{}", model.file_name);
    stage_or_download_checked(
        app,
        &model_path(&final_dir, model_variant),
        &model_url,
        model.sha256,
        model.bytes,
        &model_path(temp.path(), model_variant),
        0,
        total_bytes,
        "model",
    )?;
    stage_or_download_checked(
        app,
        &vad_path(&final_dir),
        VAD_URL,
        VAD_SHA256,
        VAD_BYTES,
        &vad_path(temp.path()),
        model.bytes,
        total_bytes,
        "vad",
    )?;
    stage_or_download_checked(
        app,
        &speaker_model_path(&final_dir),
        SPEAKER_MODEL_URL,
        SPEAKER_MODEL_SHA256,
        SPEAKER_MODEL_BYTES,
        &speaker_model_path(temp.path()),
        model.bytes + VAD_BYTES,
        total_bytes,
        "speaker",
    )?;
    std::fs::write(model_marker_path(temp.path()), model_variant.id())
        .map_err(|error| format!("write model variant: {error}"))?;
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
fn install_engine(_app: &AppHandle, _model_variant: VoiceModelVariant) -> Result<(), String> {
    platform_support()
}

#[tauri::command]
pub fn voice_input_start(
    app: AppHandle,
    state: State<'_, VoiceInputState>,
    recording_id: String,
    session_id: String,
    workspace_path: String,
    speaker_diarization: bool,
) -> Result<(), String> {
    platform_support()?;
    let root = install_dir(&app)?;
    let model_variant = installed_variant(&root).ok_or("FunASR is not installed")?;
    let workspace_path = std::path::PathBuf::from(workspace_path)
        .canonicalize()
        .map_err(|error| format!("Open transcript workspace: {error}"))?;
    if !workspace_path.is_dir() {
        return Err("Transcript workspace is not a directory".to_string());
    }
    if state.listening.swap(true, Ordering::SeqCst) {
        return Err("Microphone is already in use by voice input".to_string());
    }
    let stop = Arc::new(AtomicBool::new(false));
    *state.stop.lock().map_err(|error| error.to_string())? = Some(stop.clone());
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        let result = macos::capture_and_transcribe(
            app_for_thread.clone(),
            root,
            model_variant,
            stop,
            recording_id.clone(),
            session_id,
            workspace_path,
            speaker_diarization,
        );
        #[cfg(not(target_os = "macos"))]
        let result: Result<(), String> = {
            let _ = (
                root,
                model_variant,
                stop,
                session_id,
                workspace_path,
                speaker_diarization,
            );
            Err("unsupported platform".to_string())
        };
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
    use sherpa_onnx::{SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig};
    use std::collections::VecDeque;
    use std::fs::{File, OpenOptions};
    use std::io::Write;
    use std::path::PathBuf;
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
    const SPEAKER_MATCH_THRESHOLD: f32 = 0.5;
    const MAX_SPEAKERS: usize = 15;
    const TRANSCRIPT_BACKUP_AFTER_MS: u64 = 2 * 60 * 1000;

    struct CapturedSegment {
        samples: Vec<f32>,
        started_at_ms: u64,
        ended_at_ms: u64,
    }

    enum InferenceInput {
        Segment(CapturedSegment),
        TranscriptBackupDue,
    }

    struct TranscriptEntry {
        started_at_ms: u64,
        speaker_cluster_id: Option<String>,
        text: String,
    }

    struct TranscriptBackup {
        workspace_path: PathBuf,
        recording_id: String,
        session_id: String,
        started_at: chrono::DateTime<chrono::Local>,
        speaker_diarization: bool,
        due: bool,
        failed: bool,
        pending: Vec<TranscriptEntry>,
        file: Option<File>,
    }

    impl TranscriptBackup {
        fn new(
            workspace_path: PathBuf,
            recording_id: String,
            session_id: String,
            speaker_diarization: bool,
        ) -> Self {
            Self {
                workspace_path,
                recording_id,
                session_id,
                started_at: chrono::Local::now(),
                speaker_diarization,
                due: false,
                failed: false,
                pending: Vec::new(),
                file: None,
            }
        }

        fn mark_due(&mut self) -> Result<(), String> {
            if self.failed {
                return Ok(());
            }
            self.due = true;
            self.ensure_file()
        }

        fn record(
            &mut self,
            started_at_ms: u64,
            speaker_cluster_id: Option<String>,
            text: String,
        ) -> Result<(), String> {
            if self.failed {
                return Ok(());
            }
            let entry = TranscriptEntry {
                started_at_ms,
                speaker_cluster_id,
                text,
            };
            if let Some(file) = &mut self.file {
                Self::write_entry(file, &entry)?;
                file.flush().map_err(|error| error.to_string())?;
                file.sync_data().map_err(|error| error.to_string())?;
            } else {
                self.pending.push(entry);
                if self.due {
                    self.ensure_file()?;
                }
            }
            Ok(())
        }

        fn ensure_file(&mut self) -> Result<(), String> {
            if self.file.is_some() || self.pending.is_empty() {
                return Ok(());
            }
            let directory = self.workspace_path.join("voice-transcripts");
            std::fs::create_dir_all(&directory)
                .map_err(|error| format!("Create transcript directory: {error}"))?;
            let safe_recording_id: String = self
                .recording_id
                .chars()
                .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
                .collect();
            let path = directory.join(format!(
                "voice-{}-{}.md",
                self.started_at.format("%Y%m%d-%H%M%S"),
                safe_recording_id
            ));
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .map_err(|error| format!("Create transcript backup {}: {error}", path.display()))?;
            writeln!(file, "# Voice transcript\n").map_err(|error| error.to_string())?;
            writeln!(file, "- Started: {}", self.started_at.to_rfc3339())
                .map_err(|error| error.to_string())?;
            writeln!(file, "- Recording: `{}`", self.recording_id)
                .map_err(|error| error.to_string())?;
            writeln!(file, "- Session: `{}`", self.session_id)
                .map_err(|error| error.to_string())?;
            writeln!(
                file,
                "- Mode: {}\n\n## Transcript\n",
                if self.speaker_diarization {
                    "silent (CAM++ session-local speaker labels)"
                } else {
                    "trigger"
                }
            )
            .map_err(|error| error.to_string())?;
            for entry in self.pending.drain(..) {
                Self::write_entry(&mut file, &entry)?;
            }
            file.flush().map_err(|error| error.to_string())?;
            file.sync_data().map_err(|error| error.to_string())?;
            self.file = Some(file);
            Ok(())
        }

        fn write_entry(file: &mut File, entry: &TranscriptEntry) -> Result<(), String> {
            let seconds = entry.started_at_ms / 1000;
            let timestamp = format!(
                "{:02}:{:02}:{:02}",
                seconds / 3600,
                (seconds / 60) % 60,
                seconds % 60
            );
            match &entry.speaker_cluster_id {
                Some(speaker) => writeln!(file, "[{timestamp}] {speaker}: {}", entry.text),
                None => writeln!(file, "[{timestamp}] {}", entry.text),
            }
            .map_err(|error| error.to_string())
        }
    }

    struct SpeakerCluster {
        center: Vec<f32>,
        updates: usize,
    }

    struct SpeakerClusterer {
        extractor: SpeakerEmbeddingExtractor,
        clusters: Vec<SpeakerCluster>,
        last_speaker: usize,
    }

    impl SpeakerClusterer {
        fn new(model: &std::path::Path) -> Result<Self, String> {
            let extractor = SpeakerEmbeddingExtractor::create(&SpeakerEmbeddingExtractorConfig {
                model: Some(model.to_string_lossy().into_owned()),
                num_threads: 1,
                debug: false,
                provider: Some("cpu".to_string()),
            })
            .ok_or("initialize CAM++ speaker model")?;
            Ok(Self {
                extractor,
                clusters: Vec::new(),
                last_speaker: 0,
            })
        }

        fn assign(&mut self, samples: &[f32]) -> Result<String, String> {
            let stream = self
                .extractor
                .create_stream()
                .ok_or("create CAM++ audio stream")?;
            stream.accept_waveform(SAMPLE_RATE as i32, samples);
            stream.input_finished();
            if !self.extractor.is_ready(&stream) {
                return Ok(self.last_label());
            }
            let embedding = self
                .extractor
                .compute(&stream)
                .ok_or("extract CAM++ speaker embedding")?;
            self.last_speaker = assign_speaker_embedding(&mut self.clusters, embedding);
            Ok(self.last_label())
        }

        fn last_label(&self) -> String {
            format!("speaker_{:02}", self.last_speaker + 1)
        }
    }

    fn assign_speaker_embedding(clusters: &mut Vec<SpeakerCluster>, embedding: Vec<f32>) -> usize {
        let Some(embedding) = normalize_embedding(embedding) else {
            return 0;
        };
        let best = clusters
            .iter()
            .enumerate()
            .filter(|(_, cluster)| cluster.center.len() == embedding.len())
            .map(|(index, cluster)| (index, dot(&cluster.center, &embedding)))
            .max_by(|left, right| left.1.total_cmp(&right.1));

        let index = match best {
            Some((index, similarity)) if similarity >= SPEAKER_MATCH_THRESHOLD => index,
            Some((index, _)) if clusters.len() >= MAX_SPEAKERS => index,
            _ => {
                clusters.push(SpeakerCluster {
                    center: embedding,
                    updates: 1,
                });
                return clusters.len() - 1;
            }
        };

        let cluster = &mut clusters[index];
        let weight = 1.0 / (cluster.updates + 1).min(20) as f32;
        for (center, sample) in cluster.center.iter_mut().zip(embedding) {
            *center = (1.0 - weight) * *center + weight * sample;
        }
        if let Some(normalized) = normalize_embedding(std::mem::take(&mut cluster.center)) {
            cluster.center = normalized;
        }
        cluster.updates += 1;
        index
    }

    fn normalize_embedding(mut embedding: Vec<f32>) -> Option<Vec<f32>> {
        let norm = embedding
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt();
        if !norm.is_finite() || norm <= f32::EPSILON {
            return None;
        }
        for value in &mut embedding {
            *value /= norm;
        }
        Some(embedding)
    }

    fn dot(left: &[f32], right: &[f32]) -> f32 {
        left.iter()
            .zip(right)
            .map(|(left, right)| left * right)
            .sum()
    }

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
        model_variant: VoiceModelVariant,
        stop: Arc<AtomicBool>,
        recording_id: String,
        session_id: String,
        workspace_path: PathBuf,
        speaker_diarization: bool,
    ) -> Result<(), String> {
        let (audio_tx, audio_rx) = mpsc::channel::<Vec<f32>>();
        let (segment_tx, segment_rx) = mpsc::channel::<InferenceInput>();
        let inference_app = app.clone();
        let inference_root = root.clone();
        let mut speaker_clusterer = speaker_diarization
            .then(|| SpeakerClusterer::new(&speaker_model_path(&root)))
            .transpose()?;
        let mut transcript_backup = TranscriptBackup::new(
            workspace_path,
            recording_id.clone(),
            session_id,
            speaker_diarization,
        );
        let inference = std::thread::spawn(move || {
            for input in segment_rx {
                let segment = match input {
                    InferenceInput::TranscriptBackupDue => {
                        if let Err(message) = transcript_backup.mark_due() {
                            transcript_backup.failed = true;
                            let _ = inference_app.emit(
                                "voice:error",
                                serde_json::json!({ "code": "backup_failed", "message": message }),
                            );
                        }
                        continue;
                    }
                    InferenceInput::Segment(segment) => segment,
                };
                match transcribe_segment(&inference_root, model_variant, &segment.samples) {
                    Ok(text) if !text.is_empty() => {
                        let speaker_cluster_id = speaker_clusterer.as_mut().map(|clusterer| {
                            clusterer.assign(&segment.samples).unwrap_or_else(|error| {
                                log::warn!("CAM++ speaker assignment failed: {error}");
                                clusterer.last_label()
                            })
                        });
                        if let Err(message) = transcript_backup.record(
                            segment.started_at_ms,
                            speaker_cluster_id.clone(),
                            text.clone(),
                        ) {
                            transcript_backup.failed = true;
                            let _ = inference_app.emit(
                                "voice:error",
                                serde_json::json!({ "code": "backup_failed", "message": message }),
                            );
                        }
                        let _ = inference_app.emit(
                            "voice:segment",
                            SegmentPayload {
                                segment_id: uuid::Uuid::new_v4().to_string(),
                                recording_id: recording_id.clone(),
                                text,
                                started_at_ms: segment.started_at_ms,
                                ended_at_ms: segment.ended_at_ms,
                                speaker_cluster_id,
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
        let (device, supported) = select_input_device(&host)?;
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
        let mut backup_due_sent = false;
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
            if !backup_due_sent
                && started.elapsed().as_millis() as u64 >= TRANSCRIPT_BACKUP_AFTER_MS
            {
                let _ = segment_tx.send(InferenceInput::TranscriptBackupDue);
                backup_due_sent = true;
            }
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
                finalize(
                    &segment_tx,
                    &mut active,
                    silence,
                    started.elapsed().as_millis() as u64,
                );
                silence = 0;
            }
        }
        drop(stream);
        let _ = pump.join();
        finalize(
            &segment_tx,
            &mut active,
            silence,
            started.elapsed().as_millis() as u64,
        );
        if !backup_due_sent && started.elapsed().as_millis() as u64 >= TRANSCRIPT_BACKUP_AFTER_MS {
            let _ = segment_tx.send(InferenceInput::TranscriptBackupDue);
        }
        drop(segment_tx);
        let _ = inference.join();
        Ok(())
    }

    fn select_input_device(
        host: &cpal::Host,
    ) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
        if let Some(device) = host.default_input_device() {
            match input_config(&device) {
                Ok(config) => return Ok((device, config)),
                Err(error) => log::warn!("default voice input device is unavailable: {error}"),
            }
        }

        let devices = host
            .input_devices()
            .map_err(|error| microphone_unavailable(&error.to_string()))?;
        for device in devices {
            if let Ok(config) = input_config(&device) {
                return Ok((device, config));
            }
        }
        Err(microphone_unavailable("no usable CoreAudio input device"))
    }

    fn input_config(device: &cpal::Device) -> Result<cpal::SupportedStreamConfig, String> {
        if let Ok(config) = device.default_input_config() {
            return Ok(config);
        }
        let mut configs = device
            .supported_input_configs()
            .map_err(|error| error.to_string())?;
        let range = configs
            .find(|range| {
                range.channels() > 0
                    && matches!(
                        range.sample_format(),
                        cpal::SampleFormat::F32 | cpal::SampleFormat::I16 | cpal::SampleFormat::U16
                    )
            })
            .ok_or("no supported PCM input format")?;
        Ok(range
            .try_with_sample_rate(48_000)
            .unwrap_or_else(|| range.with_max_sample_rate()))
    }

    fn microphone_unavailable(detail: &str) -> String {
        log::warn!("voice input device unavailable: {detail}");
        if crate::commands::prefers_zh_locale() {
            "默认麦克风不可用。请在 macOS 系统设置 > 声音 > 输入中选择一个可用设备后重试。"
                .to_string()
        } else {
            "The default microphone is unavailable. Select an input device in macOS System Settings > Sound > Input, then try again."
                .to_string()
        }
    }

    fn finalize(
        sender: &mpsc::Sender<InferenceInput>,
        active: &mut Vec<f32>,
        silence_steps: usize,
        ended_at_ms: u64,
    ) {
        let trim_steps = silence_steps.saturating_sub(2);
        active.truncate(active.len().saturating_sub(trim_steps * STEP_SAMPLES));
        if active.len() >= MIN_SPEECH_SAMPLES {
            let duration_ms = active.len() as u64 * 1000 / SAMPLE_RATE as u64;
            let _ = sender.send(InferenceInput::Segment(CapturedSegment {
                samples: std::mem::take(active),
                started_at_ms: ended_at_ms.saturating_sub(duration_ms),
                ended_at_ms,
            }));
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

    fn transcribe_segment(
        root: &std::path::Path,
        model_variant: VoiceModelVariant,
        samples: &[f32],
    ) -> Result<String, String> {
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
            .arg(model_path(root, model_variant))
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
            finalize(&sender, &mut active, 0, 1_000);
            assert!(receiver.try_recv().is_err());
            assert!(active.is_empty());
        }

        #[test]
        fn finalize_emits_speech_and_trims_excess_silence() {
            let (sender, receiver) = mpsc::channel();
            let original_len = MIN_SPEECH_SAMPLES + SILENCE_STEPS * STEP_SAMPLES;
            let mut active = vec![0.2_f32; original_len];
            finalize(&sender, &mut active, SILENCE_STEPS, 2_000);
            let InferenceInput::Segment(segment) = receiver.try_recv().expect("final segment")
            else {
                panic!("expected audio segment");
            };
            assert_eq!(
                segment.samples.len(),
                original_len - (SILENCE_STEPS - 2) * STEP_SAMPLES
            );
            assert_eq!(segment.ended_at_ms, 2_000);
            assert!(active.is_empty());
        }

        #[test]
        fn transcript_backup_is_not_created_before_two_minutes() {
            let workspace = tempfile::tempdir().expect("temp workspace");
            let mut backup = TranscriptBackup::new(
                workspace.path().to_path_buf(),
                "recording-short".to_string(),
                "session-1".to_string(),
                true,
            );
            backup
                .record(1_000, Some("speaker_01".to_string()), "你好".to_string())
                .expect("buffer transcript");
            assert!(!workspace.path().join("voice-transcripts").exists());
        }

        #[test]
        fn transcript_backup_flushes_buffered_speaker_lines_when_due() {
            let workspace = tempfile::tempdir().expect("temp workspace");
            let mut backup = TranscriptBackup::new(
                workspace.path().to_path_buf(),
                "recording-long".to_string(),
                "session-1".to_string(),
                true,
            );
            backup
                .record(1_000, Some("speaker_01".to_string()), "你好".to_string())
                .expect("buffer first transcript");
            backup.mark_due().expect("create transcript backup");
            backup
                .record(
                    121_000,
                    Some("speaker_02".to_string()),
                    "大家好".to_string(),
                )
                .expect("append transcript");

            let directory = workspace.path().join("voice-transcripts");
            let path = std::fs::read_dir(directory)
                .expect("transcript directory")
                .next()
                .expect("transcript file")
                .expect("transcript entry")
                .path();
            let transcript = std::fs::read_to_string(path).expect("read transcript");
            assert!(transcript.contains("- Session: `session-1`"));
            assert!(transcript.contains("[00:00:01] speaker_01: 你好"));
            assert!(transcript.contains("[00:02:01] speaker_02: 大家好"));
        }

        #[test]
        fn trigger_transcript_does_not_add_a_speaker_label() {
            let workspace = tempfile::tempdir().expect("temp workspace");
            let mut backup = TranscriptBackup::new(
                workspace.path().to_path_buf(),
                "recording-trigger".to_string(),
                "session-1".to_string(),
                false,
            );
            backup.mark_due().expect("mark backup due");
            backup
                .record(120_000, None, "执行任务".to_string())
                .expect("write transcript");

            let path = std::fs::read_dir(workspace.path().join("voice-transcripts"))
                .expect("transcript directory")
                .next()
                .expect("transcript file")
                .expect("transcript entry")
                .path();
            let transcript = std::fs::read_to_string(path).expect("read transcript");
            assert!(transcript.contains("[00:02:00] 执行任务"));
            assert!(!transcript.contains("speaker_"));
        }

        #[test]
        fn installed_variant_requires_campplus_and_preserves_legacy_model_choice() {
            let root = tempfile::tempdir().expect("temp voice root");
            std::fs::write(runtime_path(root.path()), []).expect("runtime");
            std::fs::write(vad_path(root.path()), []).expect("vad");
            std::fs::write(model_path(root.path(), VoiceModelVariant::Q8), []).expect("q8");
            assert_eq!(
                base_installed_variant(root.path()),
                Some(VoiceModelVariant::Q8)
            );
            assert_eq!(installed_variant(root.path()), None);

            std::fs::write(speaker_model_path(root.path()), []).expect("speaker");
            assert_eq!(installed_variant(root.path()), Some(VoiceModelVariant::Q8));

            std::fs::write(model_path(root.path(), VoiceModelVariant::F16), []).expect("f16");
            std::fs::write(model_marker_path(root.path()), "f16").expect("marker");
            assert_eq!(installed_variant(root.path()), Some(VoiceModelVariant::F16));
        }

        #[test]
        fn speaker_clusters_keep_similar_embeddings_stable() {
            let mut clusters = Vec::new();
            assert_eq!(
                assign_speaker_embedding(&mut clusters, vec![1.0, 0.0, 0.0]),
                0
            );
            assert_eq!(
                assign_speaker_embedding(&mut clusters, vec![0.95, 0.05, 0.0]),
                0
            );
            assert_eq!(clusters.len(), 1);
        }

        #[test]
        fn speaker_clusters_create_a_new_stable_id_for_a_distinct_voice() {
            let mut clusters = Vec::new();
            assert_eq!(
                assign_speaker_embedding(&mut clusters, vec![1.0, 0.0, 0.0]),
                0
            );
            assert_eq!(
                assign_speaker_embedding(&mut clusters, vec![0.0, 1.0, 0.0]),
                1
            );
            assert_eq!(
                assign_speaker_embedding(&mut clusters, vec![0.0, 0.98, 0.02]),
                1
            );
            assert_eq!(clusters.len(), 2);
        }
    }
}
