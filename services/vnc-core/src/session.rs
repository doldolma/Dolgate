//! 한 VNC 세션. 소켓 하나, 프레임버퍼 하나, 스레드 하나.
//!
//! **통로는 세션 스레드가 혼자 갖고, 입력은 큐로 받는다.** RFB 는 한 연결 위에서 양방향이고 읽기
//! 스레드는 대개 FramebufferUpdate 를 기다리며 막혀 있다. 예전에는 쓰기용으로 소켓을 복제해 입력
//! 스레드가 직접 썼는데, VeNCrypt 를 켜면 통로가 `SslStream` 이 되고 **그것은 복제할 수 없다** —
//! TLS 상태가 하나뿐이라 읽기/쓰기가 같은 객체를 써야 한다.
//!
//! 그래서 읽기에 짧은 시간 제한을 걸고, 그 틈에 입력 큐를 비운다. 입력 지연은 그 제한 이하이고
//! (네트워크 왕복보다 짧다), 평문과 TLS 가 같은 코드를 쓴다.
//!
//! **갱신은 요청 기반이다.** 서버는 우리가 `FramebufferUpdateRequest` 를 보낸 만큼만 보낸다.
//! 한 갱신을 다 처리한 뒤에 다음 요청을 보내는 것이 규격의 흐름이고, 그것을 어기면 둘 중 하나가
//! 된다 — 요청을 안 보내 화면이 멈추거나, 매번 여러 개를 보내 같은 영역이 중복으로 온다.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context as _, Result};
use tracing::{debug, warn};

use crate::auth;
use crate::decode::{Framebuffer, Rect};
use crate::zrle::ZlibStream;
use crate::output::Output;
use crate::protocol::{
    ConnectPayload, ConnectedPayload, EmptyPayload, ErrorPayload, Event, FramePayload, InputEvent,
    ResizedPayload,
};
use crate::rfb::{self, encoding, PixelFormat, SecurityType};
use crate::tls;
use crate::transport::{is_idle_timeout, Transport};
use crate::vencrypt;

/// TCP 연결 제한. 닿지 않는 주소에서 무한정 기다리지 않는다.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// 협상 단계의 읽기 제한.
///
/// 이 구간은 주고받는 순서가 정해져 있어 오래 걸릴 이유가 없다. 응답이 없으면 붙지 않는 것이다.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// 메시지를 기다리는 동안의 읽기 제한.
///
/// 이 값이 곧 입력 지연의 상한이다 — 읽기가 이 시간마다 풀리면서 입력 큐를 비운다. 네트워크 왕복
/// 보다 짧게 두면 사용자는 차이를 느끼지 못한다.
const IDLE_POLL: Duration = Duration::from_millis(20);

/// 메시지 **본문**을 읽는 동안의 제한.
///
/// 본문 중간에 시간이 끊기면 이미 읽은 바이트가 사라져 프레임 경계가 깨진다. 그래서 종류 한
/// 바이트를 읽은 뒤에는 넉넉히 잡는다.
const BODY_TIMEOUT: Duration = Duration::from_secs(60);

/// 세션 밖에서 세션을 다루는 손잡이. 통로를 직접 쥐지 않는다.
#[derive(Clone)]
pub struct SessionHandle {
    /// 입력은 큐로 보낸다. 세션 스레드가 읽기 틈에 비운다.
    input: Sender<Vec<InputEvent>>,
    closed: Arc<AtomicBool>,
    /// 끊기 전용 소켓 복제본. TLS 상태와 무관하게 읽기에서 막힌 스레드를 깨운다.
    shutdown: Arc<Mutex<Option<TcpStream>>>,
}

#[derive(Debug, Default, Clone, Copy)]
struct PointerState {
    button_mask: u8,
    x: u16,
    y: u16,
}

