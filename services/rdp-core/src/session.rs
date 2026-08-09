//! One RDP session: connect, then pump graphics updates out as stream frames.

use core::time::Duration;
use std::io::Write as _;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, TryRecvError};

use anyhow::Context as _;
use ironrdp::connector::{self, ConnectionResult, Credentials};
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::session::image::DecodedImage;
use ironrdp::connector::connection_activation::{
    ConnectionActivationSequence, ConnectionActivationState,
};
use ironrdp::session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp_pdu::ironrdp_core::WriteBuf;
use ironrdp_displaycontrol::client::DisplayControlClient;
use ironrdp_cliprdr::backend::ClipboardMessage;
use ironrdp_cliprdr::{Cliprdr, CliprdrClient};
use ironrdp_dvc::DrdynvcClient;
use ironrdp_rdpsnd::client::Rdpsnd;
use ironrdp_input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
// `width()` / `height()` on a rectangle come from this trait, not from the struct.
use ironrdp_pdu::Action;
use ironrdp_pdu::geometry::{InclusiveRectangle, Rectangle as _};
use ironrdp_pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use sspi::network_client::reqwest_network_client::ReqwestNetworkClient;
use tokio_rustls::rustls;
use tracing::{debug, info, warn};

use crate::audio::AudioBackend;
use crate::clipboard::TextClipboardBackend;
use crate::output::Output;
use crate::protocol::{
    CertificatePayload, ConnectPayload, ConnectedPayload, Event, FramePayload, InputEvent,
    MonitorPlacement, ResizedPayload,
};

type UpgradedFramed = ironrdp_blocking::Framed<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>;

/// How long a read blocks during the session loop before it comes back around.
///
/// This doubles as the worst-case input latency: queued key and mouse events can only be flushed
/// between reads, because this thread owns the socket. 8ms keeps that under one frame at 120Hz and
/// costs nothing measurable — the loop sits in a syscall the rest of the time.
const SESSION_READ_POLL: Duration = Duration::from_millis(8);

/// How long a read blocks during the connection handshake.
///
/// This one must be generous, not responsive. CredSSP and license exchange wait on the server for
/// far longer than a session poll interval, and the connector treats a timed-out read as a hard
/// error rather than retrying — a short timeout here fails the connection outright.
const HANDSHAKE_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// 인증서 승인을 기다리는 한도.
///
/// 사용자가 프롬프트를 보고 판단할 시간이 필요하므로 넉넉해야 한다. 다만 무한정 기다리면
/// 창을 닫아 버린 세션의 스레드가 영원히 남으므로 상한을 둔다.
const TRUST_VERDICT_TIMEOUT: Duration = Duration::from_secs(180);

pub fn run(
    session_id: String,
    request_id: String,
    payload: ConnectPayload,
    output: Arc<Output>,
    stop: Arc<AtomicBool>,
    input: Receiver<Vec<InputEvent>>,
    trust: Receiver<bool>,
    resize: Receiver<(u16, u16)>,
    refresh: Receiver<()>,
    local_clipboard: Receiver<String>,
) {
    // 그래픽 파이프라인은 한 번 써 보고, 이 서버가 우리가 못 푸는 것을 보내면 그것 없이 다시
    // 붙는다. 접속 도중 판정되므로(첫 화면이 그려질 때) 사용자가 뭘 하기 전에 끝난다.
    // 그래픽 파이프라인을 끄고 붙는 탈출구.
    //
    // 화면이나 소리가 이상할 때 "EGFX 때문인지"를 재빌드 없이 가르려면 이게 필요하다. 실제로
    // 오디오 무음이 EGFX 탓인지 아닌지도 이걸로 갈랐다.
    let mut allow_egfx = std::env::var_os("DOLGATE_RDP_NO_EGFX").is_none();
    let mut trusted_fingerprint: Option<String> = None;

    loop {
        match connect_and_pump(
            &session_id,
            &request_id,
            payload.clone(),
            &output,
            &stop,
            &input,
            &trust,
            &resize,
            &refresh,
            &local_clipboard,
            allow_egfx,
            &mut trusted_fingerprint,
        ) {
            Ok(()) => break,
            Err(error)
                if allow_egfx
                    && error.downcast_ref::<EgfxUnusable>().is_some()
                    && !stop.load(Ordering::Relaxed) =>
            {
                // 사용자에게는 오류를 보내지 않는다. 화면이 잠깐 비었다가 예전 경로로 채워진다.
                info!(session_id, "reconnecting without the graphics pipeline");
                allow_egfx = false;
            }
            Err(error) => {
                warn!(session_id, error = format!("{error:#}"), "session failed");
                let _ = output.send_event(
                    &Event::new("error", crate::protocol::ErrorPayload {
                        message: format!("{error:#}"),
                    })
                    .session(&session_id)
                    .request(&request_id),
                );
                break;
            }
        }
    }

    let _ = output.send_event(
        &Event::new("closed", crate::protocol::EmptyPayload {}).session(&session_id),
    );
}

fn connect_and_pump(
    session_id: &str,
    request_id: &str,
    payload: ConnectPayload,
    output: &Arc<Output>,
    stop: &AtomicBool,
    input: &Receiver<Vec<InputEvent>>,
    trust: &Receiver<bool>,
    resize: &Receiver<(u16, u16)>,
    refresh: &Receiver<()>,
    local_clipboard: &Receiver<String>,
    allow_egfx: bool,
    trusted_fingerprint: &mut Option<String>,
) -> anyhow::Result<()> {
    for monitor in &payload.monitors {
        anyhow::ensure!(
            monitor.width >= 200 && monitor.height >= 200,
            "each monitor must be at least 200x200"
        );
    }

    let layout = build_monitor_layout(&payload.monitors)?;

    // 데스크톱 크기는 전체 모니터의 바운딩 박스다. 개별 모니터 크기를 넣으면 서버가 그만큼만
    // 만들어 나머지 화면이 사라진다.
    let config = build_config(
        allow_egfx,
        &payload,
        layout.desktop_width,
        layout.desktop_height,
        layout.declared.clone(),
    );

    // 클립보드 백엔드는 세션마다 하나이고, 정적 채널이라 접속 시점에 붙어야 한다.
    // 소리가 오는지 펌프에서도 봐야 한다. 아무 로그도 없으면 서버가 안 보내는 것인지 우리가
    // 못 받는 것인지 가릴 수 없다.
    let audio_heard: crate::audio::AudioHeard =
        Arc::new(std::sync::atomic::AtomicBool::new(false));

    let (clipboard_tx, clipboard_rx) = std::sync::mpsc::channel();
    let clipboard_backend = TextClipboardBackend::new(
        session_id.to_owned(),
        Arc::clone(output),
        clipboard_tx,
    );

    let (connection_result, framed, egfx_surface, egfx_unusable) = connect(
        config,
        payload.host.clone(),
        payload.port,
        session_id,
        request_id,
        output,
        trust,
        clipboard_backend,
        AudioBackend::new(session_id.to_owned(), Arc::clone(output), Arc::clone(&audio_heard)),
        AudioBackend::new(session_id.to_owned(), Arc::clone(output), Arc::clone(&audio_heard)),
        AudioBackend::new(session_id.to_owned(), Arc::clone(output), Arc::clone(&audio_heard)),
        payload.share.as_ref().map(|share| crate::drive::DriveShareConfig {
            label: share.label.clone(),
            path: share.path.clone(),
            read_only: share.read_only,
        }),
        allow_egfx,
        trusted_fingerprint,
    )
    .context("connect")?;

    let desktop = connection_result.desktop_size;
    // 어떤 정적 채널이 실제로 join 됐는지 남긴다. 클립보드가 조용히 안 되는 경우 여기서
    // cliprdr 가 빠졌는지 바로 보인다.
    let joined: Vec<String> = connection_result
        .static_channels
        .iter()
        .map(|(_, channel)| format!("{:?}", channel.channel_name()))
        .collect();
    info!(
        session_id,
        width = desktop.width,
        height = desktop.height,
        channels = ?joined,
        "connected"
    );

    // 서버가 요청한 크기를 그대로 주지 않을 수 있다. 그럴 때 우리가 계산한 배치는 무의미하므로,
    // 크기가 어긋나면 단일 화면으로 되돌려 알린다 — 어긋난 배치로 화면을 나누면 조용히 깨진다.
    let placements = if desktop.width == layout.desktop_width
        && desktop.height == layout.desktop_height
    {
        layout.placements.clone()
    } else {
        warn!(
            session_id,
            requested_width = layout.desktop_width,
            requested_height = layout.desktop_height,
            granted_width = desktop.width,
            granted_height = desktop.height,
            "server did not grant the requested layout; falling back to a single screen"
        );
        vec![MonitorPlacement {
            index: 0,
            left: 0,
            top: 0,
            width: desktop.width,
            height: desktop.height,
        }]
    };

    output.send_event(
        &Event::new("connected", ConnectedPayload {
            desktop_width: desktop.width,
            desktop_height: desktop.height,
            monitors: placements,
        })
        .session(session_id)
        .request(request_id),
    )?;

    let mut image = DecodedImage::new(
        ironrdp_graphics::image_processing::PixelFormat::RgbA32,
        desktop.width,
        desktop.height,
    );

    pump(
        session_id,
        connection_result,
        framed,
        &mut image,
        output,
        stop,
        input,
        resize,
        refresh,
        &clipboard_rx,
        local_clipboard,
        &egfx_surface,
        &egfx_unusable,
        &audio_heard,
    )
}

