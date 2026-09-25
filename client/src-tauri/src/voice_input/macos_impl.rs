use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use block2::RcBlock;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{msg_send, sel};
use parking_lot::Mutex;

use super::{VoiceInputResult, VoiceSupportInfo};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const SF_AUTH_NOT_DETERMINED: i64 = 0;
const SF_AUTH_DENIED: i64 = 1;
const SF_AUTH_RESTRICTED: i64 = 2;
const SF_AUTH_AUTHORIZED: i64 = 3;
const SF_TASK_STATE_COMPLETED: i64 = 4;
const RECOGNITION_WAIT: Duration = Duration::from_secs(60);
const RECOGNITION_POLL: Duration = Duration::from_millis(100);
const COMPLETION_GRACE: Duration = Duration::from_millis(250);
const FINAL_QUIESCENCE: Duration = Duration::from_secs(5);
const AUTHORIZATION_WAIT: Duration = Duration::from_secs(30);
const AVAILABILITY_WAIT: Duration = Duration::from_secs(3);
const AVAILABILITY_POLL: Duration = Duration::from_millis(100);
const DEFAULT_RECORD_TIMEOUT: Duration = Duration::from_secs(10);

trait AudioConsumer: Send + Sync {
    fn consume_pcm_chunk(&self, pcm: &[u8]);
}

struct SendableTask(*mut AnyObject);
unsafe impl Send for SendableTask {}

struct Recorder {
    stop_flag: Arc<AtomicBool>,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

impl Recorder {
    fn start(consumer: Arc<dyn AudioConsumer>) -> Result<Self> {
        let (startup_tx, startup_rx) = mpsc::channel::<Result<()>>();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&stop_flag);

        let join_handle = std::thread::Builder::new()
            .name("siliconmate-recorder".into())
            .spawn(move || {
                run_audio_thread(consumer, stop_for_thread, startup_tx);
            })
            .map_err(|e| anyhow!("spawn audio thread: {e}"))?;

        startup_rx
            .recv()
            .map_err(|e| anyhow!("audio thread vanished: {e}"))??;

        Ok(Self {
            stop_flag,
            join_handle: Some(join_handle),
        })
    }

    fn stop(mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
    }
}

fn run_audio_thread(
    consumer: Arc<dyn AudioConsumer>,
    stop_flag: Arc<AtomicBool>,
    startup_tx: mpsc::Sender<Result<()>>,
) {
    let host = cpal::default_host();
    let device = match host.default_input_device() {
        Some(d) => d,
        None => {
            let _ = startup_tx.send(Err(anyhow!("no microphone input device")));
            return;
        }
    };

    let supported = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            let msg = e.to_string().to_lowercase();
            if msg.contains("permission") || msg.contains("denied") || msg.contains("authoriz") {
                let _ = startup_tx.send(Err(anyhow!("microphone permission denied")));
            } else {
                let _ = startup_tx.send(Err(anyhow!("default_input_config: {e}")));
            }
            return;
        }
    };

    let sample_format = supported.sample_format();
    let default_config: StreamConfig = supported.config();
    let input_sr = default_config.sample_rate.0;
    let channels = default_config.channels as usize;

    let state = Arc::new(StreamState::new());
    let stream = match build_stream_for_format(
        &device,
        &default_config,
        sample_format,
        consumer,
        Arc::clone(&state),
        input_sr,
        channels,
    ) {
        Ok(s) => s,
        Err(e) => {
            let _ = startup_tx.send(Err(e));
            return;
        }
    };

    if let Err(e) = stream.play() {
        let _ = startup_tx.send(Err(anyhow!("play: {e}")));
        return;
    }

    let _ = startup_tx.send(Ok(()));

    while !stop_flag.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(50));
    }

    if let Err(err) = stream.pause() {
        log::warn!("[voice-input] cpal Stream pause failed: {err}");
    }
}