impl SessionHandle {
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // 읽기 스레드는 통로에서 막혀 있다. 바탕 소켓을 닫아 그 자리에서 풀어 준다.
        if let Ok(socket) = self.shutdown.lock() {
            if let Some(socket) = socket.as_ref() {
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }
        }
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// 입력 묶음을 세션 스레드로 넘긴다.
    ///
    /// 여기서 소켓에 쓰지 않는다 — TLS 통로는 세션 스레드가 혼자 갖고 있다. 세션이 이미 끝났으면
    /// 조용히 버린다(탭을 닫는 순간에도 입력이 몇 개 뒤늦게 도착한다).
    pub fn send_input(&self, events: &[InputEvent]) -> io::Result<()> {
        if self.is_closed() || events.is_empty() {
            return Ok(());
        }
        let _ = self.input.send(events.to_vec());
        Ok(())
    }
}

/// 큐에 쌓인 입력을 통로로 내보낸다.
///
/// 포인터 상태를 여기서 들고 있는다 — RFB 의 PointerEvent 는 버튼 마스크와 위치를 매번 함께 보내는
/// 상태 기반 메시지라, 버튼을 누른 채 움직이면 그 버튼이 마스크에 남아 있어야 한다.
fn drain_input(
    transport: &mut Transport,
    pointer: &mut PointerState,
    queue: &Receiver<Vec<InputEvent>>,
) -> Result<()> {
    loop {
        let batch = match queue.try_recv() {
            Ok(batch) => batch,
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => return Ok(()),
        };
        for event in batch {
            match event {
                InputEvent::MouseMove { x, y } => {
                    pointer.x = x;
                    pointer.y = y;
                    rfb::write_pointer_event(transport, pointer.button_mask, x, y)?;
                }
                InputEvent::MouseButton {
                    button,
                    pressed,
                    x,
                    y,
                } => {
                    let bit = match button {
                        0 => 0b0000_0001,
                        1 => 0b0000_0010,
                        2 => 0b0000_0100,
                        // 모르는 버튼은 무시한다. 마스크에 엉뚱한 비트를 세우면 서버가 그 버튼을
                        // 계속 눌린 것으로 본다.
                        _ => continue,
                    };
                    if pressed {
                        pointer.button_mask |= bit;
                    } else {
                        pointer.button_mask &= !bit;
                    }
                    pointer.x = x;
                    pointer.y = y;
                    rfb::write_pointer_event(transport, pointer.button_mask, x, y)?;
                }
                InputEvent::Wheel {
                    vertical,
                    delta,
                    x,
                    y,
                } => {
                    if delta == 0 {
                        continue;
                    }
                    // RFB 에는 휠 메시지가 없다. 버튼 4~7 을 눌렀다 떼는 것으로 표현한다
                    // (4=위, 5=아래, 6=왼쪽, 7=오른쪽).
                    let bit = match (vertical, delta > 0) {
                        (true, true) => 0b0000_1000,
                        (true, false) => 0b0001_0000,
                        (false, false) => 0b0010_0000,
                        (false, true) => 0b0100_0000,
                    };
                    pointer.x = x;
                    pointer.y = y;
                    rfb::write_pointer_event(transport, pointer.button_mask | bit, x, y)?;
                    rfb::write_pointer_event(transport, pointer.button_mask, x, y)?;
                }
                InputEvent::Key { keysym, pressed } => {
                    rfb::write_key_event(transport, keysym, pressed)?;
                }
            }
        }
    }
}

/// 세션을 열고 화면이 끝날 때까지 돈다.
///
/// **어디서 실패해도 이벤트를 하나 남긴다.** 안쪽을 따로 둔 이유가 그것이다 — 협상·인증 단계에서
/// `?` 로 바로 반환하면 오류 보고를 지나쳐 데스크톱에 아무것도 도달하지 않는다. 그러면 탭이
/// 이유 없이 사라지고, 비밀번호가 틀렸는지 주소가 닿지 않는지 알 방법이 없다.
pub fn run(
    session_id: String,
    request_id: String,
    payload: ConnectPayload,
    output: Output,
    register: impl FnOnce(SessionHandle),
) -> Result<()> {
    match connect_and_run(&session_id, &request_id, payload, &output, register) {
        Ok(()) => {
            output.send_event(&Event::new("closed", EmptyPayload {}).session(&session_id))?;
            Ok(())
        }
        Err(error) => {
            output.send_event(
                &Event::new(
                    "error",
                    ErrorPayload {
                        message: format!("{error:#}"),
                    },
                )
                .session(&session_id),
            )?;
            Err(error)
        }
    }
}

