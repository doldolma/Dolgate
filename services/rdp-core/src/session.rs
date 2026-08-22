//! One RDP session: connect, then pump graphics updates out as stream frames.

use core::time::Duration;
use std::io::Write as _;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, TryRecvError};

use anyhow::Context as _;
use core_framing::{checked_rgba_framebuffer_len, MAX_FRAMEBUFFER_PIXELS};
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
use ironrdp_displaycontrol::pdu::{
    DisplayControlMonitorLayout, DisplayControlPdu, MonitorLayoutEntry,
};
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

/// TCP 를 잡는 데 허용하는 시간.
///
/// OS 기본값(맥·리눅스에서 1분 넘는다)에 맡기면, 닿지 않는 주소로 붙는 세션의 스레드가 그만큼
/// 남는다. TCP 핸드셰이크는 왕복 세 번이라 느린 회선에서도 이보다 한참 짧다.
const DIAL_TIMEOUT: Duration = Duration::from_secs(20);

/// dial 이 끝났는지 확인하는 주기. 취소에 얼마나 빨리 반응하는지가 이 값이다.
const DIAL_POLL: Duration = Duration::from_millis(50);

/// 연결 도중 취소를 위해 들고 있는 소켓 사본.
///
/// **연결 단계에서는 `stop` 플래그만으로 멈출 수 없다.** 핸드셰이크 읽기가 최대
/// `HANDSHAKE_READ_TIMEOUT` 만큼 블로킹되고(CredSSP·라이선스 교환이 그만큼 걸릴 수 있어 짧게
/// 둘 수도 없다), 그 읽기는 우리가 아니라 크레이트 안에서 일어난다. 그래서 플래그를 세워도
/// 스레드는 30초 뒤에야 깨어나고, 사용자가 탭을 닫은 지 한참 뒤에 timeout 오류가 올라왔다.
///
/// 소켓 사본을 하나 들고 있다가 `shutdown` 하면 그 블로킹 읽기가 즉시 돌아온다. 취소를 실제로
/// 전파하는 유일한 방법이다.
pub type CancelSocket = Arc<std::sync::Mutex<Option<TcpStream>>>;

/// 취소된 세션. 오류가 아니라 "사용자가 닫았다" 는 뜻이라 사용자에게 메시지를 보내지 않는다.
#[derive(Debug)]
struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the session was cancelled before it finished connecting")
    }
}

impl std::error::Error for Cancelled {}

fn validate_framebuffer_size(width: u16, height: u16) -> anyhow::Result<()> {
    checked_rgba_framebuffer_len(usize::from(width), usize::from(height))
        .map(|_| ())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "remote framebuffer {width}x{height} exceeds the {MAX_FRAMEBUFFER_PIXELS} pixel limit"
            )
        })
}