#[allow(clippy::too_many_arguments)]
fn build_stream_for_format(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    consumer: Arc<dyn AudioConsumer>,
    state: Arc<StreamState>,
    input_sr: u32,
    channels: usize,
) -> Result<cpal::Stream> {
    macro_rules! make_stream {
        ($t:ty, $to_f32:expr) => {{
            let consumer = Arc::clone(&consumer);
            let state = Arc::clone(&state);
            device
                .build_input_stream::<$t, _, _>(
                    config,
                    move |data: &[$t], _info| {
                        let floats: Vec<f32> = data.iter().map(|s| $to_f32(*s)).collect();
                        process_callback(&floats, channels, input_sr, consumer.as_ref(), &state);
                    },
                    |err| {
                        log::error!("[voice-input] stream error: {err}");
                    },
                    None,
                )
                .map_err(|e| anyhow!("build_input_stream: {e}"))
        }};
    }

    match sample_format {
        SampleFormat::F32 => make_stream!(f32, |s: f32| s),
        SampleFormat::I16 => make_stream!(i16, |s: i16| s as f32 / i16::MAX as f32),
        SampleFormat::U16 => make_stream!(u16, |s: u16| (s as f32 - 32768.0) / 32768.0),
        SampleFormat::I32 => make_stream!(i32, |s: i32| s as f32 / i32::MAX as f32),
        SampleFormat::I8 => make_stream!(i8, |s: i8| s as f32 / i8::MAX as f32),
        SampleFormat::U8 => make_stream!(u8, |s: u8| (s as f32 - 128.0) / 128.0),
        other => Err(anyhow!("unsupported sample format: {other:?}")),
    }
}

struct StreamState {
    resample_phase: Mutex<f64>,
    last_sample: Mutex<f32>,
}

impl StreamState {
    fn new() -> Self {
        Self {
            resample_phase: Mutex::new(0.0),
            last_sample: Mutex::new(0.0),
        }
    }
}

fn process_callback(
    interleaved: &[f32],
    channels: usize,
    input_sr: u32,
    consumer: &dyn AudioConsumer,
    state: &StreamState,
) {
    if interleaved.is_empty() || channels == 0 {
        return;
    }

    let mono = downmix_to_mono(interleaved, channels);
    let resampled = resample_to_target(&mono, input_sr, TARGET_SAMPLE_RATE, state);
    if resampled.is_empty() {
        return;
    }

    let (pcm_bytes, _) = quantize_to_i16_le(&resampled);
    consumer.consume_pcm_chunk(&pcm_bytes);
}

fn downmix_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels == 1 {
        return interleaved.to_vec();
    }
    let frames = interleaved.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for i in 0..frames {
        let base = i * channels;
        let mut sum = 0.0f32;
        for c in 0..channels {
            sum += interleaved[base + c];
        }
        out.push(sum / channels as f32);
    }
    out
}

fn resample_to_target(samples: &[f32], src_sr: u32, dst_sr: u32, state: &StreamState) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    if src_sr == dst_sr {
        if let Some(&last) = samples.last() {
            *state.last_sample.lock() = last;
        }
        return samples.to_vec();
    }

    let step = src_sr as f64 / dst_sr as f64;
    let mut phase = *state.resample_phase.lock();
    let prev = *state.last_sample.lock();

    let estimated = ((samples.len() as f64) / step).ceil() as usize + 1;
    let mut out = Vec::with_capacity(estimated);

    while phase < samples.len() as f64 {
        let idx_floor = phase.floor() as isize;
        let frac = (phase - phase.floor()) as f32;
        let a = if idx_floor < 0 {
            prev
        } else {
            samples[idx_floor as usize]
        };
        let b_index = (idx_floor + 1) as usize;
        if b_index >= samples.len() {
            out.push(a);
            phase += step;
            break;
        }
        let b = samples[b_index];
        out.push(a + (b - a) * frac);
        phase += step;
    }

    let new_phase = phase - samples.len() as f64;
    *state.resample_phase.lock() = new_phase.max(0.0);
    *state.last_sample.lock() = *samples.last().unwrap_or(&0.0);

    out
}

fn quantize_to_i16_le(samples: &[f32]) -> (Vec<u8>, f32) {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    let mut sum_sq = 0.0f64;
    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        let q = (clamped * 32767.0) as i16;
        bytes.extend_from_slice(&q.to_le_bytes());
        let n = clamped as f64;
        sum_sq += n * n;
    }
    let rms = if samples.is_empty() {
        0.0
    } else {
        (sum_sq / samples.len() as f64).sqrt() as f32
    };
    (bytes, rms)
}