fn connect_and_run(
    session_id: &str,
    request_id: &str,
    payload: ConnectPayload,
    output: &Output,
    register: impl FnOnce(SessionHandle),
) -> Result<()> {
    let address = format!("{}:{}", payload.host, payload.port);
    let socket = connect(&address).with_context(|| format!("{address} 에 연결할 수 없습니다"))?;
    socket.set_nodelay(true).ok();
    socket.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).ok();

    let (input_tx, input_rx) = channel::<Vec<InputEvent>>();
    let handle = SessionHandle {
        input: input_tx,
        closed: Arc::new(AtomicBool::new(false)),
        shutdown: Arc::new(Mutex::new(socket.try_clone().ok())),
    };

    let mut transport = Transport::Plain(socket);
    let version = rfb::negotiate_version(&mut transport).context("RFB 버전 협상")?;
    debug!(?version, "RFB 버전 협상 완료");

    let offered = rfb::read_security_types(&mut transport, version).context("보안 타입 협상")?;
    // 인증이 통로를 바꿔 돌려준다 — VeNCrypt 는 여기서 TLS 를 세우고 그 안에서 다시 인증한다.
    transport = authenticate(transport, version, &offered, &payload, &handle)?;

    rfb::write_client_init(&mut transport, payload.shared).context("ClientInit")?;
    let init = rfb::read_server_init(&mut transport).context("ServerInit")?;

    // 서버가 처음 알린 포맷을 남긴다. 규격상 SetPixelFormat 이후에는 우리 포맷을 써야 하지만,
    // 그것을 무시하는 서버가 있고 확인 응답이 없어 와이어로는 알 수 없다 — 화면이 이상할 때
    // 이 줄이 유일한 단서다.
    debug!(?init.pixel_format, width = init.width, height = init.height, name = %init.name, "ServerInit");

    // 우리 캔버스와 같은 바이트 순서를 요구한다. 서버가 받아들이면 디코더가 변환 없이 지나간다.
    let format = PixelFormat::rgba32();
    rfb::write_set_pixel_format(&mut transport, format).context("SetPixelFormat")?;
    // 순서가 곧 선호도다(앞이 더 좋다). CopyRect 는 스크롤을 거의 공짜로 만들고, ZRLE 는 화면
    // 한 장을 Raw 의 몇십 분의 일로 줄인다 — Raw 만 쓰면 1280x1024 한 장이 5MB 다.
    rfb::write_set_encodings(
        &mut transport,
        &[
            encoding::COPY_RECT,
            encoding::ZRLE,
            encoding::RAW,
            encoding::DESKTOP_SIZE,
        ],
    )
    .context("SetEncodings")?;

    debug!(
        tls = transport.is_tls(),
        width = init.width,
        height = init.height,
        "세션 준비 완료"
    );
    output.send_event(
        &Event::new(
            "connected",
            ConnectedPayload {
                desktop_width: init.width,
                desktop_height: init.height,
                name: init.name.clone(),
            },
        )
        .session(session_id)
        .request(request_id),
    )?;

    register(handle.clone());

    let mut framebuffer = Framebuffer::new(init.width, init.height);
    // **세션당 하나다.** ZRLE 의 zlib 사전이 사각형을 넘어 이어지므로 여기서 살아 있어야 한다.
    let mut zlib = ZlibStream::new();
    // 첫 요청은 증분이 아니다 — 아직 아무것도 못 받았으므로 전체를 받아야 한다.
    request_full_update(&mut transport, &framebuffer)?;

    let result = pump(
        &mut transport,
        &handle,
        &input_rx,
        &mut framebuffer,
        &mut zlib,
        format,
        session_id,
        output,
    );

    // 어떻게 끝나든 소켓을 닫는다. 남겨 두면 서버 쪽에 세션이 살아 있는 것으로 남는다.
    handle.close();
    result
}