pub fn run(
    session_id: String,
    request_id: String,
    payload: ConnectPayload,
    output: Arc<Output>,
    stop: Arc<AtomicBool>,
    input: Receiver<Vec<InputEvent>>,
    trust: Receiver<bool>,
    resize: Receiver<(u16, u16)>,
    layout_updates: Receiver<Vec<crate::protocol::MonitorRequest>>,
    refresh: Receiver<()>,
    local_clipboard: Receiver<String>,
    // 렌더러가 캡처한 마이크 PCM. 마이크를 끈 세션에서는 아무것도 오지 않는다.
    microphone: Receiver<Vec<u8>>,
    // 렌더러가 인코딩한 카메라 프레임(H.264). 카메라를 끈 세션에서는 아무것도 오지 않는다.
    camera: Receiver<Vec<u8>>,
    // 연결 도중 취소를 전파하기 위한 소켓 슬롯. 붙는 즉시 여기에 사본을 넣는다.
    cancel_socket: CancelSocket,
) {
    // 그래픽 파이프라인은 한 번 써 보고, 이 서버가 우리가 못 푸는 것을 보내면 그것 없이 다시
    // 붙는다. 접속 도중 판정되므로(첫 화면이 그려질 때) 사용자가 뭘 하기 전에 끝난다.
    // 그래픽 파이프라인을 끄고 붙는 탈출구.
    //
    // 화면이나 소리가 이상할 때 "EGFX 때문인지"를 재빌드 없이 가르려면 이게 필요하다. 실제로
    // 오디오 무음이 EGFX 탓인지 아닌지도 이걸로 갈랐다.
    let mut allow_egfx = std::env::var_os("DOLGATE_RDP_NO_EGFX").is_none();
    let mut trusted_fingerprint: Option<String> = None;
    // 서버가 세션을 정상적으로 끝냈을 때 그 이유. 네트워크가 끊기면 IO 오류가 되어 여기 안 온다.
    // 앱이 자동 재연결 여부를 이걸로 가른다 — 로그오프한 세션을 되살리면 안 된다.
    let graceful_reason: Arc<std::sync::Mutex<Option<String>>> =
        Arc::new(std::sync::Mutex::new(None));

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
            &layout_updates,
            &refresh,
            &local_clipboard,
            &microphone,
            &camera,
            &graceful_reason,
            allow_egfx,
            &mut trusted_fingerprint,
            &cancel_socket,
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
            // 사용자가 연결 도중 탭을 닫았다. 오류가 아니므로 메시지를 올리지 않는다 — 닫아
            // 버린 세션의 실패 안내가 뒤늦게 뜨면 무슨 일인지 알 수 없다.
            Err(error) if stop.load(Ordering::Relaxed) => {
                debug!(
                    session_id,
                    error = format!("{error:#}"),
                    "connect abandoned after the session was cancelled"
                );
                break;
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

    let reason = graceful_reason.lock().ok().and_then(|slot| slot.clone());
    let _ = output.send_event(
        &Event::new("closed", crate::protocol::ClosedPayload {
            graceful: reason.is_some(),
            reason,
        })
        .session(&session_id),
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
    layout_updates: &Receiver<Vec<crate::protocol::MonitorRequest>>,
    refresh: &Receiver<()>,
    local_clipboard: &Receiver<String>,
    // 렌더러가 캡처한 마이크 PCM. 협상된 사양의 원본 바이트다(변환은 렌더러가 한다).
    microphone: &Receiver<Vec<u8>>,
    // 렌더러가 인코딩한 카메라 프레임. 한 항목이 한 장이다.
    camera: &Receiver<Vec<u8>>,
    graceful_reason: &Arc<std::sync::Mutex<Option<String>>>,
    allow_egfx: bool,
    trusted_fingerprint: &mut Option<String>,
    cancel_socket: &CancelSocket,
) -> anyhow::Result<()> {
    // 이미 취소됐으면 붙지 않는다. EGFX 없이 다시 붙는 경로에서 특히 중요하다 — 사용자가 그
    // 사이에 탭을 닫았을 수 있다.
    anyhow::ensure!(!stop.load(Ordering::Relaxed), Cancelled);

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

    // 마이크(AUDIO_INPUT). 협상이 끝나면 코어가 캡처 사양을 이 채널로 알리고, 펌프가 그것을
    // 이벤트로 올려 렌더러가 그 사양대로 마이크를 잡는다.
    let (mic_format_tx, mic_format_rx) = std::sync::mpsc::channel();
    // 채널이 열렸는지·OPEN 까지 왔는지를 붙이는 쪽과 펌프가 나눠 갖는다.
    let mic_channel = Arc::new(crate::audio_input::AudinChannel::default());

    let (clipboard_tx, clipboard_rx) = std::sync::mpsc::channel();
    let clipboard_backend = TextClipboardBackend::new(
        session_id.to_owned(),
        Arc::clone(output),
        clipboard_tx,
    );

    // 카메라(MS-RDPECAM). 채널 상태는 펌프가 보고(프레임을 보낼 수 있는지), 신호는 렌더러에
    // 이벤트로 올린다(캡처 시작·정지·허락).
    let camera_channel = Arc::new(crate::camera::CameraChannel::default());
    let (camera_signal_tx, camera_signal_rx) = std::sync::mpsc::channel();

    let (connection_result, framed, egfx_surface, egfx_unusable) = connect(
        config,
        payload.host.clone(),
        payload.port,
        payload.dial_address.clone(),
        payload.tunnel_auth_token.clone(),
        session_id,
        request_id,
        output,
        trust,
        payload.clipboard.then_some(clipboard_backend),
        payload.audio.then(|| {
            AudioBackend::new(session_id.to_owned(), Arc::clone(output), Arc::clone(&audio_heard))
        }),
        Box::new({
            let session_id = session_id.to_owned();
            let output = Arc::clone(output);
            let heard = Arc::clone(&audio_heard);
            move || AudioBackend::new(session_id.clone(), Arc::clone(&output), Arc::clone(&heard))
        }),
        payload.microphone.then(|| mic_format_tx.clone()),
        &mic_channel,
        payload
            .camera
            .then(|| (Arc::clone(&camera_channel), camera_signal_tx.clone())),
        payload
            .drives
            .iter()
            .map(|share| crate::drive::DriveShareConfig {
                label: share.label.clone(),
                path: share.path.clone(),
                read_only: share.read_only,
            })
            .collect(),
        allow_egfx,
        trusted_fingerprint,
        stop,
        cancel_socket,
    )
    .context("connect")?;

    let desktop = connection_result.desktop_size;
    validate_framebuffer_size(desktop.width, desktop.height)
        .context("server desktop size")?;
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
        // 관리 세션 요청이 실렸는지. 서버가 이걸 무시하는지 가릴 때 이 줄부터 본다.
        admin_session = payload.admin_session,
        // 마이크를 요청했는지. **우리가 안 보낸 것과 서버가 거절한 것을 가리는 유일한 근거다** —
        // audin 줄이 아예 없을 때 이 값이 false 면 우리 문제, true 면 서버가 채널을 열지 않은 것이다.
        microphone_requested = payload.microphone,
        "connected"
    );

    let placements = resolve_placements(session_id, desktop.width, desktop.height, &layout);

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
        layout_updates,
        refresh,
        &clipboard_rx,
        local_clipboard,
        graceful_reason,
        layout,
        &egfx_surface,
        &egfx_unusable,
        &audio_heard,
        microphone,
        payload.microphone,
        &mic_channel,
        &mic_format_rx,
        camera,
        &camera_channel,
        &camera_signal_rx,
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
    layout_updates: &Receiver<Vec<crate::protocol::MonitorRequest>>,
    refresh: &Receiver<()>,
    clipboard: &Receiver<ClipboardMessage>,
    local_clipboard: &Receiver<String>,
    graceful_reason: &Arc<std::sync::Mutex<Option<String>>>,
    // 지금 선언돼 있는 배치. 크기가 바뀔 때 각 모니터 몫을 다시 계산하는 데 쓴다.
    declared: MonitorLayout,
    egfx: &crate::egfx_surface::EgfxSurfaceHandle,
    egfx_unusable: &crate::egfx::EgfxUnusable,
    audio_heard: &crate::audio::AudioHeard,
    // 렌더러가 캡처한 마이크 PCM.
    microphone: &Receiver<Vec<u8>>,
    // 이 세션이 마이크를 요청했는지. 요청했는데 채널이 안 열리면 그 사실을 사용자에게 알린다.
    microphone_requested: bool,
    // 마이크 채널의 상태. 리스너로 붙인 채널이라 크레이트의 TypeId 조회로는 찾을 수 없다.
    mic_channel: &Arc<crate::audio_input::AudinChannel>,
    // audin 협상이 끝나면 오는 캡처 사양. 렌더러에 그대로 올린다.
    mic_format: &Receiver<crate::audio_input::CaptureFormat>,
    // 렌더러가 인코딩한 카메라 프레임.
    camera: &Receiver<Vec<u8>>,
    // 카메라 채널 상태(보낼 수 있는지)와 서버가 만든 신호(시작·정지·허락).
    camera_channel: &Arc<crate::camera::CameraChannel>,
    camera_signals: &Receiver<crate::camera::CameraSignal>,
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
    {
        let mut surface = egfx
            .lock()
            .map_err(|_| anyhow::anyhow!("egfx surface lock poisoned"))?;
        surface
            .try_resize(egfx_size.0, egfx_size.1)
            .context("initialize egfx framebuffer")?;
    }
    // 마지막으로 화면을 내보낸 시각.
    let mut last_flush = std::time::Instant::now();
    // 채널이 열리기 전에 온 크기 요청.
    let mut pending_resize: Option<(u16, u16)> = None;
    // 지금 선언된 배치와, 채널이 열리기를 기다리는 배치.
    let mut declared = declared;
    let mut pending_layout: Option<MonitorLayout> = None;
    // 소리가 오지 않는다는 것도 한 번은 남긴다.
    let started = std::time::Instant::now();
    let mut logged_silence = false;
    // 마이크 채널이 안 열린 것을 한 번만 알린다.
    let mut warned_no_microphone = false;
    // 마이크 조각을 몇 개 실어 보냈는지(로그용).
    let mut mic_sent: u64 = 0;
    // 카메라 프레임을 몇 장 실어 보냈는지(로그용).
    let mut camera_sent: u64 = 0;
    // Tracks which keys and buttons are currently down so a press/release pair is never lost and
    // the server is never left with a stuck modifier.
    let mut input_db = Database::new();

    while !stop.load(Ordering::Relaxed) {
        if !flush_input(input, &mut input_db, &mut active_stage, &mut framed, image)? {
            // The sender is gone: the session is being torn down.
            return Ok(());
        }

        flush_resize_requests(resize, &mut active_stage, &mut framed, &mut pending_resize)?;
        flush_microphone(
            session_id,
            microphone,
            mic_format,
            &mut active_stage,
            &mut framed,
            output,
            mic_channel,
            &mut mic_sent,
        )?;
        flush_camera(
            session_id,
            camera,
            camera_signals,
            &mut active_stage,
            &mut framed,
            output,
            camera_channel,
            &mut camera_sent,
        )?;
        if flush_layout_requests(
            session_id,
            layout_updates,
            &mut active_stage,
            &mut framed,
            &mut declared,
            &mut pending_layout,
        )? && egfx_active(egfx)
        {
            // 그래픽 파이프라인은 재활성화 없이 배치를 바꾼다(ResetGraphics). 전체 크기가 그대로면
            // (노치 33px 처럼 한 화면만 줄면 바운딩 박스는 안 바뀐다) 아래의 크기 비교로는 아무
            // 일도 일어나지 않아, 나눠 그리는 창들이 옛 사각형으로 계속 잘라 낸다 = 레터박스.
            //
            // 레거시 경로는 서버가 반드시 재활성화를 보내므로 거기서 알린다 — 여기서 또 보내면
            // 같은 값을 두 번 보내게 된다.
            //
            // 서버가 실제로 배치를 바꾸는 데 1초쯤 걸리므로 그 사이 한 화면이 33px 밀려 보일 수
            // 있다. 영구히 어긋난 채로 두는 것보다 낫다.
            output.send_event(
                &Event::new("resized", ResizedPayload {
                    desktop_width: declared.desktop_width,
                    desktop_height: declared.desktop_height,
                    monitors: declared.placements.clone(),
                })
                .session(session_id),
            )?;
        }
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
                    monitors: resolve_placements(session_id, current.0, current.1, &declared),
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

        // 마이크를 요청했는데 채널이 안 열리면 **사용자에게 말한다.** 침묵하면 사용자는 마이크가
        // 켜진 줄 알고 원격에서 말한다 — 실제로 그렇게 됐다.
        //
        // **왜 안 열렸는지는 여기서 알 수 없다.** 서버가 리디렉션을 막아 둔 경우와, 원격에서 아직
        // 아무도 마이크를 요청하지 않은 경우가 같은 모양이다(정책·오디오 서비스가 모두 허용인
        // 서버에서도 유휴 데스크톱에서는 열리지 않았다 — 실측). 그래서 단정하지 않고 사실만 적는다.
        if !warned_no_microphone
            && microphone_requested
            && started.elapsed() >= std::time::Duration::from_secs(10)
            && !mic_channel.created()
        {
            warned_no_microphone = true;
            info!(
                session_id,
                "the server has not opened AUDIO_INPUT within 10s (policy, or nothing is recording)"
            );
            output.send_event(
                &Event::new(
                    "microphoneUnavailable",
                    crate::protocol::MicrophoneUnavailablePayload {
                        reason: "serverRefused",
                    },
                )
                .session(session_id),
            )?;
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
                    // 정상 종료다(로그오프·서버가 끊음). 여기 기록해 두면 closed 이벤트가
                    // 그 사실을 실어 나가고, 앱이 자동 재연결을 하지 않는다.
                    if let Ok(mut slot) = graceful_reason.lock() {
                        *slot = Some(reason.description());
                    }
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
                    validate_framebuffer_size(desktop.width, desktop.height)
                        .context("reactivated desktop size")?;

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
                    {
                        let mut surface = egfx
                            .lock()
                            .map_err(|_| anyhow::anyhow!("egfx surface lock poisoned"))?;
                        if surface.size() != (0, 0) {
                            surface
                                .try_resize(desktop.width, desktop.height)
                                .context("resize egfx framebuffer after reactivation")?;
                        }
                    }

                    output.send_event(
                        &Event::new("resized", ResizedPayload {
                            desktop_width: desktop.width,
                            desktop_height: desktop.height,
                            monitors: resolve_placements(
                                session_id,
                                desktop.width,
                                desktop.height,
                                &declared,
                            ),
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
        if !backend.set_local_text(text) {
            return Ok(());
        }
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

/// 모니터 배치를 다시 선언한다.
///
/// 접속할 때는 디스플레이 크기로 선언하는데, 창이 실제로 그릴 수 있는 크기는 그보다 작을 수
/// 있다(노치 있는 맥북은 전체화면이어도 33px 을 못 쓴다). 그 실측값이 오면 여기서 다시 선언해
/// 원격 데스크톱을 그릴 수 있는 크기로 만든다 — 그래야 축소도 레터박스도 없다.
///
/// [MS-RDPEDISP] 의 배치 PDU 는 모니터 여러 개를 받는다. `ActiveStage::encode_resize` 는 단일
/// 주 모니터 전용 헬퍼라 여기서는 쓸 수 없다.
///
/// 성공하면 `declared` 를 새 배치로 바꾼다. 크기 변경이 실제로 도착했을 때 각 모니터 몫을
/// 이 배치로 계산한다.
fn flush_layout_requests(
    session_id: &str,
    layout_updates: &Receiver<Vec<crate::protocol::MonitorRequest>>,
    active_stage: &mut ActiveStage,
    framed: &mut UpgradedFramed,
    declared: &mut MonitorLayout,
    // 아직 못 보낸 배치. DISP 채널이 열릴 때까지 들고 있는다.
    pending: &mut Option<MonitorLayout>,
) -> anyhow::Result<bool> {
    let mut latest = pending.take();
    loop {
        match layout_updates.try_recv() {
            Ok(monitors) => match build_monitor_layout(&normalize_layout_sizes(&monitors)) {
                Ok(layout) => latest = Some(layout),
                Err(error) => {
                    // 보낼 수 없는 배치다. 지금 선언된 배치를 그대로 두는 편이 낫다 —
                    // 화면이 깨지는 대신 정정만 안 될 뿐이다.
                    warn!(
                        session_id,
                        error = format!("{error:#}"),
                        "ignoring an invalid monitor layout"
                    );
                }
            },
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => break,
        }
    }

    let Some(layout) = latest else {
        return Ok(false);
    };

    // 지금 선언된 것과 같으면 보내지 않는다. 배치 PDU 하나하나가 재활성화 왕복이라, 창 이벤트가
    // 여러 번 올 때마다 보내면 화면이 계속 멎는다.
    if layout.same_as(declared) {
        return Ok(false);
    }

    let Some(entries) = layout_entries(session_id, &layout) else {
        return Ok(false);
    };

    // None 이면 DISP 채널이 아직 안 열렸다는 뜻이다(접속 직후 조금 뒤에 열린다). 버리면 창을
    // 다시 흔들 때까지 정정이 안 되므로 들고 있다가 열리면 보낸다 — flush_resize_requests 와
    // 같은 이유다.
    let Some(encoded) = encode_monitor_layout(active_stage, &entries) else {
        *pending = Some(layout);
        return Ok(false);
    };

    framed
        .write_all(&encoded.context("encode monitor layout")?)
        .context("write monitor layout request")?;

    info!(
        session_id,
        desktop_width = layout.desktop_width,
        desktop_height = layout.desktop_height,
        monitors = layout
            .placements
            .iter()
            .map(|p| format!("{}x{}@({},{})", p.width, p.height, p.left, p.top))
            .collect::<Vec<_>>()
            .join(" "),
        "declaring a new monitor layout"
    );

    *declared = layout;
    Ok(true)
}

/// 배치 PDU 가 받아들이는 크기로 미리 맞춘다.
///
/// PDU 는 양변 200~8192 에 폭은 짝수만 받는다([MS-RDPEDISP] 2.2.2.2.1). 여기서 안 맞추면 우리가
/// 계산한 프레임버퍼 배치는 요청한 크기 그대로인데 실제로 선언되는 것은 보정된 크기여서, 서버가
/// 1px 다른 데스크톱을 주고 그걸 "요청과 다르다"고 판단해 배치를 통째로 포기한다 — 폭이 홀수인
/// 화면(맥의 1707x1067 같은 스케일 모드)에서 멀티모니터가 조용히 안 되던 원인이 된다.
fn normalize_layout_sizes(
    monitors: &[crate::protocol::MonitorRequest],
) -> Vec<crate::protocol::MonitorRequest> {
    monitors
        .iter()
        .map(|monitor| {
            let (width, height) = MonitorLayoutEntry::adjust_display_size(
                u32::from(monitor.width),
                u32::from(monitor.height),
            );
            crate::protocol::MonitorRequest {
                width: u16::try_from(width).unwrap_or(monitor.width),
                height: u16::try_from(height).unwrap_or(monitor.height),
                ..*monitor
            }
        })
        .collect()
}

/// 선언 좌표계의 모니터들을 배치 PDU 항목으로 바꾼다.
///
/// 규격 위반이면 서버가 요청 전체를 버리므로 `MonitorLayoutEntry::adjust_display_size` 로
/// 미리 맞춘다(양변 200~8192, 폭은 짝수).
fn layout_entries(session_id: &str, layout: &MonitorLayout) -> Option<Vec<MonitorLayoutEntry>> {
    let mut entries = Vec::with_capacity(layout.declared.len());
    for monitor in &layout.declared {
        let primary = monitor
            .flags
            .contains(ironrdp_pdu::gcc::MonitorFlags::PRIMARY);
        // right/bottom 은 inclusive 다.
        let width = u32::try_from(monitor.right - monitor.left + 1).ok()?;
        let height = u32::try_from(monitor.bottom - monitor.top + 1).ok()?;
        let (width, height) = MonitorLayoutEntry::adjust_display_size(width, height);

        let entry = if primary {
            MonitorLayoutEntry::new_primary(width, height)
        } else {
            MonitorLayoutEntry::new_secondary(width, height)
                .and_then(|entry| entry.with_position(monitor.left, monitor.top))
        };

        match entry {
            Ok(entry) => entries.push(entry),
            Err(error) => {
                warn!(
                    session_id,
                    error = format!("{error}"),
                    "could not describe a monitor in the layout"
                );
                return None;
            }
        }
    }
    Some(entries)
}

/// 배치 PDU 를 DISP 채널로 실어 보낼 바이트로 만든다.
///
/// 채널이 아직 없으면 `None`. `ActiveStage::encode_resize` 가 단일 모니터에 대해 하는 일과
/// 같은 순서다(채널 조회 → PDU → DVC 인코딩).
fn encode_monitor_layout(
    active_stage: &mut ActiveStage,
    entries: &[MonitorLayoutEntry],
) -> Option<anyhow::Result<Vec<u8>>> {
    let dvc = active_stage.get_dvc::<DisplayControlClient>()?;
    let channel_id = dvc.channel_id()?;
    let pdu: DisplayControlPdu = match DisplayControlMonitorLayout::new(entries) {
        Ok(layout) => layout.into(),
        Err(error) => return Some(Err(anyhow::anyhow!("{error}"))),
    };

    let messages = match ironrdp_dvc::encode_dvc_messages(
        channel_id,
        vec![Box::new(pdu)],
        ironrdp_svc::ChannelFlags::empty(),
    ) {
        Ok(messages) => messages,
        Err(error) => return Some(Err(anyhow::anyhow!("{error}"))),
    };

    Some(
        active_stage
            .encode_dvc_messages(messages)
            .map_err(|error| anyhow::anyhow!("{error}")),
    )
}

/// 마이크 PCM 을 AUDIO_INPUT 채널로 흘려보내고, 협상된 캡처 사양을 렌더러에 알린다.
///
/// 크기 변경(DISP)과 같은 모양이다 — 펌프가 채널에서 꺼내 DVC 로 인코딩해 보낸다. 채널 처리기
/// 안에서 보내지 않는 이유는 그쪽이 서버 메시지를 처리하는 자리라, 거기서 캡처를 기다리면 화면
/// 갱신까지 함께 막히기 때문이다.
///
/// **협상이 끝나기 전에 온 PCM 은 버린다.** 채널이 열리기 전에 보내면 서버가 무시하고, 우리가
/// 쌓아 두면 나중에 몇 초 밀린 소리가 한꺼번에 나간다 — 마이크는 늦은 소리보다 없는 소리가 낫다.
/// 카메라 신호를 렌더러에 올리고, 허락이 있으면 프레임을 실어 보낸다.
///
/// **서버가 당겨 간다(credit).** 허락이 없으면 보내지 않는다 — 보내도 서버가 버린다. 그리고
/// H.264 는 인코딩된 프레임을 버릴 수 없으므로(참조 사슬이 끊긴다) 여기서는 절대 버리지 않고,
/// 버리는 것은 렌더러가 인코딩 전에 한다. 그래서 이 함수는 큐에 쌓인 것을 허락만큼만 흘린다.
fn flush_camera(
    session_id: &str,
    camera: &Receiver<Vec<u8>>,
    signals: &Receiver<crate::camera::CameraSignal>,
    active_stage: &mut ActiveStage,
    framed: &mut UpgradedFramed,
    output: &Output,
    channel: &Arc<crate::camera::CameraChannel>,
    sent: &mut u64,
) -> anyhow::Result<()> {
    // 1) 서버가 만든 신호를 렌더러에 올린다. 이것 없이는 렌더러가 캡처를 시작할 수 없다.
    while let Ok(signal) = signals.try_recv() {
        match signal {
            crate::camera::CameraSignal::Start { width, height, fps } => {
                output.send_event(
                    &Event::new("cameraStart", crate::protocol::CameraStartPayload {
                        width,
                        height,
                        fps,
                    })
                    .session(session_id),
                )?;
            }
            crate::camera::CameraSignal::Stop => {
                output.send_event(
                    &Event::new("cameraStop", crate::protocol::EmptyPayload {}).session(session_id),
                )?;
            }
            crate::camera::CameraSignal::Credit => {
                output.send_event(
                    &Event::new("cameraCredit", crate::protocol::CameraCreditPayload {
                        credit: 1,
                    })
                    .session(session_id),
                )?;
            }
        }
    }

    // 2) 허락이 있는 만큼 프레임을 보낸다.
    loop {
        let Some((channel_id, stream_index)) = channel.ready() else {
            break;
        };
        let frame = match camera.try_recv() {
            Ok(frame) => frame,
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
        };
        if !channel.take_credit() {
            // 그 사이에 허락이 사라졌다(정지 요청 등). 이 프레임은 버린다 — 다음 시작에서
            // 렌더러가 키프레임부터 다시 보낸다.
            break;
        }
        let bytes = frame.len();
        let messages = ironrdp_dvc::encode_dvc_messages(
            channel_id,
            crate::camera::encode_sample(stream_index, frame),
            ironrdp_svc::ChannelFlags::empty(),
        )
        .map_err(|error| anyhow::anyhow!("{error}"))?;
        let encoded = active_stage
            .encode_dvc_messages(messages)
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        framed.write_all(&encoded).context("send camera frame")?;
        *sent += 1;
        if *sent == 1 || *sent % 100 == 0 {
            debug!(session_id, frames = *sent, bytes, "camera frame sent");
        }
    }
    Ok(())
}

fn flush_microphone(
    session_id: &str,
    microphone: &Receiver<Vec<u8>>,
    mic_format: &Receiver<crate::audio_input::CaptureFormat>,
    active_stage: &mut ActiveStage,
    framed: &mut UpgradedFramed,
    output: &Output,
    mic_channel: &Arc<crate::audio_input::AudinChannel>,
    // 지금까지 보낸 조각 수. 첫 조각과 이후 100개마다 로그를 남기는 데만 쓴다 — 마이크가
    // "안 된다" 는 신고가 들어왔을 때 렌더러가 안 보내는 것과 우리가 안 싣는 것을 갈라야 한다.
    mic_sent: &mut u64,
) -> anyhow::Result<()> {
    // 사양이 정해졌으면 렌더러에 먼저 알린다. 그래야 그 사양대로 잡은 PCM 이 오기 시작한다.
    while let Ok(format) = mic_format.try_recv() {
        output.send_event(
            &Event::new("microphoneFormat", crate::protocol::MicrophoneFormatPayload {
                sample_rate: format.sample_rate,
                channels: format.channels,
                bits_per_sample: format.bits_per_sample,
                frames_per_packet: format.frames_per_packet,
            })
            .session(session_id),
        )?;
    }

    // 채널이 열렸고 서버가 OPEN 까지 보냈는지.
    let ready = mic_channel.ready();

    loop {
        let chunk = match microphone.try_recv() {
            Ok(chunk) => chunk,
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
        };
        let Some(channel_id) = ready else {
            // 렌더러는 보내는데 채널이 안 열렸다. 조용히 버리면 원인을 가릴 수 없다.
            if *mic_sent == 0 {
                *mic_sent = u64::MAX;
                warn!(
                    session_id,
                    bytes = chunk.len(),
                    "microphone audio arrived before AUDIO_INPUT was open; dropping"
                );
            }
            continue;
        };
        let chunk_len = chunk.len();
        let messages = ironrdp_dvc::encode_dvc_messages(
            channel_id,
            crate::audio_input::AudinClient::encode_data(chunk),
            ironrdp_svc::ChannelFlags::empty(),
        )
        .map_err(|error| anyhow::anyhow!("{error}"))?;
        let encoded = active_stage
            .encode_dvc_messages(messages)
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        let bytes = chunk_len;
        framed.write_all(&encoded).context("send microphone audio")?;
        // MAX 는 위에서 "열리기 전에 버렸다" 를 한 번 남기려고 쓴 표시다. 실제로 보내기 시작하면
        // 처음부터 센다.
        if *mic_sent == u64::MAX {
            *mic_sent = 0;
        }
        *mic_sent += 1;
        if *mic_sent == 1 || *mic_sent % 100 == 0 {
            debug!(session_id, chunks = *mic_sent, bytes, "microphone audio sent");
        }
    }
    Ok(())
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
    if let Err(error) = validate_framebuffer_size(width, height) {
        warn!(width, height, %error, "dropping oversized desktop resize request");
        *pending = None;
        return Ok(());
    }

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

/// 실제로 받은 데스크톱 크기에 대해 각 모니터가 차지할 사각형을 정한다.
///
/// 서버가 요청한 크기를 그대로 주지 않을 수 있다. 그럴 때 우리가 계산한 배치는 무의미하므로,
/// 크기가 어긋나면 단일 화면으로 되돌린다 — 어긋난 배치로 화면을 나누면 조용히 깨진다.
fn resolve_placements(
    session_id: &str,
    desktop_width: u16,
    desktop_height: u16,
    layout: &MonitorLayout,
) -> Vec<MonitorPlacement> {
    if desktop_width == layout.desktop_width && desktop_height == layout.desktop_height {
        return layout.placements.clone();
    }

    warn!(
        session_id,
        requested_width = layout.desktop_width,
        requested_height = layout.desktop_height,
        granted_width = desktop_width,
        granted_height = desktop_height,
        "server did not grant the requested layout; falling back to a single screen"
    );
    vec![MonitorPlacement {
        index: 0,
        left: 0,
        top: 0,
        width: desktop_width,
        height: desktop_height,
    }]
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

impl MonitorLayout {
    /// 선언 내용이 같은 배치인지. 같은 배치를 다시 보내면 서버가 재활성화만 한 번 더 한다.
    fn same_as(&self, other: &MonitorLayout) -> bool {
        self.desktop_width == other.desktop_width
            && self.desktop_height == other.desktop_height
            && self.declared.len() == other.declared.len()
            && self.declared.iter().zip(&other.declared).all(|(a, b)| {
                a.left == b.left
                    && a.top == b.top
                    && a.right == b.right
                    && a.bottom == b.bottom
                    && a.flags == b.flags
            })
    }
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
    validate_framebuffer_size(desktop_width, desktop_height)
        .context("virtual desktop framebuffer")?;

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
        admin_session: payload.admin_session,
        enable_graphics_pipeline: allow_egfx,
        // 32bit(기본)에서는 None 을 그대로 둔다. None 이어도 커넥터가 기본 코덱(RemoteFX 포함)을
        // 광고하는데, Some 으로 바꾸면 그 목록이 우리가 준 것으로 **대체**된다. classic bitmap
        // 강제는 재연결마다 서버 갱신이 최대 1초 가까이 멎는 결과가 나와 사용하지 않는다.
        //
        // 16bit 을 고른 경우에만 채운다. 코덱 목록은 기본과 같게 넘겨 위 성질을 유지한다.
        bitmap: match payload.color_depth {
            Some(16) => Some(connector::BitmapConfig {
                color_depth: 16,
                lossy_compression: false,
                codecs: ironrdp_pdu::rdp::capability_sets::client_codecs_capabilities(&[])
                    .expect("empty codec config never fails"),
            }),
            _ => None,
        },
        client_build: 0,
        client_name: "dolgate".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),

        #[cfg(target_os = "windows")]
        platform: MajorPlatformType::WINDOWS,
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        platform: MajorPlatformType::MACINTOSH,
        #[cfg(any(target_os = "linux", target_os = "android"))]
        platform: MajorPlatformType::UNIX,

        // **서버 포인터는 받지 않는다.**
        //
        // 켜 봤지만 모바일에서는 소용이 없었다. IronRDP 는 서버가 `SetDefault`(= 클라이언트의
        // 기본 커서를 써라)를 보내면 합성 커서를 숨기는데(fast_path.rs 의 `hide_pointer`),
        // 윈도우 바탕화면 위 포인터가 바로 그 기본 화살표다. 그리고 `show_pointer` 는
        // `pub(crate)` 라 우리가 되켤 수 없다 — 폰에는 그릴 시스템 커서가 없으니 그대로 사라진다.
        //
        // 그래서 모바일 커서는 앱이 직접 그린다(RemoteDesktopSurface 의 트랙패드 커서).
        // 여기서 합성까지 켜면 커스텀 모양일 때 커서가 두 개로 보인다.
        enable_server_pointer: false,
        request_data: None,
        autologon: false,
        // 이게 false 면 커넥터가 ClientInfoFlags::NO_AUDIO_PLAYBACK 를 세워(connection.rs:929)
        // "오디오를 받지 않는다"고 선언한다. RDPSND 채널을 붙여도 소리가 흐르지 않는다.
        //
        // 소리를 끈 세션에서는 이걸 내려 서버가 애초에 보내지 않게 한다 — 채널만 안 붙이면
        // 서버는 계속 인코딩해서 보내고 우리가 버리는 꼴이 된다.
        enable_audio_playback: payload.audio,
        // 마이크를 쓸 세션만 선언한다. 이 플래그가 서버가 AUDIO_INPUT 을 여는 방아쇠다 —
        // 채널만 등록해 두면 서버는 시작하지 않고, 원격에 마이크가 나타나지 않는다.
        enable_audio_capture: payload.microphone,
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
    // 실제로 TCP 를 열 주소. None 이면 server_name/port 로 붙는다.
    //
    // server_name 은 여기서도 TLS 서버 이름·인증서 핀 키로 계속 쓰인다 — 주소와 신원을
    // 분리하는 것이 이 인자의 목적이다.
    dial_address: Option<String>,
    // Secret preface expected by the Go mobile loopback tunnel.
    tunnel_auth_token: Option<String>,
    session_id: &str,
    request_id: &str,
    output: &Output,
    trust: &Receiver<bool>,
    // None 이면 그 채널을 붙이지 않는다. 정적 채널이라 접속 시점에만 결정할 수 있다.
    clipboard_backend: Option<TextClipboardBackend>,
    audio_backend: Option<AudioBackend>,
    // 동적 채널로 오는 소리를 받을 백엔드를 만드는 공장. 정적 채널과 같은 세션으로 흘러 나간다.
    // 채널이 닫히고 다시 열릴 수 있어서 하나가 아니라 공장을 받는다.
    mut make_dvc_audio_backend: crate::audio::AudioBackendFactory,
    // 마이크를 쓸 세션이면 협상 사양을 돌려보낼 채널. None 이면 AUDIO_INPUT 을 아예 붙이지 않는다.
    mic_format_tx: Option<std::sync::mpsc::Sender<crate::audio_input::CaptureFormat>>,
    // 마이크 채널의 상태를 펌프와 나눠 갖는 핸들.
    mic_channel: &Arc<crate::audio_input::AudinChannel>,
    // 카메라를 쓸 세션이면 채널 상태와 신호 보낼 곳. None 이면 rdpecam 채널을 붙이지 않는다.
    camera: Option<(Arc<crate::camera::CameraChannel>, std::sync::mpsc::Sender<crate::camera::CameraSignal>)>,
    drives: Vec<crate::drive::DriveShareConfig>,
    // allow_egfx: 그래픽 파이프라인을 쓸지. 앞선 시도가 이 채널로 화면을 못 그렸으면 끄고 다시
    // 붙는다. trusted_fingerprint: 이미 승인된 인증서 지문. 같으면 다시 묻지 않는다.
    allow_egfx: bool,
    trusted_fingerprint: &mut Option<String>,
    // 취소 전파용. 소켓을 잡는 즉시 사본을 넣어 둔다(CancelSocket 주석 참고).
    stop: &AtomicBool,
    cancel_socket: &CancelSocket,
) -> anyhow::Result<(
    ConnectionResult,
    UpgradedFramed,
    crate::egfx_surface::EgfxSurfaceHandle,
    crate::egfx::EgfxUnusable,
)> {
    let server_addr = match dial_address.as_deref() {
        Some(address) => resolve_dial_address(address, port).context("lookup dial address")?,
        None => lookup_addr(&server_name, port).context("lookup addr")?,
    };

    // 어디로 붙는지 남긴다.
    //
    // tailnet 을 거치는 호스트는 ssh-core 가 열어 준 로컬 포워드(127.0.0.1)로 붙어야 한다. 그
    // 주소가 안 넘어오면 조용히 원래 주소로 직접 붙어 타임아웃이 나는데, 로그만 보면 왜 그런지
    // 알 수 없다 — 이 줄이 그것을 가른다.
    info!(
        session_id,
        server_name = %server_name,
        port,
        dial_address = dial_address.as_deref().unwrap_or("-"),
        target = %server_addr,
        "dialing"
    );

    let mut tcp_stream = dial(server_addr, stop).context("TCP connect")?;
    tcp_stream
        .set_read_timeout(Some(HANDSHAKE_READ_TIMEOUT))
        .context("set handshake read timeout")?;
    if tunnel_auth_token.is_some() {
        tcp_stream
            .set_write_timeout(Some(HANDSHAKE_READ_TIMEOUT))
            .context("set tunnel authentication write timeout")?;
        core_framing::write_rd_tunnel_auth_preface(
            &mut tcp_stream,
            tunnel_auth_token.as_deref(),
        )
        .context("authenticate local remote desktop tunnel")?;
        tcp_stream
            .set_write_timeout(None)
            .context("clear tunnel authentication write timeout")?;
    }

    // **소켓 사본을 취소 슬롯에 넣는다.** 이때부터 disconnect 가 이 소켓을 shutdown 할 수 있고,
    // 핸드셰이크 중이던 블로킹 읽기가 즉시 돌아온다(CancelSocket 주석 참고).
    if let Ok(clone) = tcp_stream.try_clone() {
        if let Ok(mut slot) = cancel_socket.lock() {
            *slot = Some(clone);
        }
    }
    // 사본을 넣기 전에 취소가 왔을 수 있다. 여기서 한 번 더 본다.
    anyhow::ensure!(!stop.load(Ordering::Relaxed), Cancelled);

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
    let dynamic_channels = DrdynvcClient::new()
        .with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new())));

    // **소리는 동적 채널(AUDIO_PLAYBACK_DVC)도 받는다.**
    //
    // 예전에는 거절했다 — 받아 주면 서버가 소리를 그리로 돌리고 아무것도 보내지 않는 것으로
    // 보였기 때문이다. 그 관찰은 반쪽이었다: 채널만 열고 형식 목록을 보내지 않으면 서버는 기다린다
    // (audio_output_dvc.rs 가 그 협상을 한다).
    //
    // 거절의 대가가 컸다. 최신 윈도우는 재생·녹음을 한 오디오 엔드포인트로 다루므로, 이 채널
    // 개설이 계속 실패하면 그 엔드포인트가 올라오지 않는다 — 실측(EC2 Windows): 서버가 네 번
    // 재시도하는 동안 rdpsnd 로 소리가 한 조각도 안 왔고, 원격 녹음기는 "녹음 장치 없음" 이었으며
    // AUDIO_INPUT 도 열리지 않았다. 소리를 끈 세션에서는 붙이지 않는다.
    //
    // **개설 요청마다 새 처리기를 만드는 리스너로 붙인다.** 서버가 이 채널을 닫고 다시 열기
    // 때문이다(audio_output_dvc.rs 의 `AudioOutputDvcListener` 주석에 실측이 있다).
    let dynamic_channels = if audio_backend.is_some() {
        dynamic_channels.with_listener(crate::audio_output_dvc::AudioOutputDvcListener::new(
            move || Box::new(make_dvc_audio_backend()) as Box<dyn ironrdp_rdpsnd::client::RdpsndClientHandler>,
        ))
    } else {
        dynamic_channels
    };
    let dynamic_channels = if allow_egfx {
        dynamic_channels.with_dynamic_channel(graphics_pipeline)
    } else {
        dynamic_channels
    };
    // 마이크는 동적 채널(AUDIO_INPUT)이다. 끈 세션에서는 붙이지 않는다 — 붙여 두면 서버가
    // 협상을 시작하고, 우리가 아무것도 보내지 않으면 그쪽은 마이크가 죽은 것으로 본다.
    let dynamic_channels = match mic_format_tx {
        Some(mic_format_tx) => {
            info!("audin: registering the AUDIO_INPUT channel and declaring INFO_AUDIOCAPTURE");
            dynamic_channels.with_listener(crate::audio_input::AudinListener::new(
                mic_format_tx,
                Arc::clone(mic_channel),
            ))
        }
        None => dynamic_channels,
    };

    // 카메라(MS-RDPECAM)는 채널이 둘이다 — 제어 채널에서 카메라를 알리고, 서버가 우리가 알려
    // 준 이름으로 장치 채널을 연다. 끈 세션에서는 둘 다 붙이지 않는다.
    let dynamic_channels = match camera {
        Some((camera_channel, camera_signals)) => {
            info!(
                channel = crate::camera::DEVICE_CHANNEL_NAME,
                "rdpecam: registering the camera channels"
            );
            dynamic_channels
                .with_listener(crate::camera::CameraEnumeratorListener)
                .with_listener(crate::camera::CameraDeviceListener::new(
                    camera_channel,
                    camera_signals,
                ))
        }
        None => dynamic_channels,
    };

    let mut connector = connector::ClientConnector::new(config, client_addr)
        .with_static_channel(dynamic_channels)
        .with_static_channel(crate::drive::build_rdpdr("dolgate".to_owned(), drives));

    // CLIPRDR / RDPSND 는 정적 채널이라 접속 시점에 붙여야 한다. 나중에 켤 수 없고, 끈 세션은
    // 아예 붙이지 않는다 — 채널을 붙여 두고 버리면 서버가 계속 보낸다.
    if let Some(clipboard_backend) = clipboard_backend {
        connector = connector.with_static_channel(CliprdrClient::new(Box::new(clipboard_backend)));
    }
    if let Some(audio_backend) = audio_backend {
        connector = connector.with_static_channel(Rdpsnd::new(Box::new(audio_backend)));
    }

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

/// `host:port` 문자열을 소켓 주소로 바꾼다.
///
/// tailnet 경유의 로컬 포워드 주소를 받는 자리다. 포트가 없으면 거절한다 — 기본 포트를 붙여
/// 추측하면 엉뚱한 곳으로 붙는다.
/// TCP 를 잡되, 그 사이에 취소가 오면 기다리지 않고 돌아온다.
///
/// **소켓을 잡기 전에는 끊을 소켓이 없다.** `CancelSocket` 은 잡은 뒤부터만 쓸 수 있어서, dial
/// 자체는 다른 방법으로 중단해야 한다 — 붙는 일을 스레드에 맡기고 이쪽에서 `stop` 을 본다.
/// 취소되면 그 스레드는 혼자 끝나고(최대 `DIAL_TIMEOUT`) 잡은 소켓이 있으면 그대로 닫힌다.
fn dial(addr: core::net::SocketAddr, stop: &AtomicBool) -> anyhow::Result<TcpStream> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // 받는 쪽이 이미 포기했으면(취소) 보낼 곳이 없다. 그건 오류가 아니다.
        let _ = tx.send(TcpStream::connect_timeout(&addr, DIAL_TIMEOUT));
    });
    await_dial(&rx, stop)
}

/// dial 결과를 기다리며 취소를 지켜본다. 분리해 둔 이유는 이 대기 규칙을 테스트하기 위해서다.
fn await_dial(
    rx: &std::sync::mpsc::Receiver<std::io::Result<TcpStream>>,
    stop: &AtomicBool,
) -> anyhow::Result<TcpStream> {
    loop {
        match rx.recv_timeout(DIAL_POLL) {
            Ok(result) => return result.map_err(anyhow::Error::from),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                anyhow::ensure!(!stop.load(Ordering::Relaxed), Cancelled);
            }
            // 붙는 스레드가 결과 없이 사라졌다. 일어날 일이 아니지만 조용히 매달려 있으면 안 된다.
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                anyhow::bail!("the dial thread ended without a result")
            }
        }
    }
}

fn resolve_dial_address(address: &str, port: u16) -> anyhow::Result<core::net::SocketAddr> {
    use std::net::ToSocketAddrs as _;
    (address, port)
        .to_socket_addrs()
        .with_context(|| format!("resolve {address}:{port}"))?
        .next()
        .context("socket address not found")
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
    let builder = rustls::client::ClientConfig::builder();
    let signature_algorithms = rustls::crypto::CryptoProvider::get_default()
        .context("rustls crypto provider is not installed")?
        .signature_verification_algorithms;
    let mut config = builder
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(
            danger::NoCertificateVerification::new(signature_algorithms),
        ))
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
    use tokio_rustls::rustls::client::danger::{
        HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
    };
    use tokio_rustls::rustls::crypto::{
        verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms,
    };
    use tokio_rustls::rustls::{DigitallySignedStruct, Error, SignatureScheme, pki_types};

    /// Skips CA/name validation so the caller can apply TOFU, but still proves that the peer owns
    /// the private key for the certificate it presented. TLS handshake signatures are never part
    /// of the TOFU exception.
    #[derive(Debug)]
    pub(super) struct NoCertificateVerification {
        supported: WebPkiSupportedAlgorithms,
    }

    impl NoCertificateVerification {
        pub(super) fn new(supported: WebPkiSupportedAlgorithms) -> Self {
            Self { supported }
        }
    }

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
            message: &[u8],
            cert: &pki_types::CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            verify_tls12_signature(message, cert, dss, &self.supported)
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &pki_types::CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            verify_tls13_signature(message, cert, dss, &self.supported)
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.supported.supported_schemes()
        }
    }
}