struct AppleSpeechAsr {
    buffer: Mutex<Vec<u8>>,
    locale: Option<String>,
    cancel_flag: Arc<AtomicBool>,
    active_task: Arc<Mutex<Option<SendableTask>>>,
}

impl AppleSpeechAsr {
    fn new(locale: Option<String>) -> Self {
        Self {
            buffer: Mutex::new(Vec::new()),
            locale,
            cancel_flag: Arc::new(AtomicBool::new(false)),
            active_task: Arc::new(Mutex::new(None)),
        }
    }

    async fn transcribe(&self) -> Result<String> {
        let pcm = self.buffer.lock().clone();
        if pcm.is_empty() {
            return Ok(String::new());
        }
        let duration_ms = (pcm.len() as u64 / 2) * 1000 / 16_000;
        let locale = self.locale.clone();

        self.cancel_flag.store(false, Ordering::SeqCst);
        let cancel_flag = Arc::clone(&self.cancel_flag);
        let active_task = Arc::clone(&self.active_task);

        let result = tauri::async_runtime::spawn_blocking(move || {
            transcribe_pcm_blocking(&pcm, duration_ms, locale.as_deref(), &cancel_flag, &active_task)
        })
        .await
        .context("spawn_blocking join failed")?;

        if result.is_ok() {
            self.buffer.lock().clear();
        }
        result
    }

    fn cancel(&self) {
        self.cancel_flag.store(true, Ordering::SeqCst);
        if let Some(task) = self.active_task.lock().take() {
            let _: () = unsafe { msg_send![task.0, cancel] };
        }
        self.buffer.lock().clear();
    }
}

impl AudioConsumer for AppleSpeechAsr {
    fn consume_pcm_chunk(&self, pcm: &[u8]) {
        self.buffer.lock().extend_from_slice(pcm);
    }
}