fn connect(address: &str) -> Result<TcpStream> {
    // to_socket_addrs 로 후보를 모두 시도한다. IPv6 만 응답하는 호스트가 있고, 첫 후보에서
    // 멈추면 그런 대상에 닿지 못한다.
    use std::net::ToSocketAddrs as _;
    let mut last: Option<io::Error> = None;
    for candidate in address.to_socket_addrs()? {
        match TcpStream::connect_timeout(&candidate, CONNECT_TIMEOUT) {
            Ok(socket) => return Ok(socket),
            Err(error) => last = Some(error),
        }
    }
    match last {
        Some(error) => Err(error.into()),
        None => bail!("주소를 찾을 수 없습니다"),
    }
}

/// 서버가 제시한 보안 타입 중 우리가 할 수 있는 것을 고른다.
///
/// 고를 수 없으면 **무엇을 요구했는지 문구에 담는다.** "붙지 않는다" 만 말하면 사용자는 다음에
/// 무엇을 해야 할지 알 수 없다 — RealVNC 독자 인증인지, TLS 를 켜야 하는지, 비밀번호가 없는지가
/// 여기서 갈린다.
fn authenticate(
    mut transport: Transport,
    version: rfb::Version,
    offered: &[SecurityType],
    payload: &ConnectPayload,
    handle: &SessionHandle,
) -> Result<Transport> {
    let password = payload.password.as_str();
    // 비밀번호가 있으면 VncAuth 를 먼저 고른다. None 이 함께 제시되는 서버에서 비밀번호를 넣은
    // 사용자의 의도는 인증을 쓰겠다는 것이다.
    let chosen = if offered.contains(&SecurityType::VncAuth) && !password.is_empty() {
        SecurityType::VncAuth
    } else if offered.contains(&SecurityType::None) {
        SecurityType::None
    } else if offered.contains(&SecurityType::VncAuth) {
        SecurityType::VncAuth
    } else if offered.contains(&SecurityType::VeNCrypt) {
        SecurityType::VeNCrypt
    } else {
        bail!(describe_unsupported(offered));
    };

    if version.negotiates_security_list() {
        transport.write_all(&[chosen.to_u8()])?;
        transport.flush()?;
    }

    match chosen {
        SecurityType::VncAuth => {
            vnc_auth(&mut transport, version, password)?;
        }
        SecurityType::None => {
            if version.sends_security_result_for_none() {
                rfb::read_security_result(&mut transport, version)?;
            }
        }
        SecurityType::VeNCrypt => {
            transport = vencrypt_authenticate(transport, version, payload, handle)?;
        }
        other => bail!(describe_unsupported(&[other])),
    }
    Ok(transport)
}

/// VncAuth 챌린지 응답. TLS 안에서도 같은 절차라 따로 빼 둔다.
fn vnc_auth(
    transport: &mut Transport,
    version: rfb::Version,
    password: &str,
) -> Result<()> {
    if password.is_empty() {
        bail!("이 서버는 비밀번호를 요구합니다");
    }
    let mut challenge = [0_u8; auth::CHALLENGE_LEN];
    transport.read_exact(&mut challenge)?;
    let response = auth::respond_to_challenge(password, &challenge);
    transport.write_all(&response)?;
    transport.flush()?;
    rfb::read_security_result(transport, version).map_err(|error| {
        // 서버는 왜 틀렸는지 말하지 않는다. 8자 절단이 실제로 가장 흔한 원인이라 그것을 알려 준다.
        if password.len() > 8 {
            anyhow::anyhow!("{error} (비밀번호가 8자를 넘습니다 — VNC 는 앞 8자만 사용합니다)")
        } else {
            error.into()
        }
    })?;
    Ok(())
}