/// 그래픽 파이프라인으로는 이 세션의 화면을 그릴 수 없다는 신호.
///
/// 오류가 아니라 "다른 경로로 다시 붙어라" 는 뜻이라 메시지를 사용자에게 보여주지 않는다.
#[derive(Debug)]
struct EgfxUnusable;

impl std::fmt::Display for EgfxUnusable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the graphics pipeline cannot render this session")
    }
}

impl std::error::Error for EgfxUnusable {}

fn pump(
    session_id: &str,
    connection_result: ConnectionResult,
    mut framed: UpgradedFramed,
    image: &mut DecodedImage,
    output: &Output,
    stop: &AtomicBool,
    input: &Receiver<Vec<InputEvent>>,
    resize: &Receiver<(u16, u16)>,
    refresh: &Receiver<()>,
    clipboard: &Receiver<ClipboardMessage>,
    local_clipboard: &Receiver<String>,
    egfx: &crate::egfx_surface::EgfxSurfaceHandle,
    egfx_unusable: &crate::egfx::EgfxUnusable,
    audio_heard: &crate::audio::AudioHeard,
) -> anyhow::Result<()> {
    let activation_factory = connection_result.activation_factory.clone();
    let mut active_stage = ActiveStageBuilder {
        static_channels: connection_result.static_channels,
        user_channel_id: connection_result.user_channel_id,
        io_channel_id: connection_result.io_channel_id,
        message_channel_id: connection_result.message_channel_id,
        share_id: connection_result.share_id,
        compression_type: connection_result.compression_type,
        enable_server_pointer: connection_result.enable_server_pointer,
        pointer_software_rendering: connection_result.pointer_software_rendering,
    }
    .build();

    // Reused across updates so a busy screen does not allocate per dirty rect.
    let mut scratch = Vec::new();
    // 옛 경로가 그린 사각형을 EGFX 프레임버퍼로 옮긴 횟수.
    let mut mirrored: u64 = 0;
    // 마지막으로 알린 EGFX 화면 크기.
    //
    // 접속 때 알린 크기로 시작한다. 0 으로 두면 서버가 같은 크기로 보내는 첫 ResetGraphics 를
    // "크기가 바뀌었다"로 오해해 렌더러에 다시 알리게 되고, 렌더러는 누적본을 비운 뒤 전체
    // 새로고침을 요청한다 — 그 시점의 EGFX 프레임버퍼는 아직 비어 있어서 검은 화면이 통째로
    // 나가고, 서버는 이미 보냈다고 여기므로 그 뒤를 채워 주지 않는다.
    let mut egfx_size = (
        connection_result.desktop_size.width,
        connection_result.desktop_size.height,
    );

    // 접속하는 순간부터 프레임버퍼를 둔다.
    //
    // 그래픽 파이프라인은 접속보다 조금 늦게(ResetGraphics) 시작한다. 그 사이의 화면은 옛
    // 경로가 그리는데, 그것을 프레임버퍼에 담아 두지 않으면 EGFX 가 넘겨받는 순간 빈 화면에서
    // 잘라낸 사각형이 멀쩡한 화면 위에 얹혀 검은 구멍이 뚫린다.
    //
    // 크기는 서버가 확정한 값이다. ResetGraphics 가 같은 크기로 와도 다시 잡지 않는다.
    if let Ok(mut surface) = egfx.lock() {
        surface.resize(egfx_size.0, egfx_size.1);
    }
    // 마지막으로 화면을 내보낸 시각.
    let mut last_flush = std::time::Instant::now();
    // 채널이 열리기 전에 온 크기 요청.
    let mut pending_resize: Option<(u16, u16)> = None;
    // 소리가 오지 않는다는 것도 한 번은 남긴다.
    let started = std::time::Instant::now();
    let mut logged_silence = false;
    // Tracks which keys and buttons are currently down so a press/release pair is never lost and
    // the server is never left with a stuck modifier.
    let mut input_db = Database::new();

    while !stop.load(Ordering::Relaxed) {
        if !flush_input(input, &mut input_db, &mut active_stage, &mut framed, image)? {
            // The sender is gone: the session is being torn down.
            return Ok(());
        }

        flush_resize_requests(resize, &mut active_stage, &mut framed, &mut pending_resize)?;
        flush_refresh_requests(refresh, session_id, image, &mut scratch, output, egfx)?;
        flush_local_clipboard(local_clipboard, &mut active_stage, &mut framed)?;
        flush_clipboard(clipboard, &mut active_stage, &mut framed)?;
        // 그래픽 파이프라인이 화면을 못 그린다고 판정되면 여기서 접는다. 호출한 쪽이 이 채널
        // 없이 다시 붙는다 — 검은 화면으로 두는 것보다 잠깐 끊기는 편이 낫다.
        if egfx_unusable.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(anyhow::Error::new(EgfxUnusable));
        }

        // 그래픽 파이프라인은 레거시 재활성화 없이 혼자 화면 크기를 바꾼다(ResetGraphics).
        //
        // 그걸 알리지 않으면 렌더러는 옛 크기의 누적본을 그대로 들고 있게 되고, 새 크기로
        // 잘라 보낸 조각이 어긋난 자리에 얹힌다 — 창 크기를 바꿀 때 화면이 깨지는 원인이다.
        let current = egfx.lock().map(|surface| surface.size()).unwrap_or((0, 0));
        if current != (0, 0) && current != egfx_size {
            egfx_size = current;
            output.send_event(
                &Event::new("resized", ResizedPayload {
                    desktop_width: current.0,
                    desktop_height: current.1,
                })
                .session(session_id),
            )?;
            info!(
                session_id,
                width = current.0,
                height = current.1,
                "graphics pipeline changed the desktop size"
            );
        }

        if !logged_silence
            && started.elapsed() >= std::time::Duration::from_secs(15)
            && !audio_heard.load(std::sync::atomic::Ordering::Relaxed)
        {
            logged_silence = true;
            info!(session_id, "no audio from the server after 15s");
        }

        // 내보내는 주기를 묶는다.
        //
        // 펌프는 PDU 하나를 읽을 때마다 돌아오므로, 그대로 두면 초당 200번 가까이 프레임을
        // 내보내게 된다(실측). 화면은 그만큼 보여줄 수 없고, 프레임 하나하나가 렌더러에서
        // 비용이라 오히려 뚝뚝 끊긴다. 그 사이의 변경은 사각형끼리 합쳐지므로 잃는 것은 없다.
        if last_flush.elapsed() >= FLUSH_INTERVAL {
            last_flush = std::time::Instant::now();
            flush_egfx(egfx, session_id, output, &mut scratch)?;
        }

        let (action, frame) = match framed.read_pdu() {
            Ok(pdu) => pdu,
            // The read timeout is how we get back here to check `stop`; it is not an error.
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                continue;
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                continue;
            }
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                debug!(session_id, "server closed the connection");
                return Ok(());
            }
            Err(e) => return Err(anyhow::Error::new(e).context("read pdu")),
        };

        for out in active_stage.process(image, action, &frame)? {
            match out {
                ActiveStageOutput::ResponseFrame(response) => {
                    framed.write_all(&response).context("write response")?;
                }
                ActiveStageOutput::GraphicsUpdate(region) => {
                    // 그래픽 파이프라인이 살아 있으면 화면은 하나뿐이어야 한다.
                    //
                    // 두 경로가 동시에 그린다. 여기서 바로 내보내면 우리 EGFX 프레임버퍼는
                    // 그 내용을 모른 채로 남고, 그 프레임버퍼에서 잘라 보낸 사각형이 방금 그린
                    // 화면을 옛 내용으로 덮는다 — 화면이 뒤죽박죽되는 이유가 이것이다.
                    //
                    // 레거시 갱신도 같은 프레임버퍼에 적어 두고, 내보내는 것은 한 곳에서만 한다.
                    if egfx_active(egfx) {
                        let (width, height) = (region.width(), region.height());
                        mirror_region_into_egfx(image, region, egfx, &mut scratch);
                        // 화면을 실제로 누가 그리고 있는지 알아야 한다. EGFX 를 켰는데 여기가
                        // 계속 올라가면 서버가 옛 경로로도 그리고 있다는 뜻이다.
                        mirrored += 1;
                        if mirrored == 1 || mirrored % 500 == 0 {
                            info!(
                                session_id,
                                mirrored, width, height, "legacy region mirrored into egfx"
                            );
                        }
                    } else {
                        send_region(session_id, image, region, &mut scratch, output)?;
                    }
                }
                ActiveStageOutput::Terminate(reason) => {
                    info!(session_id, ?reason, "server terminated the session");
                    return Ok(());
                }
                ActiveStageOutput::DeactivateAll => {
                    // 서버가 해상도를 바꿀 때 오는 신호다. 여기서 재활성화 시퀀스를 끝까지 몰고
                    // 가지 않으면 이후 그리기가 옛 크기의 프레임버퍼로 들어가 깨진다.
                    let mut deferred = Vec::new();
                    let desktop = run_reactivation(
                        session_id,
                        activation_factory.create(),
                        &mut framed,
                        &mut active_stage,
                        &mut deferred,
                    )?;

                    *image = DecodedImage::new(
                        ironrdp_graphics::image_processing::PixelFormat::RgbA32,
                        desktop.width,
                        desktop.height,
                    );

                    // EGFX 프레임버퍼도 같이 새 크기로 잡는다.
                    //
                    // 여기서 빠뜨리면 옛 크기의 화면을 새 크기의 캔버스로 내보내게 된다. 렌더러는
                    // 이제 막 누적본을 새로 잡아 비운 참이라, 크기가 어긋난 조각이 그대로 얹혀
                    // 화면이 어긋난 채로 남는다 — 창 크기를 바꿀 때 화면이 깨지는 원인이다.
                    //
                    // 서버가 곧 ResetGraphics 로 같은 크기를 알려 주지만, 그 사이에 새로고침
                    // 요청이 오면 늦다.
                    if let Ok(mut surface) = egfx.lock() {
                        if surface.size() != (0, 0) {
                            surface.resize(desktop.width, desktop.height);
                        }
                    }

                    output.send_event(
                        &Event::new("resized", ResizedPayload {
                            desktop_width: desktop.width,
                            desktop_height: desktop.height,
                        })
                        .session(session_id),
                    )?;

                    info!(
                        session_id,
                        width = desktop.width,
                        height = desktop.height,
                        "reactivated at a new desktop size"
                    );

                    replay_deferred(
                        session_id,
                        &deferred,
                        image,
                        &mut active_stage,
                        &mut framed,
                        &mut scratch,
                        output,
                        egfx,
                    )?;
                }
                _ => {}
            }
        }
    }

    Ok(())
}