fn encode_wav_16k_mono(samples: &[i16]) -> Vec<u8> {
    let sample_rate: u32 = 16_000;
    let num_channels: u16 = 1;
    let bits_per_sample: u16 = 16;
    let bytes_per_sample = bits_per_sample as u32 / 8;
    let byte_rate = sample_rate * num_channels as u32 * bytes_per_sample;
    let block_align = num_channels * (bits_per_sample / 8);
    let data_size = samples.len() as u32 * bytes_per_sample;
    let chunk_size = 36 + data_size;

    let mut wav = Vec::with_capacity(44 + data_size as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&chunk_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&num_channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

fn transcribe_pcm_blocking(
    pcm: &[u8],
    duration_ms: u64,
    locale: Option<&str>,
    cancel_flag: &AtomicBool,
    active_task: &Mutex<Option<SendableTask>>,
) -> Result<String> {
    ensure_authorized()?;

    let samples: Vec<i16> = pcm
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    let wav = encode_wav_16k_mono(&samples);

    let path = std::env::temp_dir().join(format!(
        "siliconmate-apple-speech-{}-{}.wav",
        std::process::id(),
        unique_suffix()
    ));
    std::fs::write(&path, &wav).with_context(|| format!("write temp wav: {}", path.display()))?;
    let _cleanup = TempFileGuard(&path);

    let path_str = path
        .to_str()
        .ok_or_else(|| anyhow!("temp wav path non-utf8: {}", path.display()))?;
    recognize_file(path_str, locale, duration_ms, cancel_flag, active_task)
}

fn ensure_authorized() -> Result<()> {
    let cls = speech_recognizer_class()?;

    let status: i64 = unsafe { msg_send![cls, authorizationStatus] };
    if status == SF_AUTH_AUTHORIZED {
        return Ok(());
    }
    if status == SF_AUTH_DENIED {
        bail!("Speech recognition permission denied. Please allow in System Settings > Privacy & Security > Speech Recognition.");
    }
    if status == SF_AUTH_RESTRICTED {
        bail!("Speech recognition restricted on this device.");
    }
    if status != SF_AUTH_NOT_DETERMINED {
        bail!("Speech recognition authorization unknown: {status}");
    }

    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |granted_status: i64| {
        let _ = tx.send(granted_status);
    });
    let _: () = unsafe { msg_send![cls, requestAuthorization: &*block] };

    let granted = match rx.recv_timeout(AUTHORIZATION_WAIT) {
        Ok(s) => s,
        Err(err) => bail!("authorization wait failed: {err}"),
    };
    match granted {
        SF_AUTH_AUTHORIZED => Ok(()),
        SF_AUTH_DENIED => bail!("Speech recognition permission denied."),
        SF_AUTH_RESTRICTED => bail!("Speech recognition restricted."),
        other => bail!("Speech recognition not authorized (status {other})"),
    }
}

fn recognize_file(
    wav_path: &str,
    locale: Option<&str>,
    duration_ms: u64,
    cancel_flag: &AtomicBool,
    active_task: &Mutex<Option<SendableTask>>,
) -> Result<String> {
    let recognizer = create_recognizer(locale)?;
    wait_until_available(recognizer)?;

    let url = file_url(wav_path)?;
    let request = create_url_request(url)?;
    configure_on_device(recognizer, request);

    let _: () = unsafe { msg_send![request, setShouldReportPartialResults: Bool::new(true)] };

    let shared = Arc::new(Mutex::new(RecognitionShared::default()));
    let shared_cb = Arc::clone(&shared);
    let block = RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
        let (recognized, callback_error) = extract_callback(result, error);
        let mut s = shared_cb.lock();
        s.record_callback(recognized, callback_error, Instant::now());
    });

    let task: *mut AnyObject = unsafe {
        msg_send![
            recognizer,
            recognitionTaskWithRequest: request,
            resultHandler: &*block
        ]
    };

    *active_task.lock() = Some(SendableTask(task));
    let _task_guard = ActiveTaskGuard(active_task);

    let deadline = Instant::now() + recognition_wait_budget(duration_ms);
    loop {
        let now = Instant::now();
        let mut s = shared.lock();
        let decision = s.lifecycle.decide(
            now,
            cancel_flag.load(Ordering::SeqCst),
            s.error.is_some(),
            now >= deadline,
        );
        match decision {
            RecognitionDecision::Cancel => {
                drop(s);
                if let Some(t) = active_task.lock().take() {
                    let _: () = unsafe { msg_send![t.0, cancel] };
                }
                bail!("Speech recognition cancelled");
            }
            RecognitionDecision::Error => {
                let Some(err) = s.error.take() else {
                    bail!("recognition error without details");
                };
                let salvaged = s.acc.salvage();
                if salvaged.is_empty() {
                    bail!("Speech recognition failed: {err}");
                }
                return Ok(salvaged);
            }
            RecognitionDecision::Finish => {
                let text = s.acc.salvage();
                return Ok(text);
            }
            RecognitionDecision::Timeout => bail!("Speech recognition timeout"),
            RecognitionDecision::Wait => drop(s),
        }

        std::thread::sleep(RECOGNITION_POLL);
        let state: i64 = unsafe { msg_send![task, state] };
        if state == SF_TASK_STATE_COMPLETED {
            shared.lock().lifecycle.record_completed(Instant::now());
        }
    }
}

fn recognition_wait_budget(duration_ms: u64) -> Duration {
    RECOGNITION_WAIT.max(Duration::from_millis(duration_ms).saturating_add(Duration::from_secs(30)))
}

struct ActiveTaskGuard<'a>(&'a Mutex<Option<SendableTask>>);

impl Drop for ActiveTaskGuard<'_> {
    fn drop(&mut self) {
        *self.0.lock() = None;
    }
}

fn wait_until_available(recognizer: *mut AnyObject) -> Result<()> {
    let deadline = Instant::now() + AVAILABILITY_WAIT;
    loop {
        let available: Bool = unsafe { msg_send![recognizer, isAvailable] };
        if available.as_bool() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("Speech recognizer not available. Try System Settings > Keyboard > Dictation to download language resources.");
        }
        std::thread::sleep(AVAILABILITY_POLL);
    }
}

fn configure_on_device(recognizer: *mut AnyObject, request: *mut AnyObject) {
    let supports: Bool = unsafe { msg_send![recognizer, supportsOnDeviceRecognition] };
    if supports.as_bool() {
        let _: () = unsafe { msg_send![request, setRequiresOnDeviceRecognition: Bool::new(true)] };
    }
}