/// VeNCrypt: 서브타입을 고르고 TLS 를 세운 뒤 그 안에서 다시 인증한다.
///
/// 돌려주는 통로는 **TLS 안쪽**이다. 이후 모든 RFB 트래픽이 그 안으로 들어간다.
fn vencrypt_authenticate(
    transport: Transport,
    version: rfb::Version,
    payload: &ConnectPayload,
    handle: &SessionHandle,
) -> Result<Transport> {
    let mut transport = transport;
    let offered = vencrypt::negotiate(&mut transport).context("VeNCrypt 협상")?;
    debug!(?offered, "VeNCrypt 서브타입");

    // 인증서 기반을 먼저 고른다 — 익명 DH 는 중간자를 구분할 방법이 원리적으로 없다.
    let chosen = pick_vencrypt_subtype(&offered, &payload.password)
        .ok_or_else(|| anyhow::anyhow!(vencrypt::describe_unsupported(&offered)))?;
    vencrypt::select(&mut transport, chosen)?;

    // 통로를 TLS 로 감싼다. 여기서 바탕 소켓만 꺼내 쓰고, 끊기용 복제본은 그대로 유효하다.
    let socket = match transport {
        Transport::Plain(socket) => socket,
        // VeNCrypt 안에서 다시 VeNCrypt 가 나오는 경우는 규격에 없다.
        Transport::Tls(_) => bail!("VeNCrypt 협상이 이미 TLS 위에서 일어났습니다"),
    };
    let mut secured = if chosen.is_certificate_tls() {
        let (session, fingerprint) = tls::connect_with_certificate(socket, &payload.host)?;
        // TODO 로 남기지 않고 사실을 적는다: 지문 고정은 호출부(데스크톱)가 판정해야 한다. 지금은
        // 지문을 진단으로 남기고 통과시킨다 — 이 경로를 쓰는 서버가 아직 실측되지 않았다.
        debug!(%fingerprint, "X509 VeNCrypt 인증서 지문");
        Transport::Tls(Box::new(session))
    } else {
        Transport::Tls(Box::new(tls::connect_anonymous(socket, &payload.host)?))
    };
    // 끊기용 복제본을 새 통로의 소켓으로 갈아 준다(TLS 가 소켓을 옮겨 갖는다).
    if let Ok(mut slot) = handle.shutdown.lock() {
        *slot = secured.clone_for_shutdown().ok();
    }

    // TLS 안에서 서브타입이 정한 인증을 이어서 한다.
    match chosen {
        vencrypt::SubType::TlsNone | vencrypt::SubType::X509None => {
            rfb::read_security_result(&mut secured, version)?;
        }
        vencrypt::SubType::TlsVnc | vencrypt::SubType::X509Vnc => {
            vnc_auth(&mut secured, version, &payload.password)?;
        }
        other => bail!(vencrypt::describe_unsupported(&[other])),
    }
    Ok(secured)
}

/// 우리가 세울 수 있는 서브타입 중 가장 나은 것.
///
/// 인증서 기반을 먼저 고른다. 익명 DH 는 도청은 막지만 상대가 누구인지 보장하지 않으므로, 같은
/// 서버가 둘 다 제시하면 인증서 쪽이 낫다.
fn pick_vencrypt_subtype(
    offered: &[vencrypt::SubType],
    password: &str,
) -> Option<vencrypt::SubType> {
    let has = |subtype: vencrypt::SubType| offered.contains(&subtype);
    let with_password = !password.is_empty();
    if with_password && has(vencrypt::SubType::X509Vnc) {
        return Some(vencrypt::SubType::X509Vnc);
    }
    if has(vencrypt::SubType::X509None) {
        return Some(vencrypt::SubType::X509None);
    }
    if has(vencrypt::SubType::X509Vnc) {
        return Some(vencrypt::SubType::X509Vnc);
    }
    if with_password && has(vencrypt::SubType::TlsVnc) {
        return Some(vencrypt::SubType::TlsVnc);
    }
    if has(vencrypt::SubType::TlsNone) {
        return Some(vencrypt::SubType::TlsNone);
    }
    if has(vencrypt::SubType::TlsVnc) {
        return Some(vencrypt::SubType::TlsVnc);
    }
    None
}