#[cfg(test)]
mod tls_signature_tests {
    use super::tls_upgrade;
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio_rustls::rustls;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    use rustls::server::{ClientHello, ResolvesServerCert};
    use rustls::sign::CertifiedKey;

    const CERT_DER_BASE64: &str = concat!(
        "MIIBfDCCASOgAwIBAgIUChBw6sYz2eueY3jYP0HgJwtOpeswCgYIKoZIzj0EAwIw",
        "FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgyMTE0MTEzNFoXDTM2MDgxODE0",
        "MTEzNFowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D",
        "AQcDQgAEMeo/fpE8ntXC34qf09DN9bQoT0EU7aTOewVBfByT2sYZP4iKeZVNWUVe",
        "0QQ8vvLDy6wi+jh4JSgdhzDWZSEzeKNTMFEwHQYDVR0OBBYEFNmGO2DXzgnPsnEj",
        "bsGtiFdTU4V4MB8GA1UdIwQYMBaAFNmGO2DXzgnPsnEjbsGtiFdTU4V4MA8GA1Ud",
        "EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIgX/oKgpVsRota+mHEbXrePAih",
        "J/GkZUgSK5Or+x/SCxgCIEL3ujSjHLefeIyz8gcf5Jq4HIc44/5tFHH5wB9SVzAi",
    );
    const WRONG_KEY_DER_BASE64: &str = concat!(
        "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQglkyNjD3Ch30PdBT9",
        "SHD347q7E1dn6NOgfcIyPZg2/RqhRANCAAQVP1GPBpj3GROUoIIJsSBIo5oejmEp",
        "AeEI6ARIU5PDVYRDZ5Eluhtc6L2RYjrX01Dihro1NWIkN/UzSiteOYpa",
    );