#[derive(Default)]
struct RecognitionShared {
    acc: SegmentAccumulator,
    lifecycle: RecognitionLifecycle,
    error: Option<String>,
}

struct RecognizedCallback {
    text: String,
    utterance_ended: bool,
    is_final: bool,
}

impl RecognitionShared {
    fn record_callback(
        &mut self,
        recognized: Option<RecognizedCallback>,
        error: Option<String>,
        at: Instant,
    ) {
        if let Some(result) = recognized {
            self.acc
                .fold(&result.text, result.utterance_ended, result.is_final);
            self.lifecycle.record_callback(at, result.is_final);
        }
        if self.error.is_none() {
            self.error = error;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecognitionDecision {
    Wait,
    Finish,
    Cancel,
    Error,
    Timeout,
}

#[derive(Default)]
struct RecognitionLifecycle {
    completed_at: Option<Instant>,
    last_callback_at: Option<Instant>,
    saw_final: bool,
}

impl RecognitionLifecycle {
    fn record_callback(&mut self, at: Instant, is_final: bool) {
        self.last_callback_at = Some(at);
        self.saw_final |= is_final;
    }

    fn record_completed(&mut self, at: Instant) {
        self.completed_at.get_or_insert(at);
    }

    fn decide(
        &self,
        now: Instant,
        cancelled: bool,
        has_error: bool,
        deadline_reached: bool,
    ) -> RecognitionDecision {
        if cancelled {
            return RecognitionDecision::Cancel;
        }
        if has_error {
            return RecognitionDecision::Error;
        }

        let completion_settled = self
            .completed_at
            .map(|at| now.saturating_duration_since(at) >= COMPLETION_GRACE)
            .unwrap_or(false)
            && self
                .last_callback_at
                .map(|at| now.saturating_duration_since(at) >= COMPLETION_GRACE)
                .unwrap_or(true);
        let final_quiesced = self.saw_final
            && self
                .last_callback_at
                .map(|at| now.saturating_duration_since(at) >= FINAL_QUIESCENCE)
                .unwrap_or(false);
        if completion_settled || final_quiesced {
            return RecognitionDecision::Finish;
        }
        if deadline_reached {
            return RecognitionDecision::Timeout;
        }
        RecognitionDecision::Wait
    }
}

fn extract_callback(
    result: *mut AnyObject,
    error: *mut AnyObject,
) -> (Option<RecognizedCallback>, Option<String>) {
    let callback_error = if !error.is_null() {
        Some(ns_error_description(error))
    } else if result.is_null() {
        Some("recognition returned null result".to_string())
    } else {
        None
    };
    if result.is_null() {
        return (None, callback_error);
    }
    let is_final: Bool = unsafe { msg_send![result, isFinal] };
    let has_metadata_sel: Bool =
        unsafe { msg_send![result, respondsToSelector: sel!(speechRecognitionMetadata)] };
    let utterance_ended = if has_metadata_sel.as_bool() {
        let metadata: *mut AnyObject = unsafe { msg_send![result, speechRecognitionMetadata] };
        !metadata.is_null()
    } else {
        false
    };
    let transcription: *mut AnyObject = unsafe { msg_send![result, bestTranscription] };
    let text = if transcription.is_null() {
        String::new()
    } else {
        let formatted: *mut AnyObject = unsafe { msg_send![transcription, formattedString] };
        ns_string_to_rust(formatted)
    };
    let recognized = RecognizedCallback {
        text,
        utterance_ended,
        is_final: is_final.as_bool(),
    };
    (Some(recognized), callback_error)
}

#[derive(Default)]
struct SegmentAccumulator {
    segments: Vec<String>,
    current: String,
    current_generation_active: bool,
    cumulative_replay_candidate: Option<String>,
}

impl SegmentAccumulator {
    fn fold(&mut self, text: &str, utterance_ended: bool, is_final: bool) {
        if utterance_ended {
            let segment = if text.trim().is_empty() {
                std::mem::take(&mut self.current)
            } else {
                text.to_string()
            };
            self.push_segment(&segment);
            self.current.clear();
            self.current_generation_active = false;
            self.cumulative_replay_candidate = Some(normalized(&self.joined()));
        } else if is_final {
            let segment = if text.trim().is_empty() {
                std::mem::take(&mut self.current)
            } else {
                text.to_string()
            };
            let normalized_segment = normalized(&segment);
            let is_cumulative_replay = !self.current_generation_active
                && self.cumulative_replay_candidate.as_deref() == Some(normalized_segment.as_str());
            if !is_cumulative_replay {
                self.push_segment(&segment);
                self.cumulative_replay_candidate = None;
            }
            self.current.clear();
            self.current_generation_active = false;
        } else if self.reset_detected(text) {
            let previous = std::mem::take(&mut self.current);
            self.push_segment(&previous);
            self.current = text.to_string();
            self.current_generation_active = true;
            self.cumulative_replay_candidate = None;
        } else {
            self.current = text.to_string();
            self.current_generation_active = true;
            self.cumulative_replay_candidate = None;
        }
    }

    fn reset_detected(&self, text: &str) -> bool {
        let current_chars = self.current.chars().count();
        let new_chars = text.chars().count();
        current_chars >= 12 && new_chars.saturating_mul(3) < current_chars
    }

    fn push_segment(&mut self, text: &str) {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return;
        }
        self.segments.push(trimmed.to_string());
    }

    fn salvage(&mut self) -> String {
        if self.current_generation_active {
            let current = std::mem::take(&mut self.current);
            self.push_segment(&current);
            self.current_generation_active = false;
        }
        self.joined()
    }

    fn joined(&self) -> String {
        let mut out = String::new();
        for segment in &self.segments {
            if out.is_empty() {
                out.push_str(segment);
                continue;
            }
            let join_bare = matches!(
                (out.chars().last(), segment.chars().next()),
                (Some(prev), Some(next)) if should_join_without_space(prev, next)
            );
            if !join_bare {
                out.push(' ');
            }
            out.push_str(segment);
        }
        out
    }
}

fn should_join_without_space(prev: char, next: char) -> bool {
    (is_han_or_japanese(prev) && is_han_or_japanese(next))
        || (is_cjk_punctuation(prev) && is_han_or_japanese(next))
        || (is_han_or_japanese(prev) && is_cjk_punctuation(next))
        || is_opening_punctuation(prev)
        || is_closing_punctuation(next)
}

fn is_han_or_japanese(c: char) -> bool {
    matches!(
        c as u32,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x20000..=0x2FA1F
            | 0x3040..=0x30FF
            | 0x31F0..=0x31FF
            | 0xFF66..=0xFF9D
    )
}

fn is_cjk_punctuation(c: char) -> bool {
    matches!(
        c,
        '、' | '。'
            | '，'
            | '！'
            | '？'
            | '：'
            | '；'
            | '「'
            | '」'
            | '『'
            | '』'
            | '【'
            | '】'
            | '《'
            | '》'
            | '〈'
            | '〉'
            | '・'
            | '〜'
            | '…'
            | '—'
    )
}

fn is_opening_punctuation(c: char) -> bool {
    matches!(
        c,
        '(' | '[' | '{' | '（' | '［' | '｛' | '「' | '『' | '【' | '《' | '〈'
    )
}

fn is_closing_punctuation(c: char) -> bool {
    matches!(
        c,
        ',' | '.'
            | '!'
            | '?'
            | ':'
            | ';'
            | ')'
            | ']'
            | '}'
            | '，'
            | '。'
            | '！'
            | '？'
            | '：'
            | '；'
            | '）'
            | '］'
            | '｝'
            | '、'
            | '」'
            | '』'
            | '】'
            | '》'
            | '〉'
    )
}

fn normalized(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn speech_recognizer_class() -> Result<&'static AnyClass> {
    AnyClass::get("SFSpeechRecognizer")
        .ok_or_else(|| anyhow!("SFSpeechRecognizer not available (requires macOS 10.15+)"))
}

fn create_recognizer(locale: Option<&str>) -> Result<*mut AnyObject> {
    let cls = speech_recognizer_class()?;
    let recognizer: *mut AnyObject = match locale.and_then(ns_locale) {
        Some(ns_loc) => unsafe {
            let alloc: *mut AnyObject = msg_send![cls, alloc];
            msg_send![alloc, initWithLocale: ns_loc]
        },
        None => unsafe {
            let alloc: *mut AnyObject = msg_send![cls, alloc];
            msg_send![alloc, init]
        },
    };
    if recognizer.is_null() {
        bail!("Failed to create SFSpeechRecognizer (locale may not support speech recognition)");
    }
    Ok(recognizer)
}

fn ns_locale(identifier: &str) -> Option<*mut AnyObject> {
    let ns_id = ns_string_from_str(identifier).ok()?;
    let cls = AnyClass::get("NSLocale")?;
    let loc: *mut AnyObject = unsafe { msg_send![cls, localeWithLocaleIdentifier: ns_id] };
    if loc.is_null() {
        None
    } else {
        Some(loc)
    }
}

fn file_url(path: &str) -> Result<*mut AnyObject> {
    let ns_path = ns_string_from_str(path)?;
    let cls = AnyClass::get("NSURL").ok_or_else(|| anyhow!("NSURL not available"))?;
    let url: *mut AnyObject = unsafe { msg_send![cls, fileURLWithPath: ns_path] };
    if url.is_null() {
        bail!("Failed to create file URL: {path}");
    }
    Ok(url)
}

fn create_url_request(url: *mut AnyObject) -> Result<*mut AnyObject> {
    let cls = AnyClass::get("SFSpeechURLRecognitionRequest")
        .ok_or_else(|| anyhow!("SFSpeechURLRecognitionRequest not available"))?;
    let request: *mut AnyObject = unsafe {
        let alloc: *mut AnyObject = msg_send![cls, alloc];
        msg_send![alloc, initWithURL: url]
    };
    if request.is_null() {
        bail!("Failed to create SFSpeechURLRecognitionRequest");
    }
    Ok(request)
}

fn ns_string_from_str(s: &str) -> Result<*mut AnyObject> {
    let c = std::ffi::CString::new(s).context("string contains NUL")?;
    let cls = AnyClass::get("NSString").ok_or_else(|| anyhow!("NSString not available"))?;
    let ns: *mut AnyObject = unsafe { msg_send![cls, stringWithUTF8String: c.as_ptr()] };
    if ns.is_null() {
        bail!("stringWithUTF8String returned nil");
    }
    Ok(ns)
}

fn ns_string_to_rust(ns: *mut AnyObject) -> String {
    if ns.is_null() {
        return String::new();
    }
    let ptr: *const std::os::raw::c_char = unsafe { msg_send![ns, UTF8String] };
    if ptr.is_null() {
        return String::new();
    }
    unsafe { std::ffi::CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned()
}

fn ns_error_description(error: *mut AnyObject) -> String {
    if error.is_null() {
        return "unknown error".to_string();
    }
    let desc: *mut AnyObject = unsafe { msg_send![error, localizedDescription] };
    let message = ns_string_to_rust(desc);
    if message.is_empty() {
        "unknown error".to_string()
    } else {
        message
    }
}

fn unique_suffix() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

struct TempFileGuard<'a>(&'a std::path::Path);

impl Drop for TempFileGuard<'_> {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.0);
    }
}