/// EGFX 가 만들어 둔 화면 갱신을 내보낸다.
///
/// 핸들러는 세션 스레드 안쪽(active_stage.process)에서 불려 프레임버퍼를 만질 수 없으므로 큐에
/// 쌓아 두고, 여기서 꺼내 렌더러로 보낸다.
/// 화면을 내보내는 최소 간격. 120Hz 보다 촘촘히 보낼 이유가 없다.
const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(8);

fn flush_egfx(
    surface: &crate::egfx_surface::EgfxSurfaceHandle,
    session_id: &str,
    output: &Output,
    scratch: &mut Vec<u8>,
) -> anyhow::Result<()> {
    // 바뀐 영역들의 픽셀만 내보낸다. 떨어진 변경을 하나로 뭉치지 않으므로, 그 사이의 멀쩡한
    // 화면을 다시 보내는 일이 없다 — 스크롤 한 번에 화면 몇 장씩 나가던 원인이 그것이었다.
    let mut rects = Vec::new();
    {
        let Ok(mut surface) = surface.lock() else {
            return Ok(());
        };
        surface.take_dirty(&mut rects);
    }

    for rect in rects {
        {
            let Ok(surface) = surface.lock() else {
                return Ok(());
            };
            surface.extract(rect, scratch);
        }
        if scratch.is_empty() {
            continue;
        }
        output.send_frame(
            &FramePayload {
                kind: "rdpFrame",
                session_id: session_id.to_owned(),
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            },
            scratch,
        )?;
    }

    Ok(())
}

/// Drains queued input and sends it to the server.
///
/// Returns `false` once the sending half is gone, which is how a disconnect reaches this thread.
///
/// Everything is funnelled through [`Database`] rather than encoded directly: it holds the current
/// key and button state, so it can drop a repeated press, synthesize the release the server needs,
/// and keep modifiers consistent. Encoding raw events would leave a stuck Ctrl behind the first
/// time a keyup is missed.
fn flush_input(
    input: &Receiver<Vec<InputEvent>>,
    db: &mut Database,
    active_stage: &mut ActiveStage,
    framed: &mut UpgradedFramed,
    image: &mut DecodedImage,
) -> anyhow::Result<bool> {
    loop {
        let batch = match input.try_recv() {
            Ok(batch) => batch,
            Err(TryRecvError::Empty) => return Ok(true),
            Err(TryRecvError::Disconnected) => return Ok(false),
        };

        let operations: Vec<Operation> = batch.into_iter().filter_map(to_operation).collect();
        if operations.is_empty() {
            continue;
        }

        let events = db.apply(operations);
        if events.is_empty() {
            // The database swallowed everything (e.g. a key that was already down).
            continue;
        }

        for out in active_stage.process_fastpath_input(image, &events)? {
            if let ActiveStageOutput::ResponseFrame(response) = out {
                framed.write_all(&response).context("write input")?;
            }
        }
    }
}

/// Hands newly copied local text to the backend and tells the remote it exists.
///
/// Only the newest entry matters: the clipboard holds one value, so older ones are already stale.
fn flush_local_clipboard(
    local: &Receiver<String>,
    active_stage: &mut ActiveStage,
    framed: &mut UpgradedFramed,
) -> anyhow::Result<()> {
    let mut latest = None;
    loop {
        match local.try_recv() {
            Ok(text) => latest = Some(text),
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
        }
    }

    let Some(text) = latest else {
        return Ok(());
    };

    let Some(processor) = active_stage.get_svc_processor_mut::<CliprdrClient>() else {
        return Ok(());
    };

    // 백엔드가 값을 들고 있어야 원격이 붙여넣을 때 응답할 수 있다. 알림만 보내고 값을 안 쥐면
    // 정작 요청이 왔을 때 빈 응답을 내게 된다.
    if let Some(backend) = processor
        .downcast_backend_mut::<TextClipboardBackend>()
    {
        backend.set_local_text(text);
    }

    let messages = processor
        .initiate_copy(&[ironrdp_cliprdr::pdu::ClipboardFormat::new(
            ironrdp_cliprdr::pdu::ClipboardFormatId::new(13),
        )])
        .context("announce local clipboard")?;

    let encoded = active_stage
        .process_svc_processor_messages(messages)
        .context("encode clipboard announcement")?;
    framed.write_all(&encoded).context("write clipboard announcement")?;

    Ok(())
}

