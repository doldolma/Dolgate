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
use std::time::{Duration, Instant};

use anyhow::{bail, Context as _, Result};
use tracing::{debug, trace, warn};

use crate::ard;
use crate::auth;
use crate::clipboard;
use crate::cursor;
use crate::decode::{Framebuffer, Rect};
use crate::zrle::ZlibStream;
use crate::output::Output;
use crate::protocol::{
    CapabilitiesPayload, ClipboardLossyPayload, ClipboardPayload, ConnectPayload,
    ConnectedPayload, CursorPayload, EmptyPayload, ErrorPayload, Event, FramePayload, InputEvent,
    ResizedPayload,
};
use crate::rfb::{self, encoding, PixelFormat, SecurityType};
use crate::tight;
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

/// 화면 갱신 통계를 로그로 남기는 간격.
///
/// 갱신마다 남기면 초당 수십 줄이라 다른 로그를 읽을 수 없다. 사람이 보기에는 몇 초에 한 번이면
/// 충분하다 — 인코딩이 바뀌었는지, 대역폭이 얼마인지는 그 간격으로도 드러난다.
const UPDATE_ROLLUP_INTERVAL: Duration = Duration::from_secs(5);

/// 세션 밖에서 세션을 다루는 손잡이. 통로를 직접 쥐지 않는다.
#[derive(Clone)]
pub struct SessionHandle {
    /// 세션 스레드로 보낼 것들. 읽기 틈에 비운다.
    ///
    /// **입력과 클립보드가 한 큐를 쓴다.** 큐를 둘로 나누면 "붙여넣기 전에 클립보드가 도착한다" 를
    /// 보장할 수 없다 — 순서가 뒤집히면 원격이 옛 클립보드를 붙여넣는다.
    outbound: Sender<Outbound>,
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
        let _ = self.outbound.send(Outbound::Input(events.to_vec()));
        Ok(())
    }

    /// 원격 화면 크기를 요청한다.
    ///
    /// 서버가 지원하지 않으면 세션 스레드가 조용히 버린다 — 여기서는 알 수 없다(협상 결과는 그쪽이
    /// 들고 있다). 실패도 오류가 아니다: 크기를 못 바꾸는 서버가 정상적으로 존재한다.
    pub fn request_desktop_size(&self, width: u16, height: u16) -> io::Result<()> {
        if self.is_closed() || width == 0 || height == 0 {
            return Ok(());
        }
        let _ = self
            .outbound
            .send(Outbound::DesktopSize { width, height });
        Ok(())
    }

    /// 로컬 클립보드를 원격에 알린다.
    ///
    /// 입력과 같은 큐를 쓰므로 순서가 보장된다 — 붙여넣기 키보다 늦게 도착하지 않는다.
    pub fn send_clipboard(&self, text: String) -> io::Result<()> {
        if self.is_closed() {
            return Ok(());
        }
        let _ = self.outbound.send(Outbound::Clipboard(text));
        Ok(())
    }

    /// 화면 전체를 다시 받는다. 그림을 잃은 쪽(캔버스)이 부른다.
    pub fn refresh_screen(&self) -> io::Result<()> {
        if self.is_closed() {
            return Ok(());
        }
        let _ = self.outbound.send(Outbound::Refresh);
        Ok(())
    }
}

/// 세션 스레드로 보낼 것. 순서를 지켜야 하는 것들이 한 큐에 들어간다.
enum Outbound {
    Input(Vec<InputEvent>),
    Clipboard(String),
    /// 원격 화면 크기 요청. 서버가 확장을 쓰는 것을 본 뒤에만 실제로 나간다.
    DesktopSize { width: u16, height: u16 },
    /// 화면 전체를 다시 보내 달라.
    ///
    /// **가진 그림을 잃은 쪽이 부른다.** 캔버스는 크기가 바뀌면 내용이 지워지는데, 그 리사이즈는
    /// 프레임 도착과 순서가 보장되지 않는다(React 상태를 거친다) — 그 사이에 온 프레임은 버려지고
    /// 서버는 정적인 영역을 다시 보내지 않으므로 그 자리가 검게 남는다. RFB 는 이 요청을 위해
    /// 비증분 갱신 요청을 두고 있다.
    Refresh,
}

/// 클립보드 협상 상태.
///
/// 확장은 상대가 caps 를 보낸 뒤에만 쓸 수 있다. 그 전에 사용자가 복사한 것은 `pending` 에 두고,
/// caps 가 오면 그때 보낸다 — 고전 경로로 먼저 보내면 한글이 `?` 로 굳어 버린다.
#[derive(Debug, Default)]
struct ClipboardState {
    /// 서버가 확장 텍스트를 지원한다고 알렸나.
    extended: bool,
    /// 우리 caps 를 이미 보냈나. 규격상 한 번이면 된다.
    sent_caps: bool,
    /// caps 를 기다리는 동안 보류한 텍스트(가장 최근 것 하나).
    pending: Option<String>,
    /// notify 로 알려 둔 텍스트. 상대가 request 하면 이것을 보낸다.
    offered: Option<String>,
    /// 고전 경로로 보내며 `?` 로 바꾼 글자 수. pump 가 읽어 알리고 0 으로 되돌린다.
    ///
    /// 여기서 세는 이유는 손실이 **보내는 순간**에만 알 수 있기 때문이다. 통로를 쥔 함수는
    /// 이벤트를 낼 수 없어서(출력은 pump 가 갖는다) 상태에 남겨 두고 넘긴다.
    lossy_chars: usize,
}

/// 서버가 `ExtendedDesktopSize` 를 쓰는지, 그리고 우리 요청에 실을 화면 id.
///
/// **증거를 보기 전에는 아무것도 보내지 않는다.** RFB 메시지에는 길이 필드가 없어서, 모르는
/// 메시지를 받은 서버는 그 바이트부터 해석이 어긋나 세션이 통째로 깨진다(복구 불가).
#[derive(Debug, Default, Clone, Copy)]
struct DesktopSizeState {
    supported: bool,
    screen_id: u32,
    /// 마지막으로 요청한 크기. 같은 값을 다시 보내면 서버가 화면을 또 재활성화한다.
    requested: Option<(u16, u16)>,
}

/// 연속 갱신 상태.
///
/// **증거를 보기 전에는 켜지 않는다.** 서버가 목록에서 의사 인코딩을 보면 `EndOfContinuousUpdates`
/// 를 한 번 보내는데, 규격은 그것을 지원 여부를 알리는 수단으로 정해 두었다. 그 전에 켜는 메시지를
/// 보내면 모르는 서버는 그 바이트부터 해석이 어긋난다.
#[derive(Debug, Default, Clone, Copy)]
struct ContinuousUpdates {
    supported: bool,
    enabled: bool,
    /// 켤 때 알린 영역. 화면 크기가 바뀌면 다시 알려야 한다.
    area: Option<(u16, u16)>,
}