    fn decode_base64(encoded: &str) -> Vec<u8> {
        let mut decoded = Vec::with_capacity(encoded.len() * 3 / 4);
        let mut accumulator = 0_u32;
        let mut bits = 0_u8;
        for byte in encoded.bytes() {
            let value = match byte {
                b'A'..=b'Z' => byte - b'A',
                b'a'..=b'z' => byte - b'a' + 26,
                b'0'..=b'9' => byte - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' => break,
                _ => panic!("invalid base64 fixture"),
            };
            accumulator = (accumulator << 6) | u32::from(value);
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                decoded.push((accumulator >> bits) as u8);
                accumulator &= (1_u32 << bits) - 1;
            }
        }
        decoded
    }

    #[derive(Debug)]
    struct MismatchedResolver {
        certified_key: Arc<CertifiedKey>,
    }

    impl ResolvesServerCert for MismatchedResolver {
        fn resolve(&self, _: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
            Some(Arc::clone(&self.certified_key))
        }
    }

    fn mismatched_server_config() -> Arc<rustls::ServerConfig> {
        // builder() installs the process-default crypto provider when one has not been set yet.
        let builder = rustls::ServerConfig::builder();
        let provider = rustls::crypto::CryptoProvider::get_default()
            .expect("rustls default crypto provider");
        let private_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(decode_base64(
            WRONG_KEY_DER_BASE64,
        )));
        let signing_key = provider
            .key_provider
            .load_private_key(private_key)
            .expect("load mismatched test key");
        let certified_key = Arc::new(CertifiedKey::new(
            vec![CertificateDer::from(decode_base64(CERT_DER_BASE64))],
            signing_key,
        ));
        assert!(
            certified_key.keys_match().is_err(),
            "the fixture must keep the certificate and private key unrelated"
        );

        Arc::new(
            builder
                .with_no_client_auth()
                .with_cert_resolver(Arc::new(MismatchedResolver { certified_key })),
        )
    }

    #[test]
    fn rejects_a_peer_that_signs_with_a_key_other_than_its_certificate_key() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind TLS test server");
        let address = listener.local_addr().expect("TLS test address");
        let server_config = mismatched_server_config();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept TLS client");
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("server read timeout");
            socket
                .set_write_timeout(Some(Duration::from_secs(5)))
                .expect("server write timeout");
            let mut connection =
                rustls::ServerConnection::new(server_config).expect("TLS server connection");
            while connection.is_handshaking() {
                if connection.complete_io(&mut socket).is_err() {
                    break;
                }
            }
        });

        let stream = std::net::TcpStream::connect(address).expect("connect TLS test server");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("client read timeout");
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .expect("client write timeout");
        let error = match tls_upgrade(stream, "localhost".to_owned()) {
            Ok(_) => panic!("a mismatched TLS CertificateVerify signature must be rejected"),
            Err(error) => error,
        };
        let message = format!("{error:#}").to_ascii_lowercase();
        assert!(
            message.contains("signature"),
            "the handshake must fail on certificate signature verification: {message}"
        );

        server.join().expect("TLS test server");
    }
}