/// Sends whatever the clipboard backend queued.
///
/// The backend runs inside the channel processor and cannot touch the socket, so it queues messages
/// here and this loop turns them into CLIPRDR PDUs.
fn flush_clipboard(
    clipboard: &Receiver<ClipboardMessage>,
    active_stage: &mut ActiveStage,
    framed: &mut UpgradedFramed,
) -> anyhow::Result<()> {
    loop {
        let message = match clipboard.try_recv() {
            Ok(message) => message,
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => return Ok(()),
        };

        let Some(processor) = active_stage.get_svc_processor_mut::<CliprdrClient>() else {
            // 서버가 클립보드 채널을 열지 않았다. 큐를 비우고 넘어간다.
            warn!("clipboard channel is not available; dropping message");
            continue;
        };

        let messages = match message {
            ClipboardMessage::SendInitiateCopy(formats) => {
                processor.initiate_copy(&formats).context("initiate copy")?
            }
            ClipboardMessage::SendFormatData(response) => processor
                .submit_format_data(response)
                .context("submit format data")?,
            ClipboardMessage::SendInitiatePaste(format) => {
                processor.initiate_paste(format).context("initiate paste")?
            }
            // 파일 전송은 구현하지 않았다. 큐에 들어올 일이 없지만 들어와도 무시한다.
            _ => continue,
        };

        let encoded = active_stage
            .process_svc_processor_messages(messages)
            .context("encode clipboard messages")?;
        framed.write_all(&encoded).context("write clipboard")?;
    }
}

/// Asks the server to change the desktop size.
///
/// Only the newest request in the queue is sent. A window drag produces a request per frame, and
/// every one the server accepts costs a full deactivation-reactivation round trip — sending them
/// all would keep the session renegotiating long after the drag ended.
fn flush_resize_requests(
    resize: &Receiver<(u16, u16)>,
    active_stage: &mut ActiveStage,
    framed: &mut UpgradedFramed,
    // 아직 못 보낸 크기. 채널이 열릴 때까지 들고 있는다.
    pending: &mut Option<(u16, u16)>,
) -> anyhow::Result<()> {
    let mut latest = *pending;
    loop {
        match resize.try_recv() {
            Ok(size) => latest = Some(size),
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => break,
        }
    }

    let Some((width, height)) = latest else {
        return Ok(());
    };

    // [MS-RDPEDISP] 2.2.2.2.1: 양변 200~8192, 폭은 홀수 금지. 벗어난 값은 서버가 통째로 거부하므로
    // 여기서 맞춰 보낸다.
    let width = width.clamp(200, 8192) & !1;
    let height = height.clamp(200, 8192);

    // None 이면 DISP 채널이 아직 안 열렸다는 뜻이다. 채널은 접속 직후 조금 뒤에 열리는데, 앱은
    // 붙자마자 한 번만 크기를 요청한다 — 여기서 버리면 그 뒤로 크기가 바뀌지 않는 한 다시 오지
    // 않아서, 화면이 창에 맞지 않은 채로 남는다(수동으로 창을 한 번 흔들어야 맞던 이유).
    //
    // 그래서 버리지 않고 들고 있다가 열리면 보낸다.
    let Some(encoded) = active_stage.encode_resize(u32::from(width), u32::from(height), None, None)
    else {
        *pending = Some((width, height));
        return Ok(());
    };

    *pending = None;

    framed
        .write_all(&encoded.context("encode resize")?)
        .context("write resize request")?;

    Ok(())
}

/// Drives the Deactivation-Reactivation Sequence and returns the new desktop size.
///
/// [MS-RDPBCGR] 1.3.1.3. `single_sequence_step` in ironrdp-blocking only accepts a `ClientConnector`,
/// so this walks the sequence directly — it is the same loop, over the `Sequence` trait.
fn run_reactivation(
    session_id: &str,
    mut sequence: ConnectionActivationSequence,
    framed: &mut UpgradedFramed,
    active_stage: &mut ActiveStage,
    deferred: &mut Vec<bytes::Bytes>,
) -> anyhow::Result<connector::DesktopSize> {
    use ironrdp::connector::Sequence as _;

    debug!(session_id, "executing deactivation-reactivation sequence");

    let mut buf = WriteBuf::new();

    loop {
        buf.clear();

        let written = if let Some(hint) = sequence.next_pdu_hint() {
            // 이 구간의 읽기는 세션 폴링(8ms)이 아니라 핸드셰이크에 가깝다. 서버 응답을 기다리는
            // 동안 타임아웃으로 빠져나오면 시퀀스가 중간에 끊긴다.
            let pdu = read_by_hint_blocking(framed, hint)?;

            // 정적 가상 채널(rdpsnd·cliprdr·rdpdr·drdynvc)도 같은 슬로우패스로 계속 도착한다.
            // 활성화 시퀀스는 받은 걸 무조건 ShareControl 로 디코드하고 채널 확인은 그 뒤에
            // 경고만 찍으므로(ironrdp-connector 의 connection_activation), 그대로 넘기면
            // `invalid pdu_type` 으로 세션이 죽는다. 재활성화 왕복 안에 가상 채널 PDU 가
            // 들어오느냐로 갈려서 증상이 간헐적이다 — 오디오가 나오는 중이면 거의 매번 걸린다.
            //
            // 버리지 않고 모아두는 이유: cliprdr 과 rdpdr 은 요청-응답이라 요청 하나를 흘리면
            // 클립보드와 공유 드라이브가 그 세션 내내 응답을 기다리며 멎는다.
            if !is_io_channel_pdu(&pdu, sequence.io_channel_id()) {
                deferred.push(pdu);
                continue;
            }

            sequence.step(&pdu, &mut buf)?
        } else {
            sequence.step_no_input(&mut buf)?
        };

        if let Some(len) = written.size() {
            framed
                .write_all(&buf[..len])
                .context("write reactivation step")?;
        }

        if let ConnectionActivationState::Finalized {
            desktop_size,
            share_id,
            enable_server_pointer,
            pointer_software_rendering,
        } = sequence.connection_activation_state()
        {
            // 새 share_id 로 갱신하지 않으면 이후 보내는 PDU 가 옛 세션을 가리켜 서버가 무시한다.
            active_stage.set_share_id(share_id);
            active_stage.set_enable_server_pointer(enable_server_pointer);
            // fastpath 프로세서는 frame acknowledge 에 share_id 를 실어 보내므로 새 값으로 다시
            // 만들어야 한다. bulk_decompressor 를 None 으로 두는 것은 build_config 가
            // compression_type: None 으로 접속하기 때문이다 — 압축을 켜게 되면 기존
            // 압축 이력을 넘겨받아야 하고, 그때는 이 자리가 틀린 값이 된다.
            active_stage.set_fastpath_processor(
                ironrdp::session::fast_path::ProcessorBuilder {
                    io_channel_id: sequence.io_channel_id(),
                    user_channel_id: sequence.user_channel_id(),
                    share_id,
                    enable_server_pointer,
                    pointer_software_rendering,
                    bulk_decompressor: None,
                }
                .build(),
            );
            return Ok(desktop_size);
        }
    }
}

/// Reads one PDU, ignoring the session loop's short poll timeout.
///
/// The 8ms timeout exists so the loop can flush input; during reactivation there is no input to
/// flush and a timeout would abandon the sequence half-way, leaving the session unusable.
/// 이 슬로우패스 PDU 가 IO 채널(활성화 시퀀스가 다루는 채널) 것인지.
///
/// SendDataIndication 으로 읽히지 않는 PDU 는 시퀀스에 맡긴다 — MCS 연결 해제처럼 시퀀스가
/// 처리해야 하는 것들이 그 모양으로 온다.
fn is_io_channel_pdu(pdu: &[u8], io_channel_id: u16) -> bool {
    match ironrdp_pdu::mcs::decode_send_data_indication(pdu) {
        Ok(ctx) => ctx.channel_id == io_channel_id,
        Err(_) => true,
    }
}