fn describe_unsupported(offered: &[SecurityType]) -> String {
    let mut names: Vec<String> = Vec::new();
    for kind in offered {
        names.push(match kind {
            SecurityType::VeNCrypt => "VeNCrypt(TLS)".to_owned(),
            SecurityType::AppleRemoteDesktop => "macOS 화면 공유 인증".to_owned(),
            SecurityType::Invalid => "invalid".to_owned(),
            SecurityType::None => "none".to_owned(),
            SecurityType::VncAuth => "VNC 비밀번호".to_owned(),
            SecurityType::Unsupported(value) => format!("알 수 없는 방식({value})"),
        });
    }
    format!(
        "이 서버가 요구하는 인증 방식을 아직 지원하지 않습니다: {}",
        names.join(", ")
    )
}

fn request_full_update(transport: &mut Transport, framebuffer: &Framebuffer) -> Result<()> {
    rfb::write_framebuffer_update_request(
        transport,
        false,
        0,
        0,
        framebuffer.width(),
        framebuffer.height(),
    )?;
    Ok(())
}

fn request_incremental_update(transport: &mut Transport, framebuffer: &Framebuffer) -> Result<()> {
    rfb::write_framebuffer_update_request(
        transport,
        true,
        0,
        0,
        framebuffer.width(),
        framebuffer.height(),
    )?;
    Ok(())
}

/// 서버 메시지를 세션이 끝날 때까지 처리한다.
fn pump(
    transport: &mut Transport,
    handle: &SessionHandle,
    input: &Receiver<Vec<InputEvent>>,
    framebuffer: &mut Framebuffer,
    zlib: &mut ZlibStream,
    format: PixelFormat,
    session_id: &str,
    output: &Output,
) -> Result<()> {
    let mut pointer = PointerState::default();
    loop {
        if handle.is_closed() {
            return Ok(());
        }

        // 종류 한 바이트를 짧은 제한으로 기다린다. 그 틈이 곧 입력을 내보내는 자리다.
        transport.set_read_timeout(Some(IDLE_POLL)).ok();
        let mut kind = [0_u8; 1];
        let read = match transport.read(&mut kind) {
            Ok(read) => read,
            Err(error) if is_idle_timeout(&error) => {
                drain_input(transport, &mut pointer, input)?;
                continue;
            }
            // 서버가 정상적으로 끊은 경우다(사용자가 원격에서 세션을 닫는 등).
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) if handle.is_closed() => {
                debug!(%error, "세션을 닫는 중 읽기가 끝났다");
                return Ok(());
            }
            Err(error) => return Err(error.into()),
        };
        if read == 0 {
            // 상대가 통로를 닫았다.
            return Ok(());
        }

        // 본문은 중간에 끊기면 프레임 경계가 깨진다. 넉넉한 제한으로 바꿔 읽는다.
        transport.set_read_timeout(Some(BODY_TIMEOUT)).ok();

        match kind[0] {
            rfb::server_message::FRAMEBUFFER_UPDATE => {
                let resized = handle_framebuffer_update(
                    transport,
                    framebuffer,
                    zlib,
                    format,
                    session_id,
                    output,
                )?;
                if let Some((width, height)) = resized {
                    output.send_event(
                        &Event::new(
                            "resized",
                            ResizedPayload {
                                desktop_width: width,
                                desktop_height: height,
                            },
                        )
                        .session(session_id),
                    )?;
                    // 크기가 바뀌면 이전 화면은 전부 무효다. 증분으로 요청하면 서버는 "바뀐 것이
                    // 없다" 고 보고 아무것도 보내지 않아 화면이 빈 채로 남는다.
                    request_full_update(transport, framebuffer)?;
                } else {
                    request_incremental_update(transport, framebuffer)?;
                }
                // 갱신 하나를 처리한 뒤에 입력을 내보낸다 — 화면이 바쁠 때도 입력이 밀리지 않는다.
                drain_input(transport, &mut pointer, input)?;
            }
            rfb::server_message::BELL => {
                // 소리는 내지 않는다. 원격 벨을 로컬 알림으로 바꾸는 것은 사용자가 원할 때 할 일이다.
                debug!("서버 벨");
            }
            rfb::server_message::SERVER_CUT_TEXT => {
                let text = read_server_cut_text(transport)?;
                // 클립보드 연결은 4단계다. 지금은 읽어서 버려야 한다 — 남겨 두면 다음 메시지
                // 경계가 어긋난다.
                debug!(len = text.len(), "서버 클립보드(아직 전달하지 않는다)");
            }
            rfb::server_message::SET_COLOUR_MAP_ENTRIES => {
                read_and_discard_colour_map(transport)?;
            }
            other => {
                // 모르는 메시지는 길이를 알 수 없어 스트림을 다시 맞출 방법이 없다. 여기서 끊는
                // 편이 깨진 화면을 계속 그리는 것보다 낫다.
                bail!("서버가 알 수 없는 메시지({other})를 보냈습니다");
            }
        }
    }
}

