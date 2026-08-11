//! Stdout writer.
//!
//! Sessions run on their own threads but share one stdout, and a frame's header/metadata/payload
//! must not be split by another writer — the desktop side reads frames sequentially and cannot
//! resynchronize after an interleave.
//!
//! 쓰기는 전용 스레드가 맡는다. 세션 스레드가 직접 쓰면 파이프가 찰 때마다 그 자리에서 막히는데,
//! 그 스레드는 RDP 소켓 읽기도 같이 하고 있어서 읽기까지 멈춘다. 프레임 하나가 수백 KB 이고
//! 파이프 버퍼는 64KiB 라 이 일은 자주 일어나고, 그동안 서버 쪽이 밀렸다가 풀리면 한꺼번에
//! 쏟아진다 — 화면이 뭉텅이로 왔다 멎기를 반복하는 원인이다.

use std::io::{self, Write as _};
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::thread;

use serde::Serialize;
use tracing::warn;

use core_framing::{write_frame, KIND_CONTROL, KIND_STREAM};
use crate::protocol::{AudioFramePayload, Event, FramePayload};

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

pub struct Output {
    tx: SyncSender<Outgoing>,
    /// 소리 전용 줄.
    ///
    /// 한 줄로 같이 보내면 화면이 붐빌 때 소리가 그 뒤에 줄을 선다. 화면은 늦으면 늦은 대로
    /// 보이지만 소리는 늦으면 끊긴 것으로 들린다 — 0.19초짜리 조각이 0.47초마다 도착하면
    /// 재생이 계속 끊긴다(실측).
    audio_tx: SyncSender<Outgoing>,
}

impl Output {
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

        Self { tx, audio_tx }
    }

    fn send_on(
        &self,
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

    fn send(&self, kind: u8, metadata: Vec<u8>, payload: Vec<u8>) -> io::Result<()> {
        self.send_on(&self.tx, kind, metadata, payload)
    }

    pub fn send_event<T: Serialize>(&self, event: &Event<T>) -> io::Result<()> {
        let metadata = serde_json::to_vec(event).map_err(io::Error::other)?;
        self.send(KIND_CONTROL, metadata, Vec::new())
    }

    pub fn send_audio(&self, meta: &AudioFramePayload, samples: &[u8]) -> io::Result<()> {
        let metadata = serde_json::to_vec(meta).map_err(io::Error::other)?;
        self.send_on(&self.audio_tx, KIND_STREAM, metadata, samples.to_vec())
    }

    pub fn send_frame(&self, meta: &FramePayload, pixels: &[u8]) -> io::Result<()> {
        let metadata = serde_json::to_vec(meta).map_err(io::Error::other)?;
        self.send(KIND_STREAM, metadata, pixels.to_vec())
    }
}

impl Default for Output {
    fn default() -> Self {
        Self::new()
    }
}
