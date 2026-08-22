//! RDP output routing.
//!
//! The desktop sidecar writes length-prefixed frames to stdout. Native consumers install an
//! [`OutputSink`] instead, so decoded pixels can go straight to an iOS/Android framebuffer without
//! serialization or a JavaScript/base64 hop.
//!
//! Sidecar writes are owned by dedicated threads. If a session thread wrote directly, a full pipe
//! would also stop socket reads and make the display arrive in bursts.

use std::io::{self, Write as _};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread;

use serde::Serialize;
use tracing::warn;

use core_framing::{write_frame, KIND_CONTROL, KIND_STREAM};

use crate::protocol::{AudioFramePayload, Event, FramePayload};

/// A native output target. Frame and audio byte slices are borrowed only for the duration of the
/// call; implementations that need them afterwards must copy them before returning.
pub trait OutputSink: Send + Sync {
    /// Receives a serialized control [`Event`]. Control JSON contains no framebuffer bytes.
    fn send_event(&self, event_json: &[u8]) -> io::Result<()>;

    /// Receives one decoded RGBA framebuffer rectangle.
    fn send_frame(&self, meta: &FramePayload, pixels: &[u8]) -> io::Result<()>;

    /// Receives decoded remote audio. Native clients may ignore it until an audio renderer is
    /// installed, while the desktop sidecar keeps its existing stream framing path.
    fn send_audio(&self, _meta: &AudioFramePayload, _samples: &[u8]) -> io::Result<()> {
        Ok(())
    }
}

/// 쓰기 대기열 깊이(프레임 수).
///
/// 버스트를 흡수할 만큼은 되어야 하고, 메모리를 무한정 먹으면 안 된다. 전체 화면 갱신 한 장이
/// 대략 20개의 조각으로 오므로 이 정도면 몇 화면치 여유가 된다.
const QUEUE_DEPTH: usize = 64;

/// 소리 대기열 깊이(조각 수).
///
/// 조각 하나가 0.19초쯤이라 이 정도면 몇 초치다. 더 쌓아 봐야 늦은 소리를 내보내는 것이라
/// 의미가 없다.
const AUDIO_QUEUE_DEPTH: usize = 16;

struct Outgoing {
    kind: u8,
    metadata: Vec<u8>,
    payload: Vec<u8>,
}

enum OutputBackend {
    Sidecar {
        tx: SyncSender<Outgoing>,
        /// 소리 전용 줄. 화면이 붐빌 때 소리가 그 뒤에 줄을 서지 않게 한다.
        audio_tx: SyncSender<Outgoing>,
    },
    Sink(Arc<dyn OutputSink>),
}

pub struct Output {
    backend: OutputBackend,
}

impl Output {
    /// Creates the existing desktop stdout backend.
    pub fn new() -> Self {
        let (tx, rx) = sync_channel::<Outgoing>(QUEUE_DEPTH);
        let (audio_tx, audio_rx) = sync_channel::<Outgoing>(AUDIO_QUEUE_DEPTH);

        thread::Builder::new()
            .name("rdp-stdout".to_owned())
            .spawn(move || {
                let stdout = io::stdout();
                let mut handle = stdout.lock();

                let mut write = |frame: Outgoing| -> bool {
                    // 한 프레임은 통째로 나가야 한다. 쓰는 곳이 이 스레드 하나뿐이라 다른 잠금은
                    // 필요 없다.
                    if let Err(error) =
                        write_frame(&mut handle, frame.kind, &frame.metadata, &frame.payload)
                    {
                        warn!(%error, "stdout write failed");
                        return false;
                    }
                    if let Err(error) = handle.flush() {
                        warn!(%error, "stdout flush failed");
                        return false;
                    }
                    true
                };

                loop {
                    // 소리를 먼저 비운다. 조각이 작고 드물어서 화면을 밀어내지 않는다.
                    while let Ok(frame) = audio_rx.try_recv() {
                        if !write(frame) {
                            return;
                        }
                    }

                    match rx.recv_timeout(std::time::Duration::from_millis(2)) {
                        Ok(frame) => {
                            if !write(frame) {
                                return;
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
            })
            .expect("spawn stdout writer");

        Self {
            backend: OutputBackend::Sidecar { tx, audio_tx },
        }
    }

    /// Creates an in-process backend used by native mobile FFI.
    pub fn with_sink(sink: Arc<dyn OutputSink>) -> Self {
        Self {
            backend: OutputBackend::Sink(sink),
        }
    }

    fn send_on(
        channel: &SyncSender<Outgoing>,
        kind: u8,
        metadata: Vec<u8>,
        payload: Vec<u8>,
    ) -> io::Result<()> {
        match channel.try_send(Outgoing {
            kind,
            metadata,
            payload,
        }) {
            Ok(()) => Ok(()),
            // 대기열이 찼다. 여기서 기다리는 것은 예전과 같은 정체지만, 화면 갱신은 델타라
            // 버리면 그 영역이 영영 낡은 채로 남는다 — 늦더라도 보내야 한다.
            Err(TrySendError::Full(frame)) => channel
                .send(frame)
                .map_err(|_| io::Error::other("stdout writer is gone")),
            Err(TrySendError::Disconnected(_)) => Err(io::Error::other("stdout writer is gone")),
        }
    }

    pub fn send_event<T: Serialize>(&self, event: &Event<T>) -> io::Result<()> {
        let metadata = serde_json::to_vec(event).map_err(io::Error::other)?;
        match &self.backend {
            OutputBackend::Sidecar { tx, .. } => {
                Self::send_on(tx, KIND_CONTROL, metadata, Vec::new())
            }
            OutputBackend::Sink(sink) => sink.send_event(&metadata),
        }
    }

    pub fn send_audio(&self, meta: &AudioFramePayload, samples: &[u8]) -> io::Result<()> {
        match &self.backend {
            OutputBackend::Sidecar { audio_tx, .. } => {
                let metadata = serde_json::to_vec(meta).map_err(io::Error::other)?;
                Self::send_on(audio_tx, KIND_STREAM, metadata, samples.to_vec())
            }
            OutputBackend::Sink(sink) => sink.send_audio(meta, samples),
        }
    }

    pub fn send_frame(&self, meta: &FramePayload, pixels: &[u8]) -> io::Result<()> {
        match &self.backend {
            OutputBackend::Sidecar { tx, .. } => {
                let metadata = serde_json::to_vec(meta).map_err(io::Error::other)?;
                Self::send_on(tx, KIND_STREAM, metadata, pixels.to_vec())
            }
            OutputBackend::Sink(sink) => sink.send_frame(meta, pixels),
        }
    }
}

impl Default for Output {
    fn default() -> Self {
        Self::new()
    }
}