/// 한 FramebufferUpdate 를 처리한다. 크기가 바뀌었으면 새 크기를 돌려준다.
fn handle_framebuffer_update(
    stream: &mut Transport,
    framebuffer: &mut Framebuffer,
    zlib: &mut ZlibStream,
    format: PixelFormat,
    session_id: &str,
    output: &Output,
) -> Result<Option<(u16, u16)>> {
    let mut head = [0_u8; 3];
    stream.read_exact(&mut head)?;
    let rectangles = u16::from_be_bytes([head[1], head[2]]);

    // 인코딩별 계수와 와이어 바이트를 남긴다.
    //
    // 이게 없으면 "ZRLE 를 요청했는데 서버가 실제로 보내고 있는가" 를 확인할 방법이 없다. 우리가
    // 내보내는 프레임은 이미 RGBA 로 풀려 있어 크기가 늘 같기 때문이다 — 대역폭 개선을 눈으로
    // 확인할 수 있는 유일한 자리가 여기다.
    let mut counts = UpdateCounts::default();
    let mut resized = None;
    for _ in 0..rectangles {
        let mut header = [0_u8; 12];
        stream.read_exact(&mut header)?;
        let rect = Rect {
            x: u16::from_be_bytes([header[0], header[1]]),
            y: u16::from_be_bytes([header[2], header[3]]),
            width: u16::from_be_bytes([header[4], header[5]]),
            height: u16::from_be_bytes([header[6], header[7]]),
        };
        let encoding_kind =
            i32::from_be_bytes([header[8], header[9], header[10], header[11]]);

        match encoding_kind {
            encoding::RAW => {
                let mut data =
                    vec![0_u8; usize::from(rect.width) * usize::from(rect.height) * format.bytes_per_pixel()];
                stream.read_exact(&mut data)?;
                counts.raw += 1;
                counts.wire_bytes += data.len();
                framebuffer.apply_raw(rect, format, &data)?;
                send_rect(framebuffer, rect, session_id, output)?;
            }
            encoding::COPY_RECT => {
                let mut source = [0_u8; 4];
                stream.read_exact(&mut source)?;
                counts.copy_rect += 1;
                counts.wire_bytes += source.len();
                framebuffer.apply_copy_rect(
                    rect,
                    u16::from_be_bytes([source[0], source[1]]),
                    u16::from_be_bytes([source[2], source[3]]),
                )?;
                send_rect(framebuffer, rect, session_id, output)?;
            }
            encoding::ZRLE => {
                // u32 길이 + zlib 데이터. 길이는 압축된 크기다.
                let mut length = [0_u8; 4];
                stream.read_exact(&mut length)?;
                let length = u32::from_be_bytes(length) as usize;
                // 서버를 신뢰하지 않는다. 화면 한 장보다 큰 조각은 규격상 나올 수 없다.
                if length > 64 * 1024 * 1024 {
                    bail!("ZRLE 조각 길이가 비정상입니다({length})");
                }
                let mut compressed = vec![0_u8; length];
                stream.read_exact(&mut compressed)?;
                counts.zrle += 1;
                counts.wire_bytes += compressed.len();
                let plain = zlib.inflate(&compressed)?;
                crate::zrle::apply(framebuffer, rect, format, plain)?;
                send_rect(framebuffer, rect, session_id, output)?;
            }
            encoding::DESKTOP_SIZE => {
                // 의사 인코딩이다. 픽셀이 따라오지 않고 사각형의 크기가 새 화면 크기다.
                framebuffer.resize(rect.width, rect.height);
                resized = Some((rect.width, rect.height));
            }
            #[allow(unreachable_patterns)]
            other => {
                // 우리가 요청하지 않은 인코딩이다. 데이터 길이를 모르므로 건너뛸 수 없다.
                bail!("요청하지 않은 인코딩({other})이 도착했습니다");
            }
        }
    }
    debug!(
        rects = rectangles,
        raw = counts.raw,
        zrle = counts.zrle,
        copy_rect = counts.copy_rect,
        wire_kib = counts.wire_bytes / 1024,
        "framebuffer update"
    );
    Ok(resized)
}