/// 관리 세션 요청(`mstsc /admin`)이 커넥터까지 전달되는지.
///
/// 와이어 표현(GCC 클러스터 블록의 플래그 조합)은 단위 테스트로 증명할 수 없다 — 서버가 그것을
/// 어떻게 해석하는지가 본질이라 실기기 대조가 필요하다. 여기서는 값이 조용히 떨어지지 않는지만
/// 잠근다.
#[cfg(test)]
mod cancel_tests {
    use super::{CancelSocket, HANDSHAKE_READ_TIMEOUT};
    use std::io::Read;
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// **취소가 "전파된다" 는 것은 이 동작이다.** 연결 단계에서 스레드는 핸드셰이크 읽기에 갇혀
    /// 있고, `stop` 플래그는 아무도 보지 않는다(그 읽기는 크레이트 안에서 일어난다). 소켓을
    /// 끊어야 그 읽기가 즉시 돌아온다 — 그러지 못하면 사용자가 탭을 닫아도 30초 뒤에 timeout
    /// 오류가 뒤늦게 올라온다.
    #[test]
    fn shutting_down_the_socket_unblocks_a_blocked_handshake_read() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        // 응답하지 않는 서버. 우리가 끊으면 이쪽 읽기도 돌아와 스레드가 끝난다.
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            let mut sink = [0_u8; 1];
            let _ = socket.read(&mut sink);
        });

        let stream = TcpStream::connect(addr).expect("connect");
        stream
            .set_read_timeout(Some(HANDSHAKE_READ_TIMEOUT))
            .expect("read timeout");
        let cancel: CancelSocket =
            Arc::new(std::sync::Mutex::new(Some(stream.try_clone().expect("clone"))));

        let canceller = std::thread::spawn({
            let cancel = Arc::clone(&cancel);
            move || {
                std::thread::sleep(Duration::from_millis(50));
                let slot = cancel.lock().expect("cancel slot");
                slot.as_ref().expect("socket").shutdown(Shutdown::Both).expect("shutdown");
            }
        });

        let started = Instant::now();
        let mut byte = [0_u8; 1];
        let read = (&stream).read(&mut byte);

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "취소가 읽기를 깨우지 못했다 — {HANDSHAKE_READ_TIMEOUT:?} 를 기다린 셈이다"
        );
        assert!(
            matches!(read, Ok(0) | Err(_)),
            "끊긴 소켓의 읽기는 끝나야 한다: {read:?}"
        );

        canceller.join().expect("canceller");
        server.join().expect("server");
    }

    /// **소켓을 잡기 전에 닫으면 끊을 소켓이 없다.** 그 구간의 취소는 dial 결과를 기다리는 쪽이
    /// 처리한다 — 붙는 스레드가 끝나기를 기다리지 않고 돌아와야 한다. 여기서는 결과가 영영 오지
    /// 않는 채널로 그 상황을 만든다(닿지 않는 주소에 실제로 붙어 보면 결과가 네트워크에 달려
    /// 테스트가 흔들린다).
    #[test]
    fn a_cancelled_dial_returns_without_waiting_for_the_connect() {
        let (tx, rx) = std::sync::mpsc::channel::<std::io::Result<TcpStream>>();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let canceller = std::thread::spawn({
            let stop = Arc::clone(&stop);
            move || {
                std::thread::sleep(Duration::from_millis(50));
                stop.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        });

        let started = Instant::now();
        let result = super::await_dial(&rx, &stop);

        assert!(result.is_err(), "취소됐으면 소켓을 돌려줄 수 없다");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "취소를 보고 바로 돌아와야 한다 — {:?} 를 기다린 셈이다",
            super::DIAL_TIMEOUT
        );

        canceller.join().expect("canceller");
        // 보내는 쪽을 여기서 놓는다. 위 대기가 Disconnected 로 끝나지 않았음을 보장하려고 붙잡아 뒀다.
        drop(tx);
    }
}