/// 연속 갱신을 (다시) 켠다. 지원을 못 봤거나 이미 같은 영역으로 켜져 있으면 아무것도 하지 않는다.
fn enable_continuous_updates(
    transport: &mut Transport,
    state: &mut ContinuousUpdates,
    framebuffer: &Framebuffer,
) -> Result<()> {
    if !state.supported {
        return Ok(());
    }
    let area = (framebuffer.width(), framebuffer.height());
    if state.enabled && state.area == Some(area) {
        return Ok(());
    }
    rfb::write_enable_continuous_updates(transport, true, 0, 0, area.0, area.1)?;
    state.enabled = true;
    state.area = Some(area);
    debug!(width = area.0, height = area.1, "연속 갱신을 켰다");
    Ok(())
}

/// 큐에 쌓인 입력을 통로로 내보낸다.
///
/// 포인터 상태를 여기서 들고 있는다 — RFB 의 PointerEvent 는 버튼 마스크와 위치를 매번 함께 보내는
/// 상태 기반 메시지라, 버튼을 누른 채 움직이면 그 버튼이 마스크에 남아 있어야 한다.
fn drain_outbound(
    transport: &mut Transport,
    pointer: &mut PointerState,
    queue: &Receiver<Outbound>,
    desktop_size: &mut DesktopSizeState,
    clip: &mut ClipboardState,
    qemu_keys: bool,
    framebuffer: &Framebuffer,
) -> Result<()> {
    loop {
        let batch = match queue.try_recv() {
            Ok(Outbound::Input(batch)) => batch,
            Ok(Outbound::Clipboard(text)) => {
                // 확장을 아직 못 쓰는 상태면 **고전으로 지금 보내고**(영문은 즉시 동작한다) 같은
                // 텍스트를 보류해 둔다. caps 가 뒤늦게 오면 그때 UTF-8 로 한 번 더 보내 한글까지
                // 맞춘다 — 같은 내용이라 두 번 가도 해롭지 않다.
                if !clip.extended {
                    clip.pending = Some(text.clone());
                }
                clip.offered = Some(text.clone());
                send_clipboard_text(transport, clip, &text)?;
                continue;
            }
            Ok(Outbound::DesktopSize { width, height }) => {
                // 증거를 못 봤으면 보내지 않는다. 보내면 세션이 깨진다(위 주석 참고).
                if !desktop_size.supported {
                    debug!(width, height, "서버가 크기 변경을 지원하지 않아 요청을 버린다");
                    continue;
                }
                // 같은 크기를 다시 요청하면 서버가 화면을 또 재활성화해서 눈에 보이게 멈춘다.
                if desktop_size.requested == Some((width, height)) {
                    continue;
                }
                desktop_size.requested = Some((width, height));
                debug!(width, height, "원격 화면 크기를 요청한다");
                rfb::write_set_desktop_size(transport, width, height, desktop_size.screen_id)?;
                continue;
            }
            Ok(Outbound::Refresh) => {
                // 비증분 요청이다 — 서버가 그 영역을 전부 다시 보낸다. 연속 갱신이 켜져 있어도
                // 규격이 허용하고, 실제로 그렇게 동작한다(실측).
                debug!("화면 전체를 다시 요청한다");
                request_full_update(transport, framebuffer)?;
                continue;
            }
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
                InputEvent::Key {
                    keysym,
                    pressed,
                    keycode,
                } => {
                    // 스캔코드가 있고 서버가 확장을 쓰면 그쪽으로 보낸다. 둘 중 하나라도 없으면
                    // 고전 KeyEvent 다 — 증거 없이 확장 메시지를 보내면 스트림이 깨진다.
                    if qemu_keys && keycode != 0 {
                        rfb::write_qemu_key_event(transport, keysym, keycode, pressed)?;
                    } else {
                        rfb::write_key_event(transport, keysym, pressed)?;
                    }
                }
            }
        }
    }
}

/// 클립보드가 깎여 나갔으면 알린다.
///
/// **입력을 내보낸 자리마다 불러야 한다.** 세는 것은 보내는 함수가 하지만(그때만 알 수 있다) 알리는
/// 것은 출력을 가진 쪽이다. 루프 끝에서 한 번만 부르면 서버가 아무 메시지도 보내지 않는 동안에는
/// 보고가 나가지 않는다 — 클립보드는 서버 응답과 무관하게 우리가 보내는 것이라 그 상황이 흔하다.
fn report_clipboard_loss(
    clip: &mut ClipboardState,
    session_id: &str,
    output: &Output,
) -> Result<()> {
    if clip.lossy_chars == 0 {
        return Ok(());
    }
    let replaced = clip.lossy_chars;
    clip.lossy_chars = 0;
    debug!(replaced, "고전 클립보드로 보내며 담을 수 없는 글자를 바꿨다");
    output.send_event(
        &Event::new("clipboardLossy", ClipboardLossyPayload { replaced }).session(session_id),
    )?;
    Ok(())
}