/// 재활성화 중에 비켜둔 가상 채널 PDU 를 평소 경로로 흘린다.
///
/// 재활성화가 끝난 뒤에 돌린다 — 그 전에는 프레임버퍼가 옛 크기라 그리기가 어긋난다.
fn replay_deferred(
    session_id: &str,
    deferred: &[bytes::Bytes],
    image: &mut DecodedImage,
    active_stage: &mut ActiveStage,
    framed: &mut UpgradedFramed,
    scratch: &mut Vec<u8>,
    output: &Output,
    egfx: &crate::egfx_surface::EgfxSurfaceHandle,
) -> anyhow::Result<()> {
    if deferred.is_empty() {
        return Ok(());
    }

    debug!(
        session_id,
        count = deferred.len(),
        "replaying virtual channel pdus held during reactivation"
    );

    for pdu in deferred {
        for out in active_stage.process(image, Action::X224, pdu)? {
            match out {
                ActiveStageOutput::ResponseFrame(response) => {
                    framed
                        .write_all(&response)
                        .context("write deferred response")?;
                }
                ActiveStageOutput::GraphicsUpdate(region) => {
                    if egfx_active(egfx) {
                        mirror_region_into_egfx(image, region, egfx, scratch);
                    } else {
                        send_region(session_id, image, region, scratch, output)?;
                    }
                }
                // 여기 오는 건 가상 채널 PDU 뿐이라 화면·세션 상태를 바꾸는 출력은 나오지 않는다.
                _ => {}
            }
        }
    }

    Ok(())
}

fn read_by_hint_blocking(
    framed: &mut UpgradedFramed,
    hint: &dyn ironrdp_pdu::PduHint,
) -> anyhow::Result<bytes::Bytes> {
    loop {
        match framed.read_by_hint(hint) {
            Ok(pdu) => return Ok(pdu),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(e) => return Err(anyhow::Error::new(e).context("read reactivation pdu")),
        }
    }
}

fn to_operation(event: InputEvent) -> Option<Operation> {
    match event {
        InputEvent::MouseMove { x, y } => Some(Operation::MouseMove(MousePosition { x, y })),
        InputEvent::MouseButton { button, pressed } => {
            // Browser MouseEvent.button numbering; anything else is a device we do not model.
            let button = MouseButton::from_web_button(button)?;
            Some(if pressed {
                Operation::MouseButtonPressed(button)
            } else {
                Operation::MouseButtonReleased(button)
            })
        }
        InputEvent::Wheel { vertical, delta } => Some(Operation::WheelRotations(WheelRotations {
            is_vertical: vertical,
            rotation_units: delta,
        })),
        InputEvent::Key { scancode, pressed } => {
            let scancode = Scancode::from_u16(scancode);
            Some(if pressed {
                Operation::KeyPressed(scancode)
            } else {
                Operation::KeyReleased(scancode)
            })
        }
        InputEvent::Unicode { character, pressed } => Some(if pressed {
            Operation::UnicodeKeyPressed(character)
        } else {
            Operation::UnicodeKeyReleased(character)
        }),
    }
}

/// Copies one dirty rectangle out of the framebuffer and ships it as a stream frame.
///
/// The framebuffer row is as wide as the whole desktop, so a rectangle's rows are not contiguous —
/// each has to be lifted out by `stride()`. That packing is done here rather than in the renderer so
/// the payload can go straight into `texSubImage2D`.
/// 화면 전체를 다시 내보낸다.
///
/// 세션 도중에 새로 붙는 창(모니터별 창처럼)은 그때까지의 화면을 못 받는다. RDP 는 바뀐 부분만
/// 보내고 서버는 정지한 영역을 다시 보내주지 않으므로, 우리가 들고 있는 프레임버퍼를 한 번
/// 통째로 흘려주는 것이 유일한 방법이다.
fn flush_refresh_requests(
    refresh: &Receiver<()>,
    session_id: &str,
    image: &DecodedImage,
    scratch: &mut Vec<u8>,
    output: &Output,
    egfx: &crate::egfx_surface::EgfxSurfaceHandle,
) -> anyhow::Result<()> {
    let mut wanted = false;
    loop {
        match refresh.try_recv() {
            // 여러 창이 동시에 붙어도 한 번만 보내면 된다.
            Ok(()) => wanted = true,
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => break,
        }
    }

    if !wanted {
        return Ok(());
    }

    // 그래픽 파이프라인이 화면을 들고 있으면 거기서 내보낸다.
    //
    // 레거시 이미지는 EGFX 가 그리는 동안 비어 있거나 옛 화면이다. 그걸 전체 화면으로 뿌리면
    // 방금까지 맞던 화면 위에 옛 그림이 덮여, 새로 그려지는 조각들과 뒤섞인다.
    if egfx_active(egfx) {
        if let Ok(mut surface) = egfx.lock() {
            surface.mark_all_dirty();
        }
        return Ok(());
    }

    if image.width() == 0 || image.height() == 0 {
        return Ok(());
    }

    // InclusiveRectangle 은 right/bottom 을 포함한다 — 1 을 빼지 않으면 경계 검사에 걸린다.
    let full = InclusiveRectangle {
        left: 0,
        top: 0,
        right: image.width() - 1,
        bottom: image.height() - 1,
    };
    send_region(session_id, image, full, scratch, output)
}

/// 갱신된 사각형 하나를 렌더러로 내보낸다.
///
/// 여기를 최적화하려는 사람에게 — 2026-08 측정 결과 이 경로는 병목이 아니다. 세션 스레드가
/// 프레임을 내보내는 데 쓰는 시간은 전체의 **0.9%**(평균 0.8ms, 최악 18.6ms)였다. 그때 서버는
/// 초당 12번, 갱신당 평균 7만 픽셀을 보내고 있었다. 즉 속도를 정하는 쪽은 서버다.
///
/// 그러니 메시지를 묶거나 IPC 복사를 줄이는 작업은 효과가 없다. mstsc 와의 차이는 코덱 경로에서
/// 온다 — 우리는 레거시 RemoteFX(Surface Commands, 64x64 타일)를 쓰고 mstsc 는 EGFX 로 H.264 를
/// 쓴다. 그 경로는 ironrdp-egfx 가 있어야 열린다(우리 의존성에 없음).
/// 그래픽 파이프라인이 화면을 들고 있는지.
fn egfx_active(surface: &crate::egfx_surface::EgfxSurfaceHandle) -> bool {
    surface
        .lock()
        .map(|surface| surface.size() != (0, 0))
        .unwrap_or(false)
}

/// 레거시 경로가 그린 사각형을 EGFX 프레임버퍼에도 적어 둔다.
///
/// 내보내는 것은 EGFX 쪽 한 곳에서만 한다. 두 곳에서 내보내면 서로의 내용을 덮어쓴다.
fn mirror_region_into_egfx(
    image: &DecodedImage,
    region: InclusiveRectangle,
    surface: &crate::egfx_surface::EgfxSurfaceHandle,
    scratch: &mut Vec<u8>,
) {
    let width = region.width();
    let height = region.height();
    if width == 0 || height == 0 || region.right >= image.width() || region.bottom >= image.height()
    {
        return;
    }

    let bpp = image.bytes_per_pixel();
    let stride = image.stride();
    let data = image.data();
    let row_bytes = usize::from(width) * bpp;

    scratch.clear();
    scratch.reserve(row_bytes * usize::from(height));
    for row in 0..usize::from(height) {
        let start = (usize::from(region.top) + row) * stride + usize::from(region.left) * bpp;
        scratch.extend_from_slice(&data[start..start + row_bytes]);
    }

    if let Ok(mut surface) = surface.lock() {
        surface.write(region.left, region.top, width, height, scratch);
    }
}