#[cfg(test)]
mod admin_session_tests {
    use super::build_config;
    use crate::protocol::{ConnectPayload, MonitorRequest};

    fn payload(admin_session: bool) -> ConnectPayload {
        ConnectPayload {
            host: "host".to_owned(),
            port: 3389,
            username: "user".to_owned(),
            password: String::new(),
            domain: None,
            microphone: false,
            camera: false,
            monitors: vec![MonitorRequest {
                width: 1920,
                height: 1080,
                left: 0,
                top: 0,
                primary: true,
            }],
            audio: true,
            clipboard: true,
            color_depth: None,
            dial_address: None,
            tunnel_auth_token: None,
            admin_session,
            drives: Vec::new(),
        }
    }

    #[test]
    fn reaches_the_connector_config() {
        let config = build_config(true, &payload(true), 1920, 1080, Vec::new());
        assert!(config.admin_session);
    }

    #[test]
    fn stays_off_unless_asked() {
        let config = build_config(true, &payload(false), 1920, 1080, Vec::new());
        assert!(
            !config.admin_session,
            "켜지 않았는데 관리 세션으로 붙으면 안 된다"
        );
    }

    #[test]
    fn an_older_request_without_the_field_is_a_normal_session() {
        // 이 필드를 모르는 요청(옛 데스크톱 빌드)이 와도 지금까지와 같이 동작해야 한다.
        let parsed: ConnectPayload = serde_json::from_value(serde_json::json!({
            "host": "host",
            "username": "user",
            "monitors": [{ "width": 1920, "height": 1080 }],
        }))
        .expect("payload");
        assert!(!parsed.admin_session);
    }