/// 로컬 클립보드를 원격에 보낸다. 경로 선택이 여기 한 곳에 모여 있다.
///
/// - 확장이 되면 UTF-8 로 보낸다. 상대 한도를 넘는 것은 `notify` 로 알리고 요청을 기다린다
///   (요청 없이 큰 것을 밀어 넣으면 상대가 거부하거나 스트림이 막힌다).
/// - 확장이 아직이면 고전 경로로 보낸다 — 한글은 `?` 가 되지만 영문은 즉시 동작한다.
fn send_clipboard_text(
    transport: &mut Transport,
    clip: &mut ClipboardState,
    text: &str,
) -> Result<()> {
    if !clip.extended {
        clip.lossy_chars += rfb::count_latin1_losses(text);
        rfb::write_client_cut_text(transport, text)?;
        return Ok(());
    }
    if text.len() as u32 > clipboard::MAX_UNSOLICITED_TEXT {
        rfb::write_client_cut_text_extended(transport, &clipboard::encode_notify())?;
        return Ok(());
    }
    if let Some(body) = clipboard::encode_provide(text) {
        rfb::write_client_cut_text_extended(transport, &body)?;
    }
    Ok(())
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

    let (outbound_tx, outbound_rx) = channel::<Outbound>();
    let handle = SessionHandle {
        outbound: outbound_tx,
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
    // 목록은 rfb::CLIENT_ENCODINGS 하나뿐이다. 여기 인라인으로 두면 어떤 확장을 선언했는지
    // 테스트가 볼 수 없고, 실제로 그래서 확장 클립보드 선언이 빠진 것을 아무도 잡지 못했다.
    let quality = rfb::ImageQuality::from_name(&payload.image_quality);
    debug!(?quality, "화질 단계");
    rfb::write_set_encodings(&mut transport, &rfb::client_encodings(quality))
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
    // Tight 는 스트림이 **네 개**다. 사각형마다 어느 것을 쓸지 control 바이트가 정하고, 서버가
    // 초기화하라고 할 때만 새로 만든다 — 사각형마다 새로 만들면 두 번째부터 풀리지 않는다.
    let mut tight_streams = [
        ZlibStream::new(),
        ZlibStream::new(),
        ZlibStream::new(),
        ZlibStream::new(),
    ];
    // 첫 요청은 증분이 아니다 — 아직 아무것도 못 받았으므로 전체를 받아야 한다.
    request_full_update(&mut transport, &framebuffer)?;

    let result = pump(
        &mut transport,
        &handle,
        &outbound_rx,
        &mut framebuffer,
        &mut zlib,
        &mut tight_streams,
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
    let username = payload.username.as_str();
    // macOS 화면 공유는 계정+비밀번호를 함께 쓴다(ARD). 계정을 적었고 서버가 그것을 제시하면 그쪽이
    // 사용자의 의도다 — 같은 서버가 VncAuth 도 제시할 수 있지만 그건 8자로 잘리는 경로다.
    let chosen = if offered.contains(&SecurityType::AppleRemoteDesktop)
        && !username.is_empty()
        && !password.is_empty()
    {
        SecurityType::AppleRemoteDesktop
    }
    // 비밀번호가 있으면 VncAuth 를 먼저 고른다. None 이 함께 제시되는 서버에서 비밀번호를 넣은
    // 사용자의 의도는 인증을 쓰겠다는 것이다.
    else if offered.contains(&SecurityType::VncAuth) && !password.is_empty() {
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
        SecurityType::AppleRemoteDesktop => {
            apple_remote_desktop_auth(
                &mut transport,
                version,
                username,
                password,
                // 같은 서버가 VncAuth 도 제시했는지. 실패 문구에서 갈 길을 알려주는 데 쓴다.
                offered.contains(&SecurityType::VncAuth),
            )?;
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

/// ARD 인증(macOS 화면 공유).
///
/// DH 로 공유 비밀을 만들고 그 MD5 를 키로 계정·비밀번호를 함께 암호화해 보낸다(ard.rs). VncAuth
/// 와 달리 **계정이 필요하고 8자 제한이 없다.**
fn apple_remote_desktop_auth(
    transport: &mut Transport,
    version: rfb::Version,
    username: &str,
    password: &str,
    vnc_auth_also_offered: bool,
) -> Result<()> {
    if username.is_empty() {
        bail!("macOS 화면 공유는 계정이 필요합니다 — 자격증명에 계정을 입력하세요");
    }

    let mut head = [0_u8; 4];
    transport.read_exact(&mut head)?;
    let (generator, key_len) = ard::parse_header(head)?;

    // 모듈러스와 서버 공개키가 각각 key_len 바이트로 이어진다.
    let mut modulus = vec![0_u8; key_len];
    transport.read_exact(&mut modulus)?;
    let mut server_public = vec![0_u8; key_len];
    transport.read_exact(&mut server_public)?;
    debug!(generator, key_len, "ARD DH 매개변수");

    let response = ard::respond(
        &ard::ServerParams {
            generator,
            modulus,
            public_key: server_public,
        },
        username,
        password,
    )?;

    // 암호화된 자격증명 다음에 우리 공개키다. 순서를 바꾸면 서버가 128바이트를 공개키로 읽는다.
    transport.write_all(&response.credentials)?;
    transport.write_all(&response.public_key)?;
    transport.flush()?;

    rfb::read_security_result(transport, version).map_err(|error| {
        // ARD 는 계정도 틀릴 수 있으니 둘 다 짚어 준다.
        //
        // **macOS 에서 실제로 헷갈리는 자리다.** 화면 공유 설정에는 "VNC 뷰어 암호" 가 따로 있고,
        // 그것은 로그인 비밀번호와 다르다. 계정을 적으면 우리는 ARD(로그인 비밀번호)를 고르므로,
        // VNC 암호를 넣은 사용자는 왜 틀렸는지 알 수 없다 — 서버가 둘 다 제시했으면 그 길을 알려 준다.
        if vnc_auth_also_offered {
            anyhow::anyhow!(
                "{error} — 계정 기반 인증(ARD)은 이 컴퓨터의 **로그인 비밀번호**를 씁니다. \
                 별도로 설정한 VNC 암호로 붙으려면 자격증명의 계정을 비워 두세요"
            )
        } else {
            anyhow::anyhow!("{error} (계정 또는 비밀번호를 확인하세요)")
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
    let chosen = pick_vencrypt_subtype(&offered, &payload.password, &payload.username)
        .ok_or_else(|| anyhow::anyhow!(describe_vencrypt_refusal(&offered, &payload.username)))?;
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
        vencrypt::SubType::TlsPlain | vencrypt::SubType::X509Plain => {
            // 계정 기반 인증. 8자 제한이 없다 — 통로가 이미 TLS 라서 평문으로 보내도 된다.
            vencrypt::write_plain_credentials(
                &mut secured,
                &payload.username,
                &payload.password,
            )?;
            rfb::read_security_result(&mut secured, version).map_err(|error| {
                // 서버는 이유를 말하지 않는다. Plain 은 계정도 틀릴 수 있으니 둘 다 짚어 준다.
                anyhow::anyhow!("{error} (계정 또는 비밀번호를 확인하세요)")
            })?;
        }
        other => bail!(vencrypt::describe_unsupported(&[other])),
    }
    Ok(secured)
}

/// 고를 수 있는 것이 없을 때 사용자에게 보일 문구.
///
/// **거절 이유가 갈린다.** 계정이 필요한 방식만 제시된 경우와 우리가 아예 못 세우는 방식만 있는
/// 경우는 사용자가 할 일이 다르다 — 앞쪽은 계정 한 줄이면 붙고, 뒤쪽은 서버 설정을 바꿔야 한다.
/// 두 경우에 같은 문구를 내면 계정을 넣어야 하는 사용자가 서버 설정을 뒤진다(실제로 그랬다).
fn describe_vencrypt_refusal(offered: &[vencrypt::SubType], username: &str) -> String {
    let needs_account = username.is_empty()
        && offered.iter().any(|subtype| {
            matches!(
                subtype,
                vencrypt::SubType::TlsPlain | vencrypt::SubType::X509Plain
            )
        });
    if needs_account {
        return "이 서버는 계정 기반 인증(VeNCrypt Plain)을 요구합니다 — 자격증명에 계정을 \
                입력하세요"
            .to_owned();
    }
    vencrypt::describe_unsupported(offered)
}

/// 우리가 세울 수 있는 서브타입 중 가장 나은 것.
///
/// 인증서 기반을 먼저 고른다. 익명 DH 는 도청은 막지만 상대가 누구인지 보장하지 않으므로, 같은
/// 서버가 둘 다 제시하면 인증서 쪽이 낫다.
///
/// **계정이 있으면 Plain 계열을 먼저 본다.** 사용자가 계정을 적었다는 것은 그 방식으로 붙겠다는
/// 뜻이고, VncAuth 로는 그 계정을 쓸 수 없다(비밀번호만 있고 계정 개념이 없다). 계정이 없으면
/// 고르지 않는다 — 빈 계정을 보내면 서버가 거절하는데 그 실패가 비밀번호 오류와 구분되지 않는다.
///
/// 맨 `Plain`(256) 은 어떤 경우에도 고르지 않는다. 통로 암호화가 없어 비밀번호가 그대로 흘러간다.
fn pick_vencrypt_subtype(
    offered: &[vencrypt::SubType],
    password: &str,
    username: &str,
) -> Option<vencrypt::SubType> {
    let has = |subtype: vencrypt::SubType| offered.contains(&subtype);
    let with_password = !password.is_empty();
    let with_account = !username.is_empty();
    if with_account && has(vencrypt::SubType::X509Plain) {
        return Some(vencrypt::SubType::X509Plain);
    }
    if with_account && has(vencrypt::SubType::TlsPlain) {
        return Some(vencrypt::SubType::TlsPlain);
    }
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
            // 계정을 안 넣어서 이 방식을 못 고른 경우가 대부분이다 — 그 사실을 문구에 담는다.
            SecurityType::AppleRemoteDesktop => {
                "macOS 화면 공유 인증(계정이 필요합니다)".to_owned()
            }
            SecurityType::Invalid => "invalid".to_owned(),
            SecurityType::None => "none".to_owned(),
            SecurityType::VncAuth => "VNC 비밀번호".to_owned(),
            SecurityType::Unsupported(value) => describe_security_number(*value),
        });
    }
    // **이름까지만 말한다.** 예전에는 "SecurityTypes 에 TLSVnc 나 VncAuth 를 추가하면 붙는다" 를
    // 덧붙였는데, 그 조언은 길기도 하고 **보안을 낮추는 타협**이다 — RA2 는 서버 키를 인증하고
    // 세션을 암호화하는데 TLSVnc 는 익명 DH 이고 VncAuth 는 평문이다. 보안 때문에 RA2 를 켠
    // 관리자에게 그것을 권할 수는 없다.
    format!(
        "이 서버가 요구하는 인증 방식을 아직 지원하지 않습니다: {}",
        names.join(", ")
    )
}

/// 우리가 구현하지 않은 보안 타입에 **이름을 붙인다.**
///
/// 번호만 보여주면(예: "알 수 없는 방식(129)") 사용자는 그것이 무엇인지, 무엇을 바꿔야 하는지 알 수
/// 없다. 아래 번호는 RFB 등록부와 TigerVNC 의 파라미터 이름에서 온다 — 서버 설정에서 그 이름으로
/// 보이는 것들이라 그대로 적어야 찾을 수 있다.
fn describe_security_number(value: u8) -> String {
    let name = match value {
        5 => "RSA-AES(RA2)",
        6 => "RSA-AES(RA2ne)",
        16 => "Tight 보안 확장",
        18 => "TLS(VeNCrypt 이전 방식)",
        20 => "SASL",
        // macOS 가 ARD(30) 와 함께 제시하는 독자 방식들. 공개 규격이 없다.
        33 | 35 | 36 => "macOS 독자 인증",
        129 => "RSA-AES 256(RA2_256)",
        130 => "RSA-AES 256(RA2ne_256)",
        other => return format!("알 수 없는 방식({other})"),
    };
    format!("{name}({value})")
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
    outbound: &Receiver<Outbound>,
    framebuffer: &mut Framebuffer,
    zlib: &mut ZlibStream,
    tight_streams: &mut [ZlibStream; 4],
    format: PixelFormat,
    session_id: &str,
    output: &Output,
) -> Result<()> {
    let mut pointer = PointerState::default();
    // 서버가 크기 변경 확장을 쓰는지. 첫 -308 사각형을 볼 때 켜진다.
    let mut desktop_size = DesktopSizeState::default();
    // 서버가 연속 갱신을 쓰는지. EndOfContinuousUpdates 를 처음 볼 때 켜진다.
    let mut continuous = ContinuousUpdates::default();
    // 픽셀 없는 갱신에 전체 요청을 한 번 더 보냈는지. 무한 재촉을 막는 한 발 제한이다.
    let mut nudged_for_pixels = false;
    // 지금까지 켜진 것으로 확인된 확장. 바뀔 때만 데스크톱에 알린다.
    //
    // **선언과 다르다.** 목록은 늘 같지만 켜지는 것은 서버마다 다르고, 그 결과를 사용자가 볼 수
    // 있어야 "왜 한글 복붙이 안 되지" 에 답이 된다.
    let mut capabilities = CapabilitiesPayload {
        tls: transport.is_tls(),
        ..CapabilitiesPayload::default()
    };
    // 갱신에서만 드러나는 두 가지는 따로 들고 있는다. capabilities 를 제자리에서 고치면 아래
    // 변화 비교가 자기 자신과 같아져 **이벤트가 한 번도 안 나간다**(그렇게 만들어 봤다).
    let mut cursor_seen = false;
    let mut pixel_encoding = "";
    // 서버가 QEMU 확장 키를 쓰는지. 그 사각형을 본 뒤에만 스캔코드를 실어 보낸다.
    let mut qemu_keys = false;
    output.send_event(
        &Event::new("capabilities", capabilities).session(session_id),
    )?;
    // 지금 화면을 한 장이라도 받았나. 접속 직후와 크기 변경 직후에 false 다.
    //
    // **전체 재요청은 이 상태에서만 한다.** 예전에는 "픽셀 없는 갱신" 이면 무조건 전체를 다시
    // 요청했는데, 커서 모양도 픽셀 없는 사각형이라 그대로 두면 커서가 I-빔으로 바뀔 때마다 화면
    // 전체가 다시 온다.
    let mut has_screen = false;
    let mut clip = ClipboardState::default();
    // 갱신 통계를 모아 두고 몇 초에 한 번만 남긴다.
    //
    // "ZRLE 를 요청했는데 서버가 실제로 쓰고 있는가", "대역폭이 얼마인가" 는 이 줄에서만 알 수
    // 있어서 없앨 수 없다. 대신 갱신마다 찍으면 다른 로그가 전부 묻힌다 — 실제로 그래서
    // ExtendedDesktopSize 루프를 진단하는 데 시간이 더 걸렸다.
    let mut rollup = UpdateCounts::default();
    let mut rollup_updates: u64 = 0;
    let mut rollup_since = Instant::now();
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
                drain_outbound(
                    transport,
                    &mut pointer,
                    outbound,
                    &mut desktop_size,
                    &mut clip,
                    qemu_keys,
                    framebuffer,
                )?;
                report_clipboard_loss(&mut clip, session_id, output)?;
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

        // 이 메시지로 협상 결과가 바뀌었는지는 아래 match 가 끝난 뒤에 한 곳에서 본다.
        match kind[0] {
            rfb::server_message::FRAMEBUFFER_UPDATE => {
                let outcome = handle_framebuffer_update(
                    transport,
                    framebuffer,
                    zlib,
                    tight_streams,
                    format,
                    session_id,
                    output,
                    &mut desktop_size,
                )?;
                if outcome.drew_pixels {
                    // 화면이 왔다. 다음 가뭄에 다시 한 번 재촉할 수 있게 되돌린다.
                    nudged_for_pixels = false;
                    has_screen = true;
                }
                if outcome.saw_cursor {
                    cursor_seen = true;
                }
                if let Some(kind) = outcome.pixel_encoding {
                    pixel_encoding = kind;
                }
                if outcome.saw_qemu_keys {
                    qemu_keys = true;
                }
                rollup.add(&outcome.counts);
                rollup_updates += 1;
                let elapsed = rollup_since.elapsed();
                if elapsed >= UPDATE_ROLLUP_INTERVAL {
                    let seconds = elapsed.as_secs_f64().max(0.001);
                    debug!(
                        updates = rollup_updates,
                        raw = rollup.raw,
                        zrle = rollup.zrle,
                        tight = rollup.tight,
                        copy_rect = rollup.copy_rect,
                        kib = rollup.wire_bytes / 1024,
                        fps = format!("{:.1}", rollup_updates as f64 / seconds),
                        kib_s = format!("{:.0}", (rollup.wire_bytes / 1024) as f64 / seconds),
                        "화면 갱신 요약"
                    );
                    rollup = UpdateCounts::default();
                    rollup_updates = 0;
                    rollup_since = Instant::now();
                }
                if let Some((width, height)) = outcome.resized {
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
                    //
                    // 연속 갱신 중에도 전체 요청은 규격이 허용한다("새로 고침" 이 그 용도다).
                    nudged_for_pixels = false;
                    has_screen = false;
                    request_full_update(transport, framebuffer)?;
                    // 켜 둔 영역이 옛 크기다. 새 크기로 다시 알린다.
                    enable_continuous_updates(transport, &mut continuous, framebuffer)?;
                } else if continuous.enabled {
                    // 요청하지 않는다 — 서버가 알아서 계속 보낸다. 여기서 요청을 보내면 같은
                    // 영역이 두 번 오고, 그만큼 대역폭과 디코딩이 두 배가 된다.
                } else if !has_screen && !nudged_for_pixels {
                    // 아직 화면을 한 장도 못 받았는데 의사 인코딩만 들어 있는 갱신이었다. 우리가
                    // 요청한 화면이 안 온 것이므로 한 번 더 전체를 요청한다.
                    //
                    // **한 번만 한다.** 서버가 계속 의사 인코딩만 보내는 경우에도 무한 루프가 되지
                    // 않아야 한다 — 그 루프는 픽셀을 한 장도 처리하지 못하고 로그만 쏟아낸다
                    // (실측으로 겪었다).
                    nudged_for_pixels = true;
                    request_full_update(transport, framebuffer)?;
                } else {
                    request_incremental_update(transport, framebuffer)?;
                }
                // 갱신 하나를 처리한 뒤에 입력을 내보낸다 — 화면이 바쁠 때도 입력이 밀리지 않는다.
                drain_outbound(
                    transport,
                    &mut pointer,
                    outbound,
                    &mut desktop_size,
                    &mut clip,
                    qemu_keys,
                    framebuffer,
                )?;
                report_clipboard_loss(&mut clip, session_id, output)?;
            }
            rfb::server_message::BELL => {
                // 소리는 내지 않는다. 원격 벨을 로컬 알림으로 바꾸는 것은 사용자가 원할 때 할 일이다.
                debug!("서버 벨");
            }
            rfb::server_message::SERVER_CUT_TEXT => {
                match read_server_cut_text(transport)? {
                    clipboard::Incoming::Classic(text) => {
                        debug!(len = text.len(), "서버 클립보드(고전)");
                        // 빈 것도 올린다 — 원격이 클립보드를 비운 것도 상태 변화다.
                        output.send_event(
                            &Event::new("clipboard", ClipboardPayload { text })
                                .session(session_id),
                        )?;
                    }
                    clipboard::Incoming::Caps { formats } => {
                        // **이걸 본 뒤에야 우리도 확장을 보낼 수 있다.** 먼저 보내면 확장을 모르는
                        // 상대가 음수 길이를 거대한 u32 로 읽고 스트림이 깨진다.
                        debug!(formats, "서버 클립보드 caps");
                        clip.extended = formats & clipboard::FORMAT_TEXT != 0;
                        if clip.extended && !clip.sent_caps {
                            clip.sent_caps = true;
                            rfb::write_client_cut_text_extended(
                                transport,
                                &clipboard::encode_caps(),
                            )?;
                            // caps 를 주고받기 전에 사용자가 복사해 둔 것이 있으면 지금 보낸다.
                            if let Some(text) = clip.pending.take() {
                                send_clipboard_text(transport, &mut clip, &text)?;
                            }
                        }
                    }
                    clipboard::Incoming::Provide { text } => {
                        debug!(len = text.len(), "서버 클립보드(확장)");
                        output.send_event(
                            &Event::new("clipboard", ClipboardPayload { text })
                                .session(session_id),
                        )?;
                    }
                    clipboard::Incoming::Notify { .. } => {
                        // 상대가 "가진 것이 있다" 고 알렸다. 우리는 항상 텍스트를 원한다.
                        rfb::write_client_cut_text_extended(
                            transport,
                            &clipboard::encode_request(),
                        )?;
                    }
                    clipboard::Incoming::Request { .. } => {
                        // 우리가 notify 로 알린 것을 달라고 한다.
                        if let Some(text) = clip.offered.clone() {
                            if let Some(body) = clipboard::encode_provide(&text) {
                                rfb::write_client_cut_text_extended(transport, &body)?;
                            }
                        }
                    }
                    clipboard::Incoming::Ignored => {}
                }
            }
            rfb::server_message::SET_COLOUR_MAP_ENTRIES => {
                read_and_discard_colour_map(transport)?;
            }
            rfb::server_message::END_OF_CONTINUOUS_UPDATES => {
                // 본문이 없다. 처음 받은 것은 "이 확장을 안다" 는 증거이고(그때만 켤 수 있다),
                // 그 뒤에 오는 것은 서버가 실제로 멈췄다는 뜻이다.
                if !continuous.supported {
                    continuous.supported = true;
                    enable_continuous_updates(transport, &mut continuous, framebuffer)?;
                } else if continuous.enabled {
                    continuous.enabled = false;
                    continuous.area = None;
                    debug!("서버가 연속 갱신을 멈췄다 — 요청 기반으로 돌아간다");
                    // 요청 기반으로 돌아가려면 흐름을 다시 시작해야 한다. 여기서 요청을 보내지
                    // 않으면 아무도 요청하지 않아 화면이 그대로 멈춘다.
                    request_incremental_update(transport, framebuffer)?;
                }
            }
            rfb::server_message::SERVER_FENCE => {
                let (flags, fence_payload) = rfb::read_fence(transport)?;
                if flags & rfb::fence_flag::REQUEST != 0 {
                    // **반드시 답해야 한다.** 답하지 않으면 서버가 이 울타리를 기다리며 갱신을
                    // 멈춘다(플로 컨트롤에 쓰는 서버가 있다). flags 를 0 으로 두는 이유는
                    // write_client_fence 주석에 있다.
                    rfb::write_client_fence(transport, 0, &fence_payload)?;
                } else {
                    trace!(flags, "서버 울타리(응답 불필요)");
                }
            }
            other => {
                // 모르는 메시지는 길이를 알 수 없어 스트림을 다시 맞출 방법이 없다. 여기서 끊는
                // 편이 깨진 화면을 계속 그리는 것보다 낫다.
                bail!("서버가 알 수 없는 메시지({other})를 보냈습니다");
            }
        }

        // 협상 결과가 바뀌면 알린다. 매 갱신마다 보내면 이벤트가 초당 수십 개가 되므로 **바뀔
        // 때만** 보낸다 — 대부분의 세션에서 이 이벤트는 두세 번으로 끝난다.
        let next = CapabilitiesPayload {
            extended_clipboard: clip.extended,
            desktop_resize: desktop_size.supported,
            continuous_updates: continuous.enabled,
            cursor: cursor_seen,
            encoding: pixel_encoding,
            qemu_keys,
            tls: capabilities.tls,
        };
        if next != capabilities {
            capabilities = next;
            debug!(?capabilities, "협상 결과가 바뀌었다");
            output.send_event(
                &Event::new("capabilities", capabilities).session(session_id),
            )?;
        }
    }
}

/// 한 FramebufferUpdate 의 결과.
#[derive(Debug, Default)]
struct UpdateOutcome {
    /// 크기가 실제로 바뀌었으면 새 크기.
    resized: Option<(u16, u16)>,
    /// 픽셀이 있는 사각형을 하나라도 처리했나.
    ///
    /// 의사 인코딩만 들어 있는 갱신이 있다 — 그때는 우리가 요청한 화면이 아직 안 온 것이므로,
    /// 증분으로 넘어가면 화면이 검은 채로 남을 수 있다.
    drew_pixels: bool,
    /// 이 갱신에서 인코딩이 어떻게 쓰였는지. pump 가 모아 요약으로 남긴다.
    counts: UpdateCounts,
    /// 커서 모양 사각형이 있었나. 이걸 본 것이 곧 "서버가 커서를 따로 보낸다" 는 증거다.
    saw_cursor: bool,
    /// 픽셀을 실어 온 인코딩. 여러 개면 마지막 것 — 서버는 보통 한 종류를 계속 쓴다.
    pixel_encoding: Option<&'static str>,
    /// QEMU 확장 키 사각형이 있었나. 이걸 본 것이 곧 스캔코드를 보내도 된다는 증거다.
    saw_qemu_keys: bool,
}

/// 한 FramebufferUpdate 를 처리한다.
fn handle_framebuffer_update(
    stream: &mut Transport,
    framebuffer: &mut Framebuffer,
    zlib: &mut ZlibStream,
    tight_streams: &mut [ZlibStream; 4],
    format: PixelFormat,
    session_id: &str,
    output: &Output,
    desktop_size: &mut DesktopSizeState,
) -> Result<UpdateOutcome> {
    let mut head = [0_u8; 3];
    stream.read_exact(&mut head)?;
    let rectangles = u16::from_be_bytes([head[1], head[2]]);

    // 인코딩별 계수와 와이어 바이트를 남긴다.
    //
    // 이게 없으면 "ZRLE 를 요청했는데 서버가 실제로 보내고 있는가" 를 확인할 방법이 없다. 우리가
    // 내보내는 프레임은 이미 RGBA 로 풀려 있어 크기가 늘 같기 때문이다 — 대역폭 개선을 눈으로
    // 확인할 수 있는 유일한 자리가 여기다.
    let mut counts = UpdateCounts::default();
    let mut outcome = UpdateOutcome::default();
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
                outcome.drew_pixels = true;
                outcome.pixel_encoding = Some("raw");
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
                outcome.drew_pixels = true;
                outcome.pixel_encoding = Some("copyRect");
                send_rect(framebuffer, rect, session_id, output)?;
            }
            encoding::TIGHT => {
                let wire = read_tight_rect(
                    stream,
                    framebuffer,
                    tight_streams,
                    format,
                    rect,
                )?;
                counts.tight += 1;
                counts.wire_bytes += wire;
                outcome.drew_pixels = true;
                outcome.pixel_encoding = Some("tight");
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
                outcome.drew_pixels = true;
                outcome.pixel_encoding = Some("zrle");
                send_rect(framebuffer, rect, session_id, output)?;
            }
            encoding::CURSOR => {
                // 의사 인코딩이다. 사각형의 x·y 는 좌표가 아니라 **핫스팟**이고, 본문은 커서
                // 모양이다. 길이 필드가 없으므로 크기에서 계산한 만큼을 **반드시** 다 읽는다 —
                // 남기면 다음 사각형 경계가 어긋난다.
                let mut body = vec![0_u8; cursor::body_length(rect, format)];
                stream.read_exact(&mut body)?;
                counts.wire_bytes += body.len();
                outcome.saw_cursor = true;
                match cursor::decode(rect, format, &body) {
                    Some(shape) => {
                        trace!(
                            width = shape.width,
                            height = shape.height,
                            hidden = shape.is_hidden(),
                            "커서 모양"
                        );
                        output.send_cursor(
                            &CursorPayload {
                                kind: "vncCursor",
                                session_id: session_id.to_owned(),
                                hotspot_x: shape.hotspot_x,
                                hotspot_y: shape.hotspot_y,
                                width: shape.width,
                                height: shape.height,
                            },
                            &shape.rgba,
                        )?;
                    }
                    // 커서 하나 때문에 세션을 끊지 않는다. 바이트는 이미 다 읽었으므로 스트림은
                    // 멀쩡하고, 렌더러는 이전 모양(또는 기본 커서)을 그대로 쓴다.
                    None => warn!(
                        width = rect.width,
                        height = rect.height,
                        "커서 모양을 해독할 수 없다"
                    ),
                }
            }
            encoding::QEMU_KEY_EVENT => {
                // 의사 인코딩이고 **본문이 없다**. 이 사각형이 온 것 자체가 "스캔코드를 받는다" 는
                // 선언이다(크기·좌표는 의미가 없다).
                outcome.saw_qemu_keys = true;
            }
            encoding::DESKTOP_SIZE => {
                // 의사 인코딩이다. 픽셀이 따라오지 않고 사각형의 크기가 새 화면 크기다.
                framebuffer.resize(rect.width, rect.height);
                outcome.resized = Some((rect.width, rect.height));
            }
            encoding::EXTENDED_DESKTOP_SIZE => {
                // **이 사각형을 받은 것이 곧 "서버가 크기 요청을 받는다" 는 증거다.**
                //
                // 사각형의 x·y 자리는 좌표가 아니라 이유·결과 코드이고, 본문은 화면 배치다.
                // 본문 길이를 알 수 있는 유일한 방법이 그 배치를 읽는 것이라, 지원 여부와
                // 무관하게 반드시 다 읽어야 한다 — 남기면 다음 사각형 경계가 어긋난다.
                let mut head = [0_u8; 4];
                stream.read_exact(&mut head)?;
                let screens = usize::from(head[0]);
                let mut body = vec![0_u8; 4 + screens * 16];
                body[..4].copy_from_slice(&head);
                stream.read_exact(&mut body[4..])?;

                let reason = rect.x;
                let result = rect.y;
                if let Some(screen_id) = rfb::first_screen_id(&body) {
                    desktop_size.supported = true;
                    desktop_size.screen_id = screen_id;
                }

                if reason == rfb::desktop_size_reason::THIS_CLIENT && result != 0 {
                    // 다음 요청을 막지 않기 위해 마지막 요청 기록을 지운다(창을 다시 조절하면
                    // 또 시도한다).
                    desktop_size.requested = None;
                    warn!(
                        result,
                        detail = rfb::describe_desktop_size_result(result),
                        "서버가 화면 크기 요청을 거부했습니다"
                    );
                }

                // 판정은 rfb::is_desktop_resize 가 한다 — 통보와 거부를 크기 변경으로 오인하면
                // 무한 루프 + 검은 화면이 된다(그 함수 주석 참고).
                if !rfb::is_desktop_resize(
                    (rect.width, rect.height),
                    (framebuffer.width(), framebuffer.height()),
                    reason,
                    result,
                ) {
                    debug!(
                        width = rect.width,
                        height = rect.height,
                        reason,
                        result,
                        "ExtendedDesktopSize(크기 변경 아님)"
                    );
                    continue;
                }

                framebuffer.resize(rect.width, rect.height);
                outcome.resized = Some((rect.width, rect.height));
            }
            #[allow(unreachable_patterns)]
            other => {
                // 우리가 요청하지 않은 인코딩이다. 데이터 길이를 모르므로 건너뛸 수 없다.
                bail!("요청하지 않은 인코딩({other})이 도착했습니다");
            }
        }
    }
    // 갱신마다 찍으면 초당 수십 줄이 쏟아져 다른 로그를 볼 수 없다. 개별 갱신은 trace,
    // 사람이 읽는 요약은 pump 가 몇 초에 한 번 남긴다.
    trace!(
        rects = rectangles,
        raw = counts.raw,
        zrle = counts.zrle,
        tight = counts.tight,
        copy_rect = counts.copy_rect,
        wire_kib = counts.wire_bytes / 1024,
        "framebuffer update"
    );
    outcome.counts = counts;
    Ok(outcome)
}