fn send_region(
    session_id: &str,
    image: &DecodedImage,
    region: InclusiveRectangle,
    scratch: &mut Vec<u8>,
    output: &Output,
) -> anyhow::Result<()> {
    let width = region.width();
    let height = region.height();
    if width == 0 || height == 0 {
        return Ok(());
    }

    // A malformed update must not index out of bounds.
    if region.right >= image.width() || region.bottom >= image.height() {
        warn!(
            session_id,
            left = region.left,
            top = region.top,
            right = region.right,
            bottom = region.bottom,
            desktop_width = image.width(),
            desktop_height = image.height(),
            "dropping out-of-bounds graphics update"
        );
        return Ok(());
    }

    let bpp = image.bytes_per_pixel();
    let stride = image.stride();
    let data = image.data();
    let row_bytes = usize::from(width) * bpp;

    scratch.clear();
    scratch.reserve(row_bytes * usize::from(height));
    for row in 0..usize::from(height) {
        let start = (usize::from(region.top) + row) * stride + usize::from(region.left) * bpp;
        scratch.extend_from_slice(&data[start..start + row_bytes]);
    }

    output.send_frame(
        &FramePayload {
            kind: "rdpFrame",
            session_id: session_id.to_owned(),
            x: region.left,
            y: region.top,
            width,
            height,
        },
        scratch,
    )?;

    Ok(())
}

/// 요청받은 모니터들을 RDP 가 기대하는 두 좌표계로 정리한다.
///
/// 선언 공간: 주 모니터가 원점이고 나머지는 그에 상대적이라 음수가 나올 수 있다.
/// 프레임버퍼 공간: 전체 바운딩 박스를 덮는 0 기준 좌표.
///
/// 이 둘을 섞으면 주 모니터가 왼쪽 끝이 아닐 때 화면이 통째로 어긋난다(FreeRDP #11403 계열).
pub struct MonitorLayout {
    /// 그대로 GCC 블록에 실린다.
    pub declared: Vec<ironrdp_pdu::gcc::Monitor>,
    /// 프레임버퍼 안에서 각 모니터가 차지하는 사각형.
    pub placements: Vec<MonitorPlacement>,
    pub desktop_width: u16,
    pub desktop_height: u16,
}

pub fn build_monitor_layout(monitors: &[crate::protocol::MonitorRequest]) -> anyhow::Result<MonitorLayout> {
    use ironrdp_pdu::gcc::{Monitor, MonitorFlags};

    anyhow::ensure!(!monitors.is_empty(), "at least one monitor is required");
    // [MS-RDPBCGR] 2.2.1.3.6 의 상한.
    anyhow::ensure!(monitors.len() <= 16, "at most 16 monitors are supported");

    let primary_index = monitors.iter().position(|m| m.primary).unwrap_or(0);
    let primary = &monitors[primary_index];

    // 선언 공간 사각형. right/bottom 은 inclusive 라 폭 2560 은 2559 에서 끝난다.
    let declared_rects: Vec<(i32, i32, i32, i32)> = monitors
        .iter()
        .map(|m| {
            let left = m.left - primary.left;
            let top = m.top - primary.top;
            (
                left,
                top,
                left + i32::from(m.width) - 1,
                top + i32::from(m.height) - 1,
            )
        })
        .collect();

    let min_left = declared_rects.iter().map(|r| r.0).min().expect("non-empty");
    let min_top = declared_rects.iter().map(|r| r.1).min().expect("non-empty");
    let max_right = declared_rects.iter().map(|r| r.2).max().expect("non-empty");
    let max_bottom = declared_rects.iter().map(|r| r.3).max().expect("non-empty");

    let desktop_width = u16::try_from(max_right - min_left + 1)
        .context("virtual desktop width exceeds u16")?;
    let desktop_height = u16::try_from(max_bottom - min_top + 1)
        .context("virtual desktop height exceeds u16")?;

    let declared = declared_rects
        .iter()
        .enumerate()
        .map(|(index, rect)| Monitor {
            left: rect.0,
            top: rect.1,
            right: rect.2,
            bottom: rect.3,
            flags: if index == primary_index {
                MonitorFlags::PRIMARY
            } else {
                MonitorFlags::empty()
            },
        })
        .collect();

    let placements = declared_rects
        .iter()
        .enumerate()
        .map(|(index, rect)| MonitorPlacement {
            index,
            left: u16::try_from(rect.0 - min_left).unwrap_or(0),
            top: u16::try_from(rect.1 - min_top).unwrap_or(0),
            width: monitors[index].width,
            height: monitors[index].height,
        })
        .collect();

    Ok(MonitorLayout {
        declared,
        placements,
        desktop_width,
        desktop_height,
    })
}

fn build_config(
    allow_egfx: bool,
    payload: &ConnectPayload,
    width: u16,
    height: u16,
    monitors: Vec<ironrdp_pdu::gcc::Monitor>,
) -> connector::Config {
    connector::Config {
        credentials: Credentials::UsernamePassword {
            username: payload.username.clone(),
            password: payload.password.clone(),
        },
        domain: payload.domain.clone(),
        // The TLS upgrade is performed by this crate, not by the connector.
        enable_tls: false,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: connector::DesktopSize { width, height },
        // 단일 모니터면 비워 둔다. 블록을 보내는 것 자체가 멀티모니터 선언이라, 하나뿐일 때는
        // 보내지 않는 편이 서버 구현 차이에 덜 노출된다.
        monitors: if monitors.len() > 1 { monitors } else { Vec::new() },
        enable_graphics_pipeline: allow_egfx,
        // None 이어도 커넥터가 기본 코덱(RemoteFX 포함)을 광고한다. classic bitmap 강제는
        // 재연결마다 서버 갱신이 최대 1초 가까이 멎는 결과가 나와 사용하지 않는다.
        bitmap: None,
        client_build: 0,
        client_name: "dolgate".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),

        #[cfg(target_os = "windows")]
        platform: MajorPlatformType::WINDOWS,
        #[cfg(target_os = "macos")]
        platform: MajorPlatformType::MACINTOSH,
        #[cfg(target_os = "linux")]
        platform: MajorPlatformType::UNIX,

        enable_server_pointer: false,
        request_data: None,
        autologon: false,
        // 이게 false 면 커넥터가 ClientInfoFlags::NO_AUDIO_PLAYBACK 를 세워(connection.rs:929)
        // "오디오를 받지 않는다"고 선언한다. RDPSND 채널을 붙여도 소리가 흐르지 않는다.
        enable_audio_playback: true,
        compression_type: None,
        pointer_software_rendering: true,
        multitransport_flags: None,
        performance_flags: PerformanceFlags::default(),
        desktop_scale_factor: 0,
        hardware_id: None,
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    }
}