#[repr(C)]
struct OpaqueCGEvent(std::ffi::c_void);
type CGEventRef = *mut OpaqueCGEvent;

#[repr(C)]
struct OpaqueCGEventSource(std::ffi::c_void);
type CGEventSourceRef = *mut OpaqueCGEventSource;

type CGEventTapLocation = u32;
type CGEventSourceStateID = i32;
type CGKeyCode = u16;
type CGEventFlags = u64;

const KCG_HID_EVENT_TAP: CGEventTapLocation = 0;
const KCG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE: CGEventSourceStateID = 1;
const KCG_EVENT_FLAG_MASK_COMMAND: CGEventFlags = 0x00100000;
const KEY_V: CGKeyCode = 9;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state_id: CGEventSourceStateID) -> CGEventSourceRef;
    fn CGEventCreateKeyboardEvent(
        source: CGEventSourceRef,
        virtual_key: CGKeyCode,
        key_down: bool,
    ) -> CGEventRef;
    fn CGEventSetFlags(event: CGEventRef, flags: CGEventFlags);
    fn CGEventPost(tap: CGEventTapLocation, event: CGEventRef);
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const std::ffi::c_void);
}

fn paste_text_via_clipboard(text: &str) -> Result<()> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| anyhow!("clipboard init: {e}"))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|e| anyhow!("clipboard set: {e}"))?;

    unsafe {
        let source = CGEventSourceCreate(KCG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE);
        let down = CGEventCreateKeyboardEvent(source, KEY_V, true);
        let up = CGEventCreateKeyboardEvent(source, KEY_V, false);
        if down.is_null() || up.is_null() {
            if !source.is_null() {
                CFRelease(source as *const std::ffi::c_void);
            }
            if !down.is_null() {
                CFRelease(down as *const std::ffi::c_void);
            }
            if !up.is_null() {
                CFRelease(up as *const std::ffi::c_void);
            }
            bail!("CGEventCreateKeyboardEvent returned null");
        }
        CGEventSetFlags(down, KCG_EVENT_FLAG_MASK_COMMAND);
        CGEventSetFlags(up, KCG_EVENT_FLAG_MASK_COMMAND);
        CGEventPost(KCG_HID_EVENT_TAP, down);
        CGEventPost(KCG_HID_EVENT_TAP, up);
        CFRelease(down as *const std::ffi::c_void);
        CFRelease(up as *const std::ffi::c_void);
        if !source.is_null() {
            CFRelease(source as *const std::ffi::c_void);
        }
    }
    Ok(())
}