/// 한 갱신에서 인코딩이 어떻게 쓰였는지.
#[derive(Debug, Default)]
struct UpdateCounts {
    raw: usize,
    zrle: usize,
    copy_rect: usize,
    wire_bytes: usize,
}

fn send_rect(
    framebuffer: &Framebuffer,
    rect: Rect,
    session_id: &str,
    output: &Output,
) -> Result<()> {
    let Some(pixels) = framebuffer.extract(rect) else {
        warn!(
            x = rect.x,
            y = rect.y,
            width = rect.width,
            height = rect.height,
            "화면 밖 사각형을 보내지 않는다"
        );
        return Ok(());
    };
    output.send_frame(
        &FramePayload {
            kind: "vncFrame",
            session_id: session_id.to_owned(),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        },
        &pixels,
    )?;
    Ok(())
}

fn read_server_cut_text(stream: &mut Transport) -> Result<String> {
    let mut head = [0_u8; 7];
    stream.read_exact(&mut head)?;
    let length = u32::from_be_bytes([head[3], head[4], head[5], head[6]]);
    if length > 4 * 1024 * 1024 {
        bail!("서버 클립보드 길이가 비정상입니다({length})");
    }
    let mut text = vec![0_u8; length as usize];
    stream.read_exact(&mut text)?;
    // RFB 의 기본 클립보드는 latin-1 이다. UTF-8 확장은 4단계에서 다룬다.
    Ok(text.iter().map(|byte| char::from(*byte)).collect())
}

fn read_and_discard_colour_map(stream: &mut Transport) -> Result<()> {
    let mut head = [0_u8; 5];
    stream.read_exact(&mut head)?;
    let count = u16::from_be_bytes([head[3], head[4]]);
    // 항목마다 RGB 각 2바이트다. 트루컬러를 요구했으므로 정상 경로에서는 오지 않지만, 오면
    // 읽어서 버려야 다음 메시지 경계가 맞는다.
    let mut entries = vec![0_u8; usize::from(count) * 6];
    stream.read_exact(&mut entries)?;
    debug!(count, "컬러맵을 무시한다(트루컬러를 요구했다)");
    Ok(())
}