fn connect(
    config: connector::Config,
    server_name: String,
    port: u16,
    session_id: &str,
    request_id: &str,
    output: &Output,
    trust: &Receiver<bool>,
    clipboard_backend: TextClipboardBackend,
    audio_backend: AudioBackend,
    // 동적 채널로 오는 소리를 받을 백엔드. 정적 채널과 같은 세션으로 흘러 나간다.
    dvc_audio_backend: AudioBackend,
    lossy_audio_backend: AudioBackend,
    share: Option<crate::drive::DriveShareConfig>,
    // allow_egfx: 그래픽 파이프라인을 쓸지. 앞선 시도가 이 채널로 화면을 못 그렸으면 끄고 다시
    // 붙는다. trusted_fingerprint: 이미 승인된 인증서 지문. 같으면 다시 묻지 않는다.
    allow_egfx: bool,
    trusted_fingerprint: &mut Option<String>,
) -> anyhow::Result<(
    ConnectionResult,
    UpgradedFramed,
    crate::egfx_surface::EgfxSurfaceHandle,
    crate::egfx::EgfxUnusable,
)> {
    let server_addr = lookup_addr(&server_name, port).context("lookup addr")?;

    let tcp_stream = TcpStream::connect(server_addr).context("TCP connect")?;
    tcp_stream
        .set_read_timeout(Some(HANDSHAKE_READ_TIMEOUT))
        .context("set handshake read timeout")?;

    let client_addr = tcp_stream.local_addr().context("get socket local address")?;

    let mut framed = ironrdp_blocking::Framed::new(tcp_stream);
    // DISP(Display Control) 는 동적 가상 채널이라 DRDYNVC 위에 얹힌다. 이걸 붙여야 클라이언트가
    // 해상도 변경을 요청할 수 있다.
    // EGFX(그래픽 파이프라인)를 같이 붙인다. 스크롤의 화면 영역 복사와 H.264 가 전부 이 채널
    // 위에 있다. 서버가 안 받아주면 지금까지의 표면 비트 경로로 그냥 협상된다.
    let egfx_surface = crate::egfx_surface::new_surface();
    let egfx_unusable: crate::egfx::EgfxUnusable =
        Arc::new(std::sync::atomic::AtomicBool::new(false));
    let graphics_pipeline = ironrdp_egfx::client::GraphicsPipelineClient::new(
        Box::new(crate::egfx::EgfxHandler::new(
            session_id.to_owned(),
            Arc::clone(&egfx_surface),
            Arc::clone(&egfx_unusable),
        )),
        match ironrdp_egfx::decode::OpenH264Decoder::new() {
            Ok(decoder) => Some(Box::new(decoder) as Box<dyn ironrdp_egfx::decode::H264Decoder>),
            Err(error) => {
                // 디코더가 없으면 크레이트가 AVC 를 뺀 채로 협상한다. 그러면 서버가 우리에게
                // 보낼 수 있는 것이 거의 없어 EGFX 가 사실상 무력해진다.
                warn!(%error, "no H.264 decoder; egfx will negotiate without AVC");
                None
            }
        },
    );

    // 그래픽 파이프라인을 안 쓸 때는 채널 자체를 붙이지 않는다. 붙여 두면 서버가 그리로 보내고,
    // 우리가 못 푸는 것이 섞여 있으면 화면이 다시 비게 된다.
    // 소리는 정적 채널(rdpsnd)로 받는다.
    //
    // 서버는 동적 채널(AUDIO_PLAYBACK_DVC)로도 열려고 하는데, 그걸 받아 주면 소리를 그리로
    // 돌려 보내고는 정작 아무것도 보내지 않는다(채널만 열리고 payload 0건). 받지 않으면 정적
    // 채널로 되돌아온다.
    let dynamic_channels = DrdynvcClient::new()
        .with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new())));
    // 소리는 정적 채널(rdpsnd)로 온다. 서버가 동적 채널(AUDIO_PLAYBACK_DVC)도 열려고 하지만,
    // 열어 줘도 그리로는 아무것도 보내지 않는 것을 실측으로 확인했다 — 채널만 열리고 payload 0건.
    let _ = (dvc_audio_backend, lossy_audio_backend);
    let dynamic_channels = if allow_egfx {
        dynamic_channels.with_dynamic_channel(graphics_pipeline)
    } else {
        dynamic_channels
    };

    let mut connector = connector::ClientConnector::new(config, client_addr)
        .with_static_channel(dynamic_channels)
        // CLIPRDR / RDPSND 는 정적 채널이라 접속 시점에 붙여야 한다. 나중에 켤 수 없다.
        .with_static_channel(CliprdrClient::new(Box::new(clipboard_backend)))
        .with_static_channel(Rdpsnd::new(Box::new(audio_backend)))
        .with_static_channel(crate::drive::build_rdpdr("dolgate".to_owned(), share));

    let should_upgrade =
        ironrdp_blocking::connect_begin(&mut framed, &mut connector).context("begin connection")?;

    let initial_stream = framed.into_inner_no_leftover();
    let (upgraded_stream, server_public_key, certificate) =
        tls_upgrade(initial_stream, server_name.clone()).context("TLS upgrade")?;

    let fingerprint = certificate.fingerprint.clone();

    // 자격증명이 나가기 전 마지막 지점이다. CredSSP 는 connect_finalize 안에서 일어나므로,
    // 여기서 승인을 받지 못하면 비밀번호는 한 바이트도 전송되지 않는다.
    //
    // 같은 서버에 다시 붙는 중이고 지문이 그대로면 묻지 않는다 — 사용자가 방금 승인한 것을
    // 1초 만에 또 묻는 꼴이 된다. 지문이 다르면 다른 서버일 수 있으므로 반드시 다시 묻는다.
    if trusted_fingerprint.as_deref() != Some(fingerprint.as_str()) {
        output
            .send_event(
                &Event::new("certificateCheck", certificate)
                    .session(session_id)
                    .request(request_id),
            )
            .context("emit certificate")?;

        match trust.recv_timeout(TRUST_VERDICT_TIMEOUT) {
            Ok(true) => {}
            Ok(false) => anyhow::bail!("server certificate was not trusted"),
            Err(_) => anyhow::bail!("timed out waiting for the certificate decision"),
        }

        // 승인은 이 시도가 실패하더라도 남는다. 다시 붙는 것은 우리 사정이지 사용자가 결정을
        // 번복한 것이 아니다 — 여기서 흘리면 재접속이 인증서에서 막힌다.
        *trusted_fingerprint = Some(fingerprint);
    }

    let upgraded = ironrdp_blocking::mark_as_upgraded(should_upgrade, &mut connector);
    let mut upgraded_framed = ironrdp_blocking::Framed::new(upgraded_stream);

    let mut network_client = ReqwestNetworkClient;
    let connection_result = ironrdp_blocking::connect_finalize(
        upgraded,
        connector,
        &mut upgraded_framed,
        &mut network_client,
        server_name.into(),
        server_public_key,
        None,
    )
    .context("finalize connection")?;

    // 핸드셰이크가 끝났으니 이제 짧은 폴링으로 바꾼다. 여기부터는 루프가 주기적으로 돌아와야
    // 큐에 쌓인 입력을 내보낼 수 있다.
    upgraded_framed
        .get_inner_mut()
        .0
        .sock
        .set_read_timeout(Some(SESSION_READ_POLL))
        .context("set session read timeout")?;

    Ok((
        connection_result,
        upgraded_framed,
        egfx_surface,
        egfx_unusable,
    ))
}

fn lookup_addr(hostname: &str, port: u16) -> anyhow::Result<core::net::SocketAddr> {
    use std::net::ToSocketAddrs as _;
    (hostname, port)
        .to_socket_addrs()?
        .next()
        .context("socket address not found")
}

type TlsStream = rustls::StreamOwned<rustls::ClientConnection, TcpStream>;

fn tls_upgrade(
    stream: TcpStream,
    server_name: String,
) -> anyhow::Result<(TlsStream, Vec<u8>, CertificatePayload)> {
    let mut config = rustls::client::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(danger::NoCertificateVerification))
        .with_no_client_auth();

    // Disable TLS resumption because CredSSP does not support it.
    config.resumption = rustls::client::Resumption::disabled();

    let client = rustls::ClientConnection::new(Arc::new(config), server_name.try_into()?)?;
    let mut tls_stream = rustls::StreamOwned::new(client, stream);

    // Flush to drive the handshake far enough that the peer certificate is available.
    tls_stream.flush()?;

    let cert = tls_stream
        .conn
        .peer_certificates()
        .and_then(|certificates| certificates.first())
        .context("peer certificate is missing")?;

    let server_public_key = extract_tls_server_public_key(cert)?;
    let certificate = describe_certificate(cert)?;

    Ok((tls_stream, server_public_key, certificate))
}

/// 사용자가 대조할 수 있는 형태로 인증서를 요약한다.
///
/// 지문은 인증서 DER 전체의 SHA-256 이다 — mstsc 와 FreeRDP 가 저장하는 것과 같은 값이라,
/// 사용자가 다른 클라이언트에서 본 지문과 눈으로 맞춰볼 수 있다.
fn describe_certificate(der: &[u8]) -> anyhow::Result<CertificatePayload> {
    use sha2::{Digest as _, Sha256};
    use x509_cert::der::Decode as _;

    let digest = Sha256::digest(der);
    let fingerprint = digest
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":");

    let cert = x509_cert::Certificate::from_der(der)?;
    let tbs = cert.tbs_certificate();

    Ok(CertificatePayload {
        fingerprint,
        subject: tbs.subject().to_string(),
        issuer: tbs.issuer().to_string(),
        not_after: tbs.validity().not_after.to_string(),
    })
}