struct VoiceSession {
    asr: Arc<AppleSpeechAsr>,
    recorder: Option<Recorder>,
}

impl VoiceSession {
    fn new(locale: String) -> Self {
        Self {
            asr: Arc::new(AppleSpeechAsr::new(Some(locale))),
            recorder: None,
        }
    }

    fn start_recording(&mut self) -> Result<()> {
        if self.recorder.is_some() {
            bail!("Already recording");
        }
        let asr = Arc::clone(&self.asr);
        self.recorder = Some(Recorder::start(asr)?);
        Ok(())
    }

    async fn stop_and_transcribe(&mut self) -> Result<String> {
        let recorder = self
            .recorder
            .take()
            .ok_or_else(|| anyhow!("Not recording"))?;
        recorder.stop();
        let text = self.asr.transcribe().await?;
        Ok(text)
    }
}

static ACTIVE_SESSION: Mutex<Option<VoiceSession>> = Mutex::new(None);

pub fn detect_voice_support() -> VoiceSupportInfo {
    let cls = AnyClass::get("SFSpeechRecognizer");
    VoiceSupportInfo {
        supported: cls.is_some(),
        method: if cls.is_some() {
            "apple_speech"
        } else {
            "not_available"
        }
        .into(),
        platform: "macos".into(),
    }
}

