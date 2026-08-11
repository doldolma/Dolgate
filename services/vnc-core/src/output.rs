//! Stdout writer.
//!
//! 세션은 각자 스레드에서 돌고 stdout 은 하나다. 한 프레임의 헤더·메타데이터·페이로드가 다른
//! 쓰기와 섞이면 데스크톱은 프레임 경계를 다시 찾을 수 없다 — 그래서 쓰기는 전용 스레드 하나가
//! 맡는다.
//!
//! 세션 스레드가 직접 쓰면 파이프가 찰 때마다 그 자리에서 막히는데, 그 스레드는 소켓 읽기도 같이
//! 하고 있어서 읽기까지 멈춘다. rdp-core 가 같은 이유로 같은 구조다.

use std::io::{self};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::thread;

use serde::Serialize;
use tracing::warn;

use crate::protocol::{Event, FramePayload};
use core_framing::{write_frame, KIND_CONTROL, KIND_STREAM};

/// 쓰기 대기열 깊이(프레임 수).
///
/// 전체 화면 갱신 한 장이 여러 조각으로 오므로 이 정도면 몇 화면치 여유가 된다. 무한정 쌓으면
/// 화면이 밀릴 때 메모리를 그만큼 먹는다.
const QUEUE_DEPTH: usize = 64;

struct Outgoing {
    kind: u8,
    metadata: Vec<u8>,
    payload: Vec<u8>,
}

#[derive(Clone)]
pub struct Output {
    tx: SyncSender<Outgoing>,
}

impl Output {
    pub fn new() -> Self {
        Self::with_writer(io::stdout())
    }

    /// 프레임을 임의의 writer 로 보낸다.
    ///
    /// 테스트가 실제 stdout 대신 버퍼를 받기 위한 자리다. 이게 없으면 세션 전 구간(협상 → 화면
    /// 사각형)을 검증할 방법이 프로세스를 띄우는 것뿐이 된다.
    pub fn with_writer<W: io::Write + Send + 'static>(writer: W) -> Self {
        let (tx, rx) = sync_channel::<Outgoing>(QUEUE_DEPTH);

        thread::Builder::new()
            .name("vnc-stdout".to_owned())
            .spawn(move || {
                let mut handle = writer;
                for frame in rx {
                    // 한 프레임은 통째로 나가야 한다. 쓰는 곳이 이 스레드 하나뿐이라 다른 잠금은
                    // 필요 없다.
                    if let Err(error) =
                        write_frame(&mut handle, frame.kind, &frame.metadata, &frame.payload)
                    {
                        warn!(%error, "stdout write failed");
                        return;
                    }
                    if let Err(error) = handle.flush() {
                        warn!(%error, "stdout flush failed");
                        return;
                    }
                }
            })
            .expect("stdout writer 스레드를 만들 수 없다");

        Self { tx }
    }

    /// 제어 이벤트. 잃어버리면 데스크톱이 상태를 영구히 잘못 알게 되므로 자리가 날 때까지 기다린다.
    pub fn send_event<T: Serialize>(&self, event: &Event<T>) -> io::Result<()> {
        let metadata = serde_json::to_vec(event)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        self.tx
            .send(Outgoing {
                kind: KIND_CONTROL,
                metadata,
                payload: Vec::new(),
            })
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "stdout writer 가 멈췄다"))
    }

    /// 픽셀 프레임.
    ///
    /// **막히면 버린다.** 화면 갱신은 늦게 도착하면 값이 없고, 여기서 기다리면 소켓 읽기가 멈춰
    /// 서버 쪽이 밀린다. 버린 사각형은 다음 전체 갱신에서 다시 온다 — 뒤에 오는 갱신이 같은
    /// 영역을 덮으므로 화면이 영구히 어긋나지는 않는다.
    pub fn send_frame(&self, meta: &FramePayload, pixels: &[u8]) -> io::Result<()> {
        let metadata = serde_json::to_vec(meta)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        match self.tx.try_send(Outgoing {
            kind: KIND_STREAM,
            metadata,
            payload: pixels.to_vec(),
        }) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                warn!(
                    width = meta.width,
                    height = meta.height,
                    "stdout 대기열이 차서 프레임을 버렸다"
                );
                Ok(())
            }
            Err(TrySendError::Disconnected(_)) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "stdout writer 가 멈췄다",
            )),
        }
    }
}

impl Default for Output {
    fn default() -> Self {
        Self::new()
    }
}