fn extract_tls_server_public_key(cert: &[u8]) -> anyhow::Result<Vec<u8>> {
    use x509_cert::der::Decode as _;

    let cert = x509_cert::Certificate::from_der(cert)?;

    cert.tbs_certificate()
        .subject_public_key_info()
        .subject_public_key
        .as_bytes()
        .context("subject public key BIT STRING is not aligned")
        .map(<[u8]>::to_owned)
}

mod danger {
    use tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use tokio_rustls::rustls::{DigitallySignedStruct, Error, SignatureScheme, pki_types};

    /// TODO(before release): RDP servers normally present a self-signed certificate, so a CA check
    /// is not the answer — pinning is. The app already keeps SSH known-hosts state and surfaces a
    /// trust prompt; RDP needs the same, keyed on the certificate fingerprint. Until that exists
    /// this accepts any certificate, which leaves the connection open to an active
    /// man-in-the-middle. Not shippable as-is.
    #[derive(Debug)]
    pub(super) struct NoCertificateVerification;

    impl ServerCertVerifier for NoCertificateVerification {
        fn verify_server_cert(
            &self,
            _: &pki_types::CertificateDer<'_>,
            _: &[pki_types::CertificateDer<'_>],
            _: &pki_types::ServerName<'_>,
            _: &[u8],
            _: pki_types::UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _: &[u8],
            _: &pki_types::CertificateDer<'_>,
            _: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _: &[u8],
            _: &pki_types::CertificateDer<'_>,
            _: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            vec![
                SignatureScheme::RSA_PKCS1_SHA256,
                SignatureScheme::ECDSA_NISTP256_SHA256,
                SignatureScheme::RSA_PKCS1_SHA384,
                SignatureScheme::ECDSA_NISTP384_SHA384,
                SignatureScheme::RSA_PKCS1_SHA512,
                SignatureScheme::ECDSA_NISTP521_SHA512,
                SignatureScheme::RSA_PSS_SHA256,
                SignatureScheme::RSA_PSS_SHA384,
                SignatureScheme::RSA_PSS_SHA512,
                SignatureScheme::ED25519,
            ]
        }
    }
}

#[cfg(test)]
mod layout_tests {
    use super::build_monitor_layout;
    use crate::protocol::MonitorRequest;

    fn monitor(width: u16, height: u16, left: i32, top: i32, primary: bool) -> MonitorRequest {
        MonitorRequest {
            width,
            height,
            left,
            top,
            primary,
        }
    }

    #[test]
    fn places_two_monitors_side_by_side() {
        let layout = build_monitor_layout(&[
            monitor(2560, 1440, 0, 0, true),
            monitor(2560, 1440, 2560, 0, false),
        ])
        .unwrap();

        assert_eq!((layout.desktop_width, layout.desktop_height), (5120, 1440));
        // right/bottom 은 inclusive — 2560 폭은 2559 에서 끝난다.
        assert_eq!(
            (layout.declared[0].left, layout.declared[0].right),
            (0, 2559)
        );
        assert_eq!(
            (layout.declared[1].left, layout.declared[1].right),
            (2560, 5119)
        );
    }

    #[test]
    fn keeps_the_primary_at_the_declaration_origin_when_it_is_not_leftmost() {
        // 보조가 주 모니터 왼쪽에 있는 배치. 선언 공간에서는 음수가, 프레임버퍼에서는 주
        // 모니터가 오른쪽으로 밀린 값이 나와야 한다. 이 둘을 섞는 것이 대표적인 오류다.
        let layout = build_monitor_layout(&[
            monitor(1920, 1080, 0, 0, true),
            monitor(1920, 1080, -1920, 0, false),
        ])
        .unwrap();

        assert_eq!((layout.desktop_width, layout.desktop_height), (3840, 1080));
        assert_eq!(layout.declared[0].left, 0, "primary sits at the origin");
        assert_eq!(layout.declared[1].left, -1920, "secondary is negative");

        assert_eq!(layout.placements[0].left, 1920, "primary shifts in the framebuffer");
        assert_eq!(layout.placements[1].left, 0);
    }

    #[test]
    fn marks_exactly_one_monitor_primary() {
        use ironrdp_pdu::gcc::MonitorFlags;

        let layout = build_monitor_layout(&[
            monitor(1920, 1080, 0, 0, false),
            monitor(1920, 1080, 1920, 0, true),
        ])
        .unwrap();

        let primaries = layout
            .declared
            .iter()
            .filter(|m| m.flags.contains(MonitorFlags::PRIMARY))
            .count();
        assert_eq!(primaries, 1);
        // 두 번째가 primary 라고 했으니 그것이 원점이어야 한다.
        assert_eq!(layout.declared[1].left, 0);
        assert_eq!(layout.declared[0].left, -1920);
    }

    #[test]
    fn treats_the_first_monitor_as_primary_when_none_is_marked() {
        let layout = build_monitor_layout(&[
            monitor(1920, 1080, 0, 0, false),
            monitor(1920, 1080, 1920, 0, false),
        ])
        .unwrap();

        assert_eq!(layout.declared[0].left, 0);
    }

    #[test]
    fn spans_the_bounding_box_when_monitors_differ_in_size() {
        let layout = build_monitor_layout(&[
            monitor(2560, 1440, 0, 0, true),
            monitor(1920, 1080, 2560, 200, false),
        ])
        .unwrap();

        assert_eq!((layout.desktop_width, layout.desktop_height), (4480, 1440));
        assert_eq!(layout.placements[1].top, 200);
    }

    #[test]
    fn every_placement_lands_inside_the_desktop() {
        let layout = build_monitor_layout(&[
            monitor(1280, 1024, 0, 0, true),
            monitor(1280, 1024, -1280, -1024, false),
            monitor(1280, 1024, 1280, 1024, false),
        ])
        .unwrap();

        for placement in &layout.placements {
            assert!(placement.left + placement.width <= layout.desktop_width);
            assert!(placement.top + placement.height <= layout.desktop_height);
        }
    }

    #[test]
    fn rejects_more_monitors_than_the_protocol_allows() {
        let many: Vec<_> = (0..17)
            .map(|i| monitor(1920, 1080, i * 1920, 0, i == 0))
            .collect();
        assert!(build_monitor_layout(&many).is_err());
    }

    #[test]
    fn rejects_an_empty_layout() {
        assert!(build_monitor_layout(&[]).is_err());
    }
}

#[cfg(test)]
mod reactivation_tests {
    use super::is_io_channel_pdu;
    use ironrdp_pdu::mcs::SendDataIndication;
    use ironrdp_pdu::x224::X224;
    use ironrdp_pdu::ironrdp_core::encode_vec;
    use std::borrow::Cow;

    const IO_CHANNEL: u16 = 1003;

    fn send_data_indication(channel_id: u16) -> Vec<u8> {
        let pdu = X224(SendDataIndication {
            initiator_id: 1002,
            channel_id,
            user_data: Cow::Borrowed(&[0u8; 8]),
        });
        encode_vec(&pdu).expect("encode")
    }

    #[test]
    fn io_channel_data_goes_to_the_activation_sequence() {
        assert!(is_io_channel_pdu(
            &send_data_indication(IO_CHANNEL),
            IO_CHANNEL
        ));
    }

    #[test]
    fn virtual_channel_data_is_held_back() {
        // rdpsnd·cliprdr·rdpdr 은 각자의 채널로 온다. 이걸 시퀀스에 넘기면 ShareControl 로
        // 디코드하다 `invalid pdu_type` 으로 세션이 죽는다 — 재활성화 중 간헐 크래시의 원인.
        for channel_id in [1004u16, 1005, 1006] {
            assert!(
                !is_io_channel_pdu(&send_data_indication(channel_id), IO_CHANNEL),
                "channel {channel_id} should be held back"
            );
        }
    }

    #[test]
    fn undecodable_pdus_stay_with_the_sequence() {
        // MCS 연결 해제처럼 SendDataIndication 이 아닌 것들은 시퀀스가 처리해야 한다.
        assert!(is_io_channel_pdu(&[0x03, 0x00, 0x00, 0x09], IO_CHANNEL));
        assert!(is_io_channel_pdu(&[], IO_CHANNEL));
    }
}