pub async fn start_voice_input() -> Result<VoiceInputResult, String> {
    let mut session = VoiceSession::new("zh-CN".into());
    session
        .start_recording()
        .map_err(|e| format!("录音启动失败: {e}"))?;

    let asr = Arc::clone(&session.asr);
    tokio::spawn(async move {
        tokio::time::sleep(DEFAULT_RECORD_TIMEOUT).await;
        asr.cancel();
    });

    let text = session
        .stop_and_transcribe()
        .await
        .map_err(|e| format!("语音识别失败: {e}"))?;

    if text.is_empty() {
        return Err("未检测到语音，请重试。".into());
    }

    Ok(VoiceInputResult {
        text,
        confidence: 0.9,
    })
}

pub async fn start_recording() -> Result<(), String> {
    let mut guard = ACTIVE_SESSION.lock();
    if guard.is_some() {
        return Err("已在录音中".into());
    }
    let mut session = VoiceSession::new("zh-CN".into());
    session
        .start_recording()
        .map_err(|e| format!("录音启动失败: {e}"))?;
    *guard = Some(session);
    Ok(())
}

pub async fn stop_recording() -> Result<VoiceInputResult, String> {
    let mut session = {
        let mut guard = ACTIVE_SESSION.lock();
        guard
            .take()
            .ok_or_else(|| "未在录音中".to_string())?
    };
    let text = session
        .stop_and_transcribe()
        .await
        .map_err(|e| format!("语音识别失败: {e}"))?;
    Ok(VoiceInputResult {
        text,
        confidence: 0.9,
    })
}

pub async fn paste_text(text: String) -> Result<(), String> {
    paste_text_via_clipboard(&text).map_err(|e| format!("粘贴失败: {e}"))
}