    #[test]
    fn reads_the_field_from_the_request() {
        let parsed: ConnectPayload = serde_json::from_value(serde_json::json!({
            "host": "host",
            "username": "user",
            "monitors": [{ "width": 1920, "height": 1080 }],
            "adminSession": true,
        }))
        .expect("payload");
        assert!(parsed.admin_session, "camelCase 로 읽어야 한다");
    }
}

/// 오디오·클립보드·색 깊이 옵션이 커넥터 설정과 채널 부착에 반영되는지.
#[cfg(test)]
mod session_option_tests {
    use super::build_config;
    use crate::protocol::{ConnectPayload, MonitorRequest};

    fn payload(json: serde_json::Value) -> ConnectPayload {
        let mut base = serde_json::json!({
            "host": "host",
            "username": "user",
            "monitors": [{ "width": 1920, "height": 1080, "primary": true }],
        });
        let (serde_json::Value::Object(base_map), serde_json::Value::Object(extra)) =
            (&mut base, json)
        else {
            panic!("both must be objects");
        };
        base_map.extend(extra);
        serde_json::from_value(base).expect("payload")
    }

    #[test]
    fn audio_and_clipboard_default_to_on() {
        // 이 필드를 모르는 옛 요청이 와도 소리와 클립보드가 살아 있어야 한다.
        let parsed = payload(serde_json::json!({}));
        assert!(parsed.audio);
        assert!(parsed.clipboard);
    }

    /// 커서가 보이려면 **두 플래그가 함께** 켜져 있어야 한다.
    ///
    /// IronRDP 는 `enable_server_pointer` 가 false 면 포인터 업데이트를 처리 첫 줄에서 버리고
    /// `pointer_software_rendering` 을 평가하지도 않는다. 한때 앞쪽이 false 여서 모바일 RDP 에
    /// 커서가 전혀 그려지지 않았다 — 한쪽만 보는 단정으로는 그 상태를 잡지 못한다.
    /// **서버 포인터를 켜지 않는다.**
    ///
    /// 한 번 켜 봤지만 모바일에서는 소용이 없었다 — IronRDP 는 `SetDefault` 를 받으면 합성
    /// 커서를 숨기고(`hide_pointer`), 윈도우 바탕화면의 포인터가 바로 그 기본 화살표다.
    /// `show_pointer` 는 `pub(crate)` 라 되켤 수도 없다. 켜 두면 커스텀 모양일 때만 서버 커서가
    /// 나타나 앱이 그리는 커서와 둘이 보인다.
    #[test]
    fn does_not_take_the_server_pointer() {
        let config = build_config(true, &payload(serde_json::json!({})), 1920, 1080, Vec::new());
        assert!(!config.enable_server_pointer);
    }

    #[test]
    fn audio_off_is_declared_to_the_server() {
        // 채널만 안 붙이면 서버는 계속 인코딩해 보낸다. 선언까지 내려야 안 보낸다.
        let off = build_config(true, &payload(serde_json::json!({ "audio": false })), 1920, 1080, Vec::new());
        assert!(!off.enable_audio_playback);

        let on = build_config(true, &payload(serde_json::json!({})), 1920, 1080, Vec::new());
        assert!(on.enable_audio_playback);
    }

    /// 마이크 리디렉션은 **선언이 방아쇠다.** 채널을 붙여도 이 플래그가 없으면 서버가 열지 않아
    /// 원격의 장치 목록에 마이크가 나타나지 않는다(실측).
    #[test]
    fn declares_audio_capture_only_when_the_microphone_is_on() {
        let off = build_config(
            true,
            &payload(serde_json::json!({})),
            1920,
            1080,
            Vec::new(),
        );
        assert!(!off.enable_audio_capture, "기본은 꺼짐이어야 한다");

        let on = build_config(
            true,
            &payload(serde_json::json!({ "microphone": true })),
            1920,
            1080,
            Vec::new(),
        );
        assert!(on.enable_audio_capture);
    }

    #[test]
    fn keeps_the_logical_host_as_the_tls_identity() {
        // tailnet 경유일 때 접속은 127.0.0.1 로 하지만 신원은 논리 이름이어야 한다. 여기가
        // 섞이면 서로 다른 tailnet 호스트가 모두 같은 서버로 보이고 인증서 핀이 무의미해진다.
        let tunnel_auth_token = "ab".repeat(32);
        let parsed = payload(serde_json::json!({
            "host": "winbox.example.ts.net",
            "dialAddress": "127.0.0.1",
            "tunnelAuthToken": tunnel_auth_token.clone(),
        }));
        assert_eq!(parsed.dial_address.as_deref(), Some("127.0.0.1"));
        assert_eq!(
            parsed.tunnel_auth_token.as_deref(),
            Some(tunnel_auth_token.as_str())
        );
        assert_eq!(parsed.host, "winbox.example.ts.net");
    }