/// Tight 사각형 하나를 읽어 프레임버퍼에 쓴다. 읽은 와이어 바이트 수를 돌려준다.
///
/// **읽는 순서가 곧 규격이다.** control → (필터 id) → (색 표) → 길이 → 데이터. 어느 하나를
/// 건너뛰면 그 뒤 사각형 경계가 전부 어긋난다 — 길이 필드가 가변이라 되짚을 방법도 없다.
fn read_tight_rect(
    stream: &mut Transport,
    framebuffer: &mut Framebuffer,
    streams: &mut [ZlibStream; 4],
    format: PixelFormat,
    rect: Rect,
) -> Result<usize> {
    let mut control = [0_u8; 1];
    stream.read_exact(&mut control)?;
    let control = control[0];
    let mut wire = 1;

    // 스트림 초기화 지시를 여기서 처리한다(control 의 하위 4비트).
    let compression = tight::read_control(control, streams)?;
    let pixel_bytes = tight::bytes_per_pixel(format);

    match compression {
        tight::Compression::Fill => {
            let mut pixel = vec![0_u8; pixel_bytes];
            stream.read_exact(&mut pixel)?;
            wire += pixel.len();
            tight::apply_fill(framebuffer, rect, format, &pixel)?;
        }
        tight::Compression::Jpeg => {
            let length = tight::read_compact_length(stream)?;
            if length > 16 * 1024 * 1024 {
                bail!("Tight JPEG 길이가 비정상입니다({length})");
            }
            let mut data = vec![0_u8; length];
            stream.read_exact(&mut data)?;
            wire += length;
            tight::apply_jpeg(framebuffer, rect, &data)?;
        }
        tight::Compression::Basic { stream: id, .. } => {
            // 필터는 control 이 "온다" 고 말할 때만 바이트로 실려 온다. 없으면 Copy 다.
            let filter = if tight::has_filter_id(control) {
                let mut id = [0_u8; 1];
                stream.read_exact(&mut id)?;
                wire += 1;
                tight::filter_from_id(id[0])?
            } else {
                tight::Filter::Copy
            };

            // 색 표는 필터 바이트 **뒤**, 길이 **앞**에 압축되지 않은 채로 온다.
            let mut palette: Vec<[u8; 4]> = Vec::new();
            if filter == tight::Filter::Palette {
                let mut count = [0_u8; 1];
                stream.read_exact(&mut count)?;
                wire += 1;
                let colours = usize::from(count[0]) + 1;
                let mut raw = vec![0_u8; colours * pixel_bytes];
                stream.read_exact(&mut raw)?;
                wire += raw.len();
                for chunk in raw.chunks_exact(pixel_bytes) {
                    palette.push(tight::palette_entry(chunk, format));
                }
            }

            let expected = tight::filtered_length(rect, format, &filter, palette.len());
            let data = if tight::is_uncompressed(expected) {
                // 작은 조각은 압축을 생략한다. 여기서 zlib 을 기대하면 그 자리에서 오류가 난다.
                let mut plain = vec![0_u8; expected];
                stream.read_exact(&mut plain)?;
                wire += plain.len();
                plain
            } else {
                let length = tight::read_compact_length(stream)?;
                if length > 64 * 1024 * 1024 {
                    bail!("Tight 조각 길이가 비정상입니다({length})");
                }
                let mut compressed = vec![0_u8; length];
                stream.read_exact(&mut compressed)?;
                wire += length;
                streams[id].inflate(&compressed)?.to_vec()
            };

            tight::apply_basic(framebuffer, rect, format, &filter, &palette, &data)?;
        }
    }
    Ok(wire)
}