    #[test]
    fn resolves_a_local_forward_with_the_separate_port() {
        use super::resolve_dial_address;

        let addr = resolve_dial_address("127.0.0.1", 52341).expect("resolve");
        assert_eq!(addr.port(), 52341);
        assert!(addr.ip().is_loopback());
    }

    #[test]
    fn resolves_an_ipv6_host_without_string_concatenation() {
        use super::resolve_dial_address;

        let addr = resolve_dial_address("::1", 52342).expect("resolve");
        assert_eq!(addr.port(), 52342);
        assert!(addr.ip().is_loopback());
    }

    #[test]
    fn without_a_dial_address_nothing_changes() {
        let parsed = payload(serde_json::json!({}));
        assert!(parsed.dial_address.is_none());
    }

    #[test]
    fn thirty_two_bit_leaves_the_bitmap_config_untouched() {
        // 32bit 은 지금까지와 완전히 같은 경로여야 한다. Some 으로 바꾸면 코덱 목록이 우리가
        // 준 것으로 대체되어 RemoteFX 광고가 사라진다.
        for value in [serde_json::json!({}), serde_json::json!({ "colorDepth": 32 })] {
            let config = build_config(true, &payload(value), 1920, 1080, Vec::new());
            assert!(config.bitmap.is_none());
        }
    }

    #[test]
    fn sixteen_bit_keeps_the_default_codec_list() {
        let config = build_config(
            true,
            &payload(serde_json::json!({ "colorDepth": 16 })),
            1920,
            1080,
            Vec::new(),
        );
        let bitmap = config.bitmap.expect("16bit 은 설정을 채운다");
        assert_eq!(bitmap.color_depth, 16);
        assert!(!bitmap.lossy_compression);
        // 기본 목록과 같아야 한다 — 다르면 RemoteFX 를 잃는다.
        let expected =
            ironrdp_pdu::rdp::capability_sets::client_codecs_capabilities(&[]).expect("codecs");
        assert_eq!(bitmap.codecs.0.len(), expected.0.len());
    }
}

#[cfg(test)]
mod layout_tests {
    use super::{build_monitor_layout, validate_framebuffer_size};
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
    fn framebuffer_budget_accepts_the_limit_and_rejects_above_it() {
        assert!(validate_framebuffer_size(4096, 4096).is_ok());
        assert!(validate_framebuffer_size(4097, 4096).is_err());
        assert!(validate_framebuffer_size(0, 4096).is_err());
    }

    #[test]
    fn rejects_a_monitor_layout_above_the_framebuffer_budget() {
        let error = match build_monitor_layout(&[monitor(4097, 4096, 0, 0, true)]) {
            Ok(_) => panic!("layout must be rejected before connection"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("framebuffer"));
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

/// 배치 갱신(rdpSetLayout)이 규격에 맞는 PDU 항목으로 바뀌는지.
///
/// 여기서 어긋나면 서버가 요청 전체를 조용히 버린다 — 화면은 그냥 옛 크기로 남는다.
#[cfg(test)]
mod layout_entry_tests {
    use super::{build_monitor_layout, layout_entries, resolve_placements};
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
    fn keeps_order_sizes_and_the_primary_flag() {
        let layout = build_monitor_layout(&[
            monitor(2560, 1440, -2560, -428, false),
            monitor(1512, 949, 0, 33, true),
        ])
        .expect("layout");
        let entries = layout_entries("test", &layout).expect("entries");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].dimensions(), (2560, 1440));
        assert_eq!(entries[1].dimensions(), (1512, 949));
        assert!(!entries[0].is_primary());
        assert!(entries[1].is_primary(), "입력 순서가 유지된다");
        // 주 모니터가 원점이므로 보조는 그에 상대적이다.
        assert_eq!(entries[0].position(), Some((-2560, -461)));
    }

    #[test]
    fn corrects_an_odd_width() {
        // 폭이 홀수면 서버가 요청을 통째로 버린다([MS-RDPEDISP] 2.2.2.2.1).
        let layout = build_monitor_layout(&[monitor(1367, 768, 0, 0, true)]).expect("layout");
        let entries = layout_entries("test", &layout).expect("entries");
        assert_eq!(entries[0].dimensions(), (1366, 768));
    }

    #[test]
    fn clamps_sides_to_the_allowed_range() {
        let layout = build_monitor_layout(&[monitor(200, 200, 0, 0, true)]).expect("layout");
        let entries = layout_entries("test", &layout).expect("entries");
        assert_eq!(entries[0].dimensions(), (200, 200), "하한은 그대로 통과한다");
    }

    #[test]
    fn the_primary_monitor_sits_at_the_origin() {
        // 주 모니터가 (0,0) 이 아니면 PDU 생성 자체가 거부된다. build_monitor_layout 이 주
        // 모니터를 원점으로 옮기므로, 주 모니터가 오른쪽에 있어도 통과해야 한다.
        let layout = build_monitor_layout(&[
            monitor(1920, 1080, 0, 0, false),
            monitor(2560, 1440, 1920, 0, true),
        ])
        .expect("layout");
        let entries = layout_entries("test", &layout).expect("entries");
        assert_eq!(entries[1].position(), Some((0, 0)), "주 모니터는 원점이어야 한다");
        assert_eq!(entries[0].position(), Some((-1920, 0)));
    }

    #[test]
    fn keeps_the_layout_when_the_granted_size_matches() {
        let layout = build_monitor_layout(&[
            monitor(2560, 1440, 0, 0, true),
            monitor(1512, 949, 2560, 0, false),
        ])
        .expect("layout");
        let placements =
            resolve_placements("test", layout.desktop_width, layout.desktop_height, &layout);
        assert_eq!(placements.len(), 2);
        assert_eq!(placements[1].width, 1512);
        assert_eq!(placements[1].height, 949);
        assert_eq!(placements[1].left, 2560);
    }

    #[test]
    fn falls_back_to_one_screen_when_the_server_grants_another_size() {
        let layout = build_monitor_layout(&[
            monitor(2560, 1440, 0, 0, true),
            monitor(1512, 949, 2560, 0, false),
        ])
        .expect("layout");
        // 서버가 다른 크기를 주면 우리 배치는 무의미하다. 나눠 그리면 조용히 깨진다.
        let placements = resolve_placements("test", 1920, 1080, &layout);
        assert_eq!(placements.len(), 1);
        assert_eq!(placements[0].width, 1920);
        assert_eq!(placements[0].height, 1080);
    }

    #[test]
    fn normalizes_sizes_before_computing_the_framebuffer() {
        use super::normalize_layout_sizes;

        // 폭이 홀수인 화면(맥의 1707x1067 스케일 모드). PDU 는 짝수 폭만 받으므로 여기서 미리
        // 맞춰야 프레임버퍼 배치와 선언이 같은 크기가 된다 — 안 맞추면 서버가 1px 다른 데스크톱을
        // 주고, 우리가 그걸 "요청과 다르다"고 보아 배치를 통째로 포기한다.
        let layout = build_monitor_layout(&normalize_layout_sizes(&[
            monitor(1707, 1067, 0, 0, true),
            monitor(1367, 768, 1707, 0, false),
        ]))
        .expect("layout");

        assert_eq!(layout.placements[0].width, 1706);
        assert_eq!(layout.placements[1].width, 1366);
        // 위치는 화면에서 잰 좌표라 보정과 무관하다. 그래서 짝수로 줄어든 1px 만큼 원격 배치에
        // 빈 열이 남는데, 프레임버퍼와 선언이 **같은** 크기로 계산되기만 하면 문제가 없다
        // (그 열은 그려지지 않는다). 어긋나는 쪽이 배치를 포기하게 만드는 원인이다.
        assert_eq!(layout.desktop_width, 1707 + 1366);

        let entries = layout_entries("test", &layout).expect("entries");
        assert_eq!(entries[0].dimensions(), (1706, 1067));
        assert_eq!(
            entries[1].position(),
            Some((1707, 0)),
            "위치는 잰 좌표 그대로다"
        );
    }

    #[test]
    fn treats_an_identical_layout_as_unchanged() {
        // 같은 배치를 다시 보내면 서버가 재활성화만 한 번 더 한다(화면이 멎는다).
        let monitors = [
            monitor(2560, 1440, 0, 0, true),
            monitor(1512, 949, 2560, 0, false),
        ];
        let a = build_monitor_layout(&monitors).expect("layout");
        let b = build_monitor_layout(&monitors).expect("layout");
        assert!(a.same_as(&b));

        let changed = build_monitor_layout(&[
            monitor(2560, 1440, 0, 0, true),
            monitor(1512, 982, 2560, 0, false),
        ])
        .expect("layout");
        assert!(!a.same_as(&changed), "높이가 달라지면 다시 보내야 한다");
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