/// 한 갱신에서 인코딩이 어떻게 쓰였는지.
#[derive(Debug, Default, Clone, Copy)]
struct UpdateCounts {
    raw: usize,
    zrle: usize,
    tight: usize,
    copy_rect: usize,
    wire_bytes: usize,
}

impl UpdateCounts {
    fn add(&mut self, other: &Self) {
        self.raw += other.raw;
        self.zrle += other.zrle;
        self.tight += other.tight;
        self.copy_rect += other.copy_rect;
        self.wire_bytes += other.wire_bytes;
    }
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

/// ServerCutText 를 읽는다. 길이가 **음수면 확장 메시지**다.
///
/// 어느 쪽이든 본문은 끝까지 읽는다 — 남기면 다음 메시지 경계가 어긋난다.
fn read_server_cut_text(stream: &mut Transport) -> Result<clipboard::Incoming> {
    let mut head = [0_u8; 7];
    stream.read_exact(&mut head)?;
    let raw = i32::from_be_bytes([head[3], head[4], head[5], head[6]]);
    let length = raw.unsigned_abs() as usize;
    if length > 8 * 1024 * 1024 {
        bail!("서버 클립보드 길이가 비정상입니다({length})");
    }
    let mut body = vec![0_u8; length];
    stream.read_exact(&mut body)?;

    if raw < 0 {
        Ok(clipboard::decode_extended(&body))
    } else {
        Ok(clipboard::Incoming::Classic(clipboard::decode_classic(&body)))
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 서브타입 선택은 **보안 결정**이다. 잘못 고르면 비밀번호가 평문으로 나가거나, 붙을 수 있는
    /// 서버에 못 붙는다. 와이어를 태우지 않고 이 함수만 따로 본다.
    /// 못 붙는 서버에서 사용자가 할 수 있는 일을 문구가 알려주는지.
    ///
    /// RA2 는 TigerVNC 의 옵트인 설정이다(기본값은 TLSVnc,VncAuth 다 — 실측). 그래서 이 문구를 본
    /// 사용자는 서버 설정 한 줄로 붙을 수 있는데, 번호만 보여주면 그 사실을 알 수 없다.
    #[test]
    fn names_the_security_types_we_do_not_implement() {
        let message = describe_unsupported(&[
            SecurityType::Unsupported(129),
            SecurityType::Unsupported(130),
        ]);
        assert!(message.contains("RSA-AES 256(RA2_256)"), "{message}");
        // 이름까지만이다. 서버 설정을 바꾸라는 조언은 붙이지 않는다(보안을 낮추는 타협이다).
        assert!(!message.contains("SecurityTypes"), "{message}");

        let apple = describe_unsupported(&[SecurityType::Unsupported(35)]);
        assert!(apple.contains("macOS 독자 인증(35)"), "{apple}");

        // 표에 없는 번호는 번호를 그대로 보여준다 — 무엇인지 모른다고 말하는 것이 정확하다.
        assert!(describe_unsupported(&[SecurityType::Unsupported(200)]).contains("(200)"));
    }

    #[test]
    fn never_picks_plaintext_plain() {
        // 통로 암호화가 없는 Plain(256) 은 비밀번호를 그대로 실어 보낸다. 계정과 비밀번호가 다
        // 있어도 고르지 않는다 — 붙는 것보다 새지 않는 것이 먼저다.
        assert_eq!(
            pick_vencrypt_subtype(&[vencrypt::SubType::Plain], "secret", "operator"),
            None
        );
    }

    #[test]
    fn prefers_plain_when_an_account_is_given() {
        // 계정을 적었다는 것은 그 방식으로 붙겠다는 뜻이다. VncAuth 로는 계정을 쓸 수 없다.
        assert_eq!(
            pick_vencrypt_subtype(
                &[vencrypt::SubType::X509Vnc, vencrypt::SubType::X509Plain],
                "secret",
                "operator",
            ),
            Some(vencrypt::SubType::X509Plain)
        );
        // 인증서 쪽을 먼저 고른다 — 익명 DH 는 상대가 누구인지 보장하지 않는다.
        assert_eq!(
            pick_vencrypt_subtype(
                &[vencrypt::SubType::TlsPlain, vencrypt::SubType::X509Plain],
                "secret",
                "operator",
            ),
            Some(vencrypt::SubType::X509Plain)
        );
    }

    #[test]
    fn tells_the_user_to_add_an_account_when_plain_is_the_only_option() {
        // 계정만 넣으면 붙는 상황에서 "서버에 인증서를 설정하세요" 라고 하면 엉뚱한 곳을 뒤진다.
        let message = describe_vencrypt_refusal(&[vencrypt::SubType::TlsPlain], "");
        assert!(message.contains("계정을"), "{message}");
        assert!(!message.contains("X509Vnc"), "{message}");
        // 계정이 있는데도 못 고른 경우는 원래 문구를 쓴다(우리가 못 세우는 방식만 있는 것이다).
        let other = describe_vencrypt_refusal(&[vencrypt::SubType::TlsSasl], "operator");
        assert!(other.contains("지원하지 않습니다"), "{other}");
    }

    #[test]
    fn ignores_plain_without_an_account() {
        // 빈 계정을 보내면 서버가 거절하고, 그 실패는 "비밀번호가 틀렸다" 와 구분되지 않는다.
        assert_eq!(
            pick_vencrypt_subtype(
                &[vencrypt::SubType::X509Plain, vencrypt::SubType::X509Vnc],
                "secret",
                "",
            ),
            Some(vencrypt::SubType::X509Vnc)
        );
        assert_eq!(
            pick_vencrypt_subtype(&[vencrypt::SubType::X509Plain], "secret", ""),
            None
        );
    }
}
