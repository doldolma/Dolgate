//! 가짜 RFB 서버로 세션 전 구간을 검증한다.
//!
//! 협상부터 화면 사각형까지 한 번에 지나가는 경로는 단위 테스트로 나눠 볼 수 없다 — 바이트 순서
//! 하나가 어긋나면 그 뒤 전부가 밀리는데, 그 증상은 실서버에서 "붙었다가 멈춘다" 로만 보인다.
//! rdp-core 를 헤드리스로 몰아 보는 하네스와 같은 생각이다.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use core_framing::{read_frame, Frame, KIND_CONTROL, KIND_STREAM};
use openssl::bn::{BigNum, BigNumContext};
use vnc_core::output::Output;
use vnc_core::protocol::{ConnectPayload, InputEvent};
use vnc_core::rfb::PixelFormat;
use vnc_core::session;

/// 세션이 stdout 대신 쓰는 버퍼.
#[derive(Clone, Default)]
struct Collected(Arc<Mutex<Vec<u8>>>);

impl Write for Collected {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Collected {
    /// 프레임이 `count` 개 모일 때까지 기다렸다가 해석한다.
    fn frames(&self, count: usize) -> Vec<Frame> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let bytes = self.0.lock().unwrap().clone();
            let mut cursor = bytes.as_slice();
            let mut frames = Vec::new();
            while let Ok(frame) = read_frame(&mut cursor) {
                frames.push(frame);
            }
            if frames.len() >= count || Instant::now() > deadline {
                return frames;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn metadata(frame: &Frame) -> serde_json::Value {
    serde_json::from_slice(&frame.metadata).expect("메타데이터가 JSON 이어야 한다")
}

/// 가짜 서버가 클라이언트에게서 받은 것.
enum Seen {
    SetPixelFormat(PixelFormat),
    Encodings(Vec<i32>),
    UpdateRequest { incremental: bool },
    Input(Vec<u8>),
    /// 연속 갱신을 켜는 메시지(150). 영역이 화면 크기와 같아야 한다.
    EnableContinuousUpdates { enable: bool, width: u16, height: u16 },
    /// 울타리 응답. 서버가 보낸 payload 를 그대로 돌려줬는지 본다.
    FenceReply { flags: u32, payload: Vec<u8> },
    /// 연속 갱신을 켠 뒤에 클라이언트가 보낸 나머지 바이트 전부.
    AfterContinuousUpdates(Vec<u8>),
    /// ARD 로 받아 복호화한 계정·비밀번호.
    ArdCredentials { username: String, password: String },
    /// 확장 ClientCutText(음수 길이) 의 본문. flags 와 데이터를 그대로 담는다.
    ExtendedCutText(Vec<u8>),
}

/// 확장 클립보드를 쓰는 서버.
///
/// **caps 를 보내는 쪽이 협상을 시작한다.** 우리가 목록에 `0xc0a1e5ce` 를 실어야 서버가 caps 를
/// 보내고, 그 caps 를 본 뒤에야 우리도 확장 메시지를 보낼 수 있다. 이 왕복을 세션 수준에서 재는
/// 테스트가 없어서, 인코딩 번호가 틀렸던 동안(-1063) 확장 경로가 한 번도 실행되지 않았는데도
/// 단위 테스트는 전부 통과했다.
// `advertise_actions`: caps 로 알릴 동작 비트. 실서버가 갈리는 지점이다 — TigerVNC 는 notify 를
//   알리고(그래서 우리는 notify 로 알려야 한다), x11vnc 는 알리지 않는다(그래서 provide 를 바로 보낸다).
// `reply_with_request`: 우리 notify 를 받은 뒤 request 를 보낼지. TigerVNC 는 붙여넣을 때 이걸 보낸다.
fn spawn_extended_clipboard_server(
    advertise_actions: u32,
    reply_with_request: bool,
) -> (u16, Receiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = channel();

    thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_nodelay(true).ok();

        socket.write_all(b"RFB 003.008\n").unwrap();
        let mut client_version = [0_u8; 12];
        socket.read_exact(&mut client_version).unwrap();
        socket.write_all(&[1, 1]).unwrap();
        let mut chosen = [0_u8; 1];
        socket.read_exact(&mut chosen).unwrap();
        socket.write_all(&0_u32.to_be_bytes()).unwrap();
        let mut shared = [0_u8; 1];
        socket.read_exact(&mut shared).unwrap();

        let mut init = Vec::new();
        init.extend_from_slice(&2_u16.to_be_bytes());
        init.extend_from_slice(&2_u16.to_be_bytes());
        init.extend_from_slice(&PixelFormat::rgba32().to_bytes());
        init.extend_from_slice(&4_u32.to_be_bytes());
        init.extend_from_slice(b"fake");
        socket.write_all(&init).unwrap();

        let mut set_format = [0_u8; 20];
        socket.read_exact(&mut set_format).unwrap();

        let mut head = [0_u8; 4];
        socket.read_exact(&mut head).unwrap();
        let count = u16::from_be_bytes([head[2], head[3]]);
        let mut encodings = Vec::new();
        for _ in 0..count {
            let mut raw = [0_u8; 4];
            socket.read_exact(&mut raw).unwrap();
            encodings.push(i32::from_be_bytes(raw));
        }
        // 실서버와 같은 조건: 목록에서 확장 클립보드를 **본 뒤에만** caps 를 보낸다.
        let advertised = encodings.contains(&(0xc0a1_e5ceu32 as i32));
        tx.send(Seen::Encodings(encodings)).ok();

        let incremental = read_update_request(&mut socket);
        tx.send(Seen::UpdateRequest { incremental }).ok();

        if advertised {
            // ServerCutText 의 길이를 음수로 실으면 확장 메시지다. 본문은 flags(4) + 데이터.
            let mut caps = vec![3_u8, 0, 0, 0];
            caps.extend_from_slice(&(-8_i32).to_be_bytes());
            // caps 동작(1<<24) + 알릴 동작들 + 텍스트 형식(1<<0), 그리고 한도(형식마다 4바이트).
            //
            // **번호를 `1 << n` 으로 적는다.** 16진수로 적었더니 표가 한 칸 밀린 것을 아무도
            // 못 알아봤다 — 그 상태로 코드와 테스트가 같이 틀려 통과했다.
            caps.extend_from_slice(
                &((1_u32 << 24) | advertise_actions | (1 << 0)).to_be_bytes(),
            );
            caps.extend_from_slice(&(256_u32 * 1024).to_be_bytes());
            socket.write_all(&caps).unwrap();
        }

        // 클라이언트가 보내는 것을 모아 넘긴다. 확장 ClientCutText 만 골라낸다.
        socket.set_read_timeout(Some(Duration::from_secs(3))).ok();
        loop {
            let mut kind = [0_u8; 1];
            if socket.read_exact(&mut kind).is_err() {
                break;
            }
            if kind[0] != 6 {
                // 이 테스트는 클립보드만 본다. 다른 메시지는 길이를 알아야 건너뛸 수 있어
                // 여기서 멈춘다 — 세션은 클립보드 외에 아무것도 보내지 않는다.
                break;
            }
            let mut rest = [0_u8; 7];
            if socket.read_exact(&mut rest).is_err() {
                break;
            }
            let length = i32::from_be_bytes([rest[3], rest[4], rest[5], rest[6]]);
            let size = length.unsigned_abs() as usize;
            let mut body = vec![0_u8; size];
            if socket.read_exact(&mut body).is_err() {
                break;
            }
            if length < 0 {
                let flags = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
                let is_notify = flags & (1 << 27) != 0;
                tx.send(Seen::ExtendedCutText(body)).ok();
                // notify 를 받으면 request 로 답한다 — TigerVNC 가 붙여넣을 때 하는 일이다.
                if reply_with_request && is_notify {
                    let mut request = vec![3_u8, 0, 0, 0];
                    request.extend_from_slice(&(-4_i32).to_be_bytes());
                    request.extend_from_slice(&((1_u32 << 25) | (1 << 0)).to_be_bytes());
                    socket.write_all(&request).unwrap();
                }
            }
        }
    });

    (port, rx)
}

/// 협상을 마치고 화면 한 장을 보내는 서버를 띄운다.
fn spawn_server(security: u8, password_ok: bool) -> (u16, Receiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = channel();

    thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_nodelay(true).ok();

        // 1) 버전
        socket.write_all(b"RFB 003.008\n").unwrap();
        let mut client_version = [0_u8; 12];
        socket.read_exact(&mut client_version).unwrap();
        assert_eq!(&client_version, b"RFB 003.008\n");

        // 2) 보안 타입 하나만 제시한다.
        socket.write_all(&[1, security]).unwrap();
        let mut chosen = [0_u8; 1];
        socket.read_exact(&mut chosen).unwrap();
        assert_eq!(chosen[0], security);

        if security == 2 {
            // VncAuth: 챌린지를 보내고 응답을 확인한다.
            let challenge = [0x42_u8; 16];
            socket.write_all(&challenge).unwrap();
            let mut response = [0_u8; 16];
            socket.read_exact(&mut response).unwrap();
            let expected = vnc_core::auth::respond_to_challenge("hunter2", &challenge);
            assert_eq!(response, expected, "VncAuth 응답이 규격과 달라졌다");
            if password_ok {
                socket.write_all(&0_u32.to_be_bytes()).unwrap();
            } else {
                socket.write_all(&1_u32.to_be_bytes()).unwrap();
                let reason = "authentication failed";
                socket
                    .write_all(&(reason.len() as u32).to_be_bytes())
                    .unwrap();
                socket.write_all(reason.as_bytes()).unwrap();
                return;
            }
        } else {
            // None 이어도 3.8 은 SecurityResult 를 보낸다.
            socket.write_all(&0_u32.to_be_bytes()).unwrap();
        }

        // 3) ClientInit → ServerInit (2x2 화면)
        let mut shared = [0_u8; 1];
        socket.read_exact(&mut shared).unwrap();
        assert_eq!(shared[0], 1, "기본은 공유 접속이어야 한다");

        let mut init = Vec::new();
        init.extend_from_slice(&2_u16.to_be_bytes());
        init.extend_from_slice(&2_u16.to_be_bytes());
        init.extend_from_slice(&PixelFormat::rgba32().to_bytes());
        init.extend_from_slice(&4_u32.to_be_bytes());
        init.extend_from_slice(b"fake");
        socket.write_all(&init).unwrap();

        // 4) SetPixelFormat
        let mut set_format = [0_u8; 20];
        socket.read_exact(&mut set_format).unwrap();
        assert_eq!(set_format[0], 0);
        let mut format_bytes = [0_u8; 16];
        format_bytes.copy_from_slice(&set_format[4..20]);
        tx.send(Seen::SetPixelFormat(PixelFormat::parse(&format_bytes)))
            .ok();

        // 5) SetEncodings
        let mut head = [0_u8; 4];
        socket.read_exact(&mut head).unwrap();
        assert_eq!(head[0], 2);
        let count = u16::from_be_bytes([head[2], head[3]]);
        let mut encodings = Vec::new();
        for _ in 0..count {
            let mut raw = [0_u8; 4];
            socket.read_exact(&mut raw).unwrap();
            encodings.push(i32::from_be_bytes(raw));
        }
        tx.send(Seen::Encodings(encodings)).ok();

        // 6) 첫 갱신 요청은 전체(증분 아님)여야 한다.
        let request = read_update_request(&mut socket);
        tx.send(Seen::UpdateRequest {
            incremental: request,
        })
        .ok();

        // 7) 화면 한 장: Raw 사각형 하나. 패딩 바이트를 0 으로 두어 알파 처리를 검증한다.
        let mut update = Vec::new();
        update.push(0); // FramebufferUpdate
        update.push(0); // 패딩
        update.extend_from_slice(&1_u16.to_be_bytes()); // 사각형 1개
        update.extend_from_slice(&0_u16.to_be_bytes()); // x
        update.extend_from_slice(&0_u16.to_be_bytes()); // y
        update.extend_from_slice(&2_u16.to_be_bytes()); // width
        update.extend_from_slice(&2_u16.to_be_bytes()); // height
        update.extend_from_slice(&0_i32.to_be_bytes()); // Raw
        for index in 0..4_u8 {
            update.extend_from_slice(&[index + 1, index + 2, index + 3, 0]);
        }
        socket.write_all(&update).unwrap();

        // 8) 다음 요청은 증분이어야 한다.
        let request = read_update_request(&mut socket);
        tx.send(Seen::UpdateRequest {
            incremental: request,
        })
        .ok();

        // 9) 남은 입력을 모아 전달한다. 클라이언트가 소켓을 닫으면 끝난다.
        let mut rest = Vec::new();
        let mut buffer = [0_u8; 256];
        socket
            .set_read_timeout(Some(Duration::from_millis(1500)))
            .ok();
        while let Ok(read) = socket.read(&mut buffer) {
            if read == 0 {
                break;
            }
            rest.extend_from_slice(&buffer[..read]);
            // **포인터 이벤트 두 개(12바이트)를 다 모은다.** 6에서 멈추면 두 메시지가 한 번의 TCP
            // 읽기로 합쳐질 때만 통과하는 동전 던지기가 된다 — 병렬 테스트가 늘자 실제로 갈렸다.
            if rest.len() >= 12 {
                break;
            }
        }
        tx.send(Seen::Input(rest)).ok();
    });

    (port, rx)
}

/// 확장(커서·연속 갱신·울타리)을 쓰는 서버.
///
/// 이 세 가지는 **주고받는 순서 자체가 규격**이라 단위 테스트로 나눌 수 없다. 특히 연속 갱신은
/// "켠 뒤에는 요청을 보내지 않는다" 가 핵심인데, 그것은 보내지 **않은** 것을 확인해야 알 수 있다.
fn spawn_extension_server() -> (u16, Receiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = channel();

    thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_nodelay(true).ok();

        socket.write_all(b"RFB 003.008\n").unwrap();
        let mut client_version = [0_u8; 12];
        socket.read_exact(&mut client_version).unwrap();

        socket.write_all(&[1, 1]).unwrap(); // 보안 타입 None 하나
        let mut chosen = [0_u8; 1];
        socket.read_exact(&mut chosen).unwrap();
        socket.write_all(&0_u32.to_be_bytes()).unwrap(); // SecurityResult

        let mut shared = [0_u8; 1];
        socket.read_exact(&mut shared).unwrap();

        let mut init = Vec::new();
        init.extend_from_slice(&2_u16.to_be_bytes());
        init.extend_from_slice(&2_u16.to_be_bytes());
        init.extend_from_slice(&PixelFormat::rgba32().to_bytes());
        init.extend_from_slice(&4_u32.to_be_bytes());
        init.extend_from_slice(b"fake");
        socket.write_all(&init).unwrap();

        let mut set_format = [0_u8; 20];
        socket.read_exact(&mut set_format).unwrap();

        let mut head = [0_u8; 4];
        socket.read_exact(&mut head).unwrap();
        let count = u16::from_be_bytes([head[2], head[3]]);
        let mut encodings = Vec::new();
        for _ in 0..count {
            let mut raw = [0_u8; 4];
            socket.read_exact(&mut raw).unwrap();
            encodings.push(i32::from_be_bytes(raw));
        }
        tx.send(Seen::Encodings(encodings)).ok();

        // 첫 요청(전체)을 받는다. 여기까지는 요청 기반이다.
        let incremental = read_update_request(&mut socket);
        tx.send(Seen::UpdateRequest { incremental }).ok();

        // **연속 갱신을 안다고 알린다.** 규격이 이 메시지를 지원 통보로 정해 두었다.
        socket.write_all(&[150]).unwrap();

        // 클라이언트가 켜는 메시지를 보내야 한다.
        let mut enable = [0_u8; 10];
        socket.read_exact(&mut enable).unwrap();
        assert_eq!(enable[0], 150, "EnableContinuousUpdates 여야 한다");
        tx.send(Seen::EnableContinuousUpdates {
            enable: enable[1] != 0,
            width: u16::from_be_bytes([enable[6], enable[7]]),
            height: u16::from_be_bytes([enable[8], enable[9]]),
        })
        .ok();

        // 커서 모양 + QEMU 키 선언 + 화면 한 장을 한 갱신에 담아 보낸다.
        let mut update = Vec::new();
        update.push(0); // FramebufferUpdate
        update.push(0);
        update.extend_from_slice(&3_u16.to_be_bytes()); // 사각형 3개

        // 0) QEMU 확장 키: 본문이 없는 의사 인코딩이다.
        update.extend_from_slice(&0_u16.to_be_bytes());
        update.extend_from_slice(&0_u16.to_be_bytes());
        update.extend_from_slice(&0_u16.to_be_bytes());
        update.extend_from_slice(&0_u16.to_be_bytes());
        update.extend_from_slice(&(-258_i32).to_be_bytes());

        // 1) 커서: 2x1, 핫스팟 (1,0), 왼쪽만 불투명.
        update.extend_from_slice(&1_u16.to_be_bytes()); // x = 핫스팟 x
        update.extend_from_slice(&0_u16.to_be_bytes()); // y = 핫스팟 y
        update.extend_from_slice(&2_u16.to_be_bytes());
        update.extend_from_slice(&1_u16.to_be_bytes());
        update.extend_from_slice(&(-239_i32).to_be_bytes());
        update.extend_from_slice(&[9, 8, 7, 0]); // 왼쪽 픽셀
        update.extend_from_slice(&[6, 5, 4, 0]); // 오른쪽 픽셀
        update.push(0b1000_0000); // 마스크

        // 2) 화면: Raw 2x2.
        update.extend_from_slice(&0_u16.to_be_bytes());
        update.extend_from_slice(&0_u16.to_be_bytes());
        update.extend_from_slice(&2_u16.to_be_bytes());
        update.extend_from_slice(&2_u16.to_be_bytes());
        update.extend_from_slice(&0_i32.to_be_bytes());
        for index in 0..4_u8 {
            update.extend_from_slice(&[index + 1, index + 2, index + 3, 0]);
        }
        socket.write_all(&update).unwrap();

        // 울타리를 request 비트와 함께 보낸다. 답하지 않으면 실서버는 갱신을 멈춘다.
        let mut fence = vec![248_u8, 0, 0, 0];
        fence.extend_from_slice(&(1_u32 << 31 | 1).to_be_bytes());
        fence.push(4);
        fence.extend_from_slice(b"ping");
        socket.write_all(&fence).unwrap();

        // 시간 제한을 먼저 걸어 둔다. 답하지 않는 회귀가 생겼을 때 여기서 영원히 막히면 CI 는
        // 실패가 아니라 **정지**로 끝나 원인을 알 수 없다.
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .ok();
        let mut reply = [0_u8; 9];
        socket
            .read_exact(&mut reply)
            .expect("울타리 응답이 와야 한다 — 답하지 않으면 서버가 갱신을 멈춘 채 기다린다");
        assert_eq!(reply[0], 248, "울타리 응답이어야 한다");
        let mut payload = vec![0_u8; usize::from(reply[8])];
        socket.read_exact(&mut payload).unwrap();
        tx.send(Seen::FenceReply {
            flags: u32::from_be_bytes([reply[4], reply[5], reply[6], reply[7]]),
            payload,
        })
        .ok();

        // 이 뒤로는 아무것도 오지 않아야 한다 — 연속 갱신이 켜져 있으면 요청을 보내지 않는다.
        let mut rest = Vec::new();
        let mut buffer = [0_u8; 64];
        socket
            .set_read_timeout(Some(Duration::from_millis(600)))
            .ok();
        while let Ok(read) = socket.read(&mut buffer) {
            if read == 0 {
                break;
            }
            rest.extend_from_slice(&buffer[..read]);
        }
        tx.send(Seen::AfterContinuousUpdates(rest)).ok();
    });

    (port, rx)
}

/// ARD(보안 타입 30)를 요구하는 서버. macOS 화면 공유가 이 경로다.
///
/// **순서 자체가 규격이다.** generator·keyLength·modulus·serverPublic 을 보내고, 클라이언트가
/// `암호화된 자격증명(128) + 공개키(keyLength)` 를 그 순서로 보내야 한다. 하나라도 뒤집히면 서버는
/// "비밀번호가 틀렸다" 만 말하므로 단위 테스트로는 잡히지 않는다.
fn spawn_ard_server() -> (u16, Receiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = channel();

    thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_nodelay(true).ok();

        socket.write_all(b"RFB 003.008\n").unwrap();
        let mut client_version = [0_u8; 12];
        socket.read_exact(&mut client_version).unwrap();

        // 보안 타입 30(ARD) 하나만 제시한다.
        socket.write_all(&[1, 30]).unwrap();
        let mut chosen = [0_u8; 1];
        socket.read_exact(&mut chosen).unwrap();
        assert_eq!(chosen[0], 30, "ARD 를 골라야 한다");

        // RFC 2409 Oakley Group 2(1024비트). macOS 가 쓰는 것과 같은 크기다.
        let modulus = BigNum::from_hex_str(
            "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74\
             020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437\
             4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED\
             EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF",
        )
        .unwrap();
        let key_len = modulus.to_vec().len();
        let generator = BigNum::from_u32(2).unwrap();
        let mut context = BigNumContext::new().unwrap();
        let mut private = BigNum::new().unwrap();
        private
            .rand(256, openssl::bn::MsbOption::MAYBE_ZERO, false)
            .unwrap();
        let mut public = BigNum::new().unwrap();
        public
            .mod_exp(&generator, &private, &modulus, &mut context)
            .unwrap();

        let mut head = Vec::new();
        head.extend_from_slice(&2_u16.to_be_bytes()); // generator
        head.extend_from_slice(&(key_len as u16).to_be_bytes());
        head.extend_from_slice(&modulus.to_vec_padded(key_len as i32).unwrap());
        head.extend_from_slice(&public.to_vec_padded(key_len as i32).unwrap());
        socket.write_all(&head).unwrap();

        // 자격증명 128바이트 + 공개키 key_len 바이트.
        let mut credentials = [0_u8; 128];
        socket.read_exact(&mut credentials).unwrap();
        let mut client_public = vec![0_u8; key_len];
        socket.read_exact(&mut client_public).unwrap();

        let mut shared = BigNum::new().unwrap();
        shared
            .mod_exp(
                &BigNum::from_slice(&client_public).unwrap(),
                &private,
                &modulus,
                &mut context,
            )
            .unwrap();
        let key = openssl::hash::hash(
            openssl::hash::MessageDigest::md5(),
            &shared.to_vec_padded(key_len as i32).unwrap(),
        )
        .unwrap();

        let cipher = openssl::symm::Cipher::aes_128_ecb();
        let mut crypter =
            openssl::symm::Crypter::new(cipher, openssl::symm::Mode::Decrypt, &key, None).unwrap();
        crypter.pad(false);
        let mut plain = vec![0_u8; credentials.len() + cipher.block_size()];
        let mut count = crypter.update(&credentials, &mut plain).unwrap();
        count += crypter.finalize(&mut plain[count..]).unwrap();
        plain.truncate(count);

        let field = |slot: &[u8]| {
            let end = slot.iter().position(|byte| *byte == 0).unwrap_or(slot.len());
            String::from_utf8_lossy(&slot[..end]).to_string()
        };
        tx.send(Seen::ArdCredentials {
            username: field(&plain[..64]),
            password: field(&plain[64..]),
        })
        .ok();

        socket.write_all(&0_u32.to_be_bytes()).unwrap(); // SecurityResult 성공

        // 여기까지 오면 인증은 끝났다. 화면은 이 테스트의 관심이 아니라 최소만 보낸다.
        let mut shared_flag = [0_u8; 1];
        socket.read_exact(&mut shared_flag).unwrap();
        let mut init = Vec::new();
        init.extend_from_slice(&2_u16.to_be_bytes());
        init.extend_from_slice(&2_u16.to_be_bytes());
        init.extend_from_slice(&PixelFormat::rgba32().to_bytes());
        init.extend_from_slice(&4_u32.to_be_bytes());
        init.extend_from_slice(b"mac1");
        socket.write_all(&init).unwrap();

        // 클라이언트가 끊을 때까지 읽어 준다(파이프가 차면 코어가 쓰기에서 멈춘다).
        let mut buffer = [0_u8; 256];
        socket
            .set_read_timeout(Some(Duration::from_millis(800)))
            .ok();
        while let Ok(read) = socket.read(&mut buffer) {
            if read == 0 {
                break;
            }
        }
    });

    (port, rx)
}

fn read_update_request(socket: &mut TcpStream) -> bool {
    let mut message = [0_u8; 10];
    socket.read_exact(&mut message).unwrap();
    assert_eq!(message[0], 3, "FramebufferUpdateRequest 여야 한다");
    message[1] != 0
}

/// 세션을 띄우고 (조인 핸들, 닫기 신호, 세션 손잡이) 를 돌려준다.
///
/// 세션 손잡이가 필요한 이유는 입력을 넣어 봐야 하는 테스트가 있기 때문이다 — 입력 경로는 세션
/// 스레드가 통로를 혼자 쥐는 구조라 손잡이 없이는 건드릴 수 없다.
fn run_session(
    port: u16,
    password: &str,
    collected: Collected,
) -> (thread::JoinHandle<()>, Sender<()>, Receiver<session::SessionHandle>) {
    run_session_as(port, password, "", collected)
}

/// 계정까지 지정해 세션을 띄운다. ARD·VeNCrypt Plain 처럼 계정을 쓰는 방식용이다.
fn run_session_as(
    port: u16,
    password: &str,
    username: &str,
    collected: Collected,
) -> (thread::JoinHandle<()>, Sender<()>, Receiver<session::SessionHandle>) {
    let output = Output::with_writer(collected);
    let payload = ConnectPayload {
        host: "127.0.0.1".to_owned(),
        port,
        password: password.to_owned(),
        username: username.to_owned(),
        image_quality: String::new(),
        shared: true,
        tunnel_auth_token: None,
    };
    let (close_tx, close_rx) = channel::<()>();
    let (handle_tx, handle_rx) = channel::<session::SessionHandle>();
    let joined = thread::spawn(move || {
        let _ = session::run(
            "sess-1".to_owned(),
            "req-1".to_owned(),
            payload,
            output,
            move |handle| {
                handle_tx.send(handle.clone()).ok();
                // 세션이 등록되면 닫기 신호를 기다리는 스레드를 붙인다.
                thread::spawn(move || {
                    if close_rx.recv().is_ok() {
                        handle.close();
                    }
                });
            },
        );
    });
    (joined, close_tx, handle_rx)
}

/// 인사도 보내지 않는 서버. 클라이언트를 협상 첫 읽기에 붙잡아 둔다.
///
/// 붙은 순간을 알려 준다 — 그 전에 닫으면 취소가 dial 단계에서 걸려 협상 중 취소를 시험하지
/// 못한다(실제로 그렇게 됐다).
fn spawn_silent_server() -> (u16, Receiver<()>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (accepted_tx, accepted_rx) = channel();
    let joined = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        accepted_tx.send(()).ok();
        // 아무것도 보내지 않는다. 클라이언트가 끊으면 이쪽 읽기도 끝난다.
        let mut sink = [0_u8; 1];
        let _ = socket.read(&mut sink);
    });
    (port, accepted_rx, joined)
}

/// **연결이 끝나기 전에 닫아도 취소가 통해야 한다.**
///
/// 예전에는 협상까지 다 끝낸 뒤에야 세션을 등록했다. 그래서 그 사이에 사용자가 탭을 닫으면
/// `disconnectVnc` 가 등록표에서 아무것도 찾지 못했고(취소가 사라진다), 세션은 계속 붙어서 탭도
/// 없는 채로 남았다. 이 테스트는 두 가지를 본다: 붙는 도중에도 **핸들을 받을 수 있는지**, 그리고
/// 닫으면 협상 타임아웃을 기다리지 않고 **바로 끝나는지**.
#[test]
fn closing_during_the_handshake_cancels_the_session() {
    let (port, accepted, server) = spawn_silent_server();
    let collected = Collected::default();
    let (session, _close, handles) = run_session(port, "", collected.clone());

    // 협상이 끝나지 않았는데도 핸들이 와야 한다 — 예전 순서에서는 영영 오지 않았다.
    let handle = handles
        .recv_timeout(Duration::from_secs(3))
        .expect("붙는 도중에도 세션이 등록돼야 한다");
    // 붙은 뒤에 닫아야 "협상 중 취소" 가 된다.
    accepted
        .recv_timeout(Duration::from_secs(3))
        .expect("서버가 접속을 받아야 한다");

    let started = Instant::now();
    handle.close();
    session.join().expect("세션 스레드");

    assert!(
        started.elapsed() < Duration::from_secs(5),
        "닫으면 협상 타임아웃을 기다리지 않고 끝나야 한다"
    );

    // 사용자가 닫은 것이라 오류가 아니다. closed 하나로 끝난다.
    let kinds: Vec<String> = collected
        .frames(1)
        .iter()
        .map(|frame| metadata(frame)["type"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert!(kinds.contains(&"closed".to_owned()), "closed 가 와야 한다: {kinds:?}");
    assert!(
        !kinds.contains(&"error".to_owned()),
        "닫은 세션에 오류를 올리면 안 된다: {kinds:?}"
    );

    server.join().expect("가짜 서버");
}

#[test]
fn negotiates_and_delivers_the_first_screen() {
    let (port, seen) = spawn_server(1, true);
    let collected = Collected::default();
    let (session, close, _handles) = run_session(port, "", collected.clone());

    // connected 이벤트 + 픽셀 프레임. 사이에 다른 제어 이벤트(capabilities)가 끼므로 **종류로**
    // 찾는다 — 순번으로 집으면 이벤트를 하나 더 보낼 때마다 이 테스트가 깨진다.
    let frames = collected.frames(3);
    assert!(frames.len() >= 2, "프레임이 두 개는 와야 한다: {frames:?}");

    let connected_frame = frames
        .iter()
        .find(|frame| frame.kind == KIND_CONTROL && metadata(frame)["type"] == "connected")
        .expect("connected 이벤트가 있어야 한다");
    let connected = metadata(connected_frame);
    assert_eq!(connected["type"], "connected");
    assert_eq!(connected["sessionId"], "sess-1");
    assert_eq!(connected["requestId"], "req-1");
    assert_eq!(connected["payload"]["desktopWidth"], 2);
    assert_eq!(connected["payload"]["desktopHeight"], 2);
    assert_eq!(connected["payload"]["name"], "fake");

    let frame = frames
        .iter()
        .find(|frame| frame.kind == KIND_STREAM)
        .expect("픽셀 프레임이 있어야 한다");
    let meta = metadata(frame);
    assert_eq!(meta["type"], "vncFrame");
    assert_eq!((meta["x"].as_u64(), meta["y"].as_u64()), (Some(0), Some(0)));
    assert_eq!(
        (meta["width"].as_u64(), meta["height"].as_u64()),
        (Some(2), Some(2))
    );
    // 서버가 패딩을 0 으로 보냈어도 알파는 255 로 채워져야 한다 — 아니면 화면이 투명해진다.
    assert_eq!(
        frame.payload,
        vec![1, 2, 3, 255, 2, 3, 4, 255, 3, 4, 5, 255, 4, 5, 6, 255]
    );

    // 우리가 요구한 포맷과 인코딩 목록, 그리고 갱신 요청 순서를 서버 쪽에서 확인한다.
    let mut requests = Vec::new();
    while let Ok(item) = seen.recv_timeout(Duration::from_secs(5)) {
        match item {
            Seen::SetPixelFormat(format) => assert!(
                format.is_rgba32(),
                "캔버스와 같은 바이트 순서를 요구해야 한다: {format:?}"
            ),
            Seen::Encodings(list) => {
                assert!(list.contains(&0), "Raw 는 필수다");
                assert!(list.contains(&1), "CopyRect");
                assert!(list.contains(&-223), "DesktopSize");
                assert!(list.contains(&16), "ZRLE");
                // **해독할 수 있는 것만 요청한다.** 목록에 넣으면 서버가 그것으로 보내므로, 아직
                // 없는 디코더를 광고하면 첫 화면부터 끊긴다.
                assert!(list.contains(&7), "Tight");
                assert!(!list.contains(&5), "Hextile 은 아직 없다");
                // 선호도는 순서다. ZRLE 가 Raw 보다 앞이어야 서버가 압축을 고른다.
                let zrle = list.iter().position(|value| *value == 16);
                let raw = list.iter().position(|value| *value == 0);
                assert!(zrle < raw, "ZRLE 가 Raw 보다 앞이어야 한다: {list:?}");
            }
            Seen::UpdateRequest { incremental } => requests.push(incremental),
            // 이 서버는 확장을 쓰지 않으므로 나머지는 오지 않는다.
            _ => break,
        }
        if requests.len() >= 2 {
            break;
        }
    }
    assert_eq!(
        requests,
        vec![false, true],
        "첫 요청은 전체, 그다음은 증분이어야 한다"
    );

    let _ = close.send(());
    session.join().unwrap();
}

#[test]
fn vnc_auth_password_is_accepted_by_a_server_that_checks_it() {
    let (port, _seen) = spawn_server(2, true);
    let collected = Collected::default();
    let (session, close, _handles) = run_session(port, "hunter2", collected.clone());

    let frames = collected.frames(1);
    let connected = metadata(&frames[0]);
    assert_eq!(
        connected["type"], "connected",
        "VncAuth 로 붙어야 한다: {frames:?}"
    );

    let _ = close.send(());
    session.join().unwrap();
}

// 서버가 붙인 사유가 사용자에게 도달해야 한다. 이게 없으면 "붙지 않는다" 밖에 말할 수 없다.
#[test]
fn surfaces_the_servers_authentication_failure_reason() {
    let (port, _seen) = spawn_server(2, false);
    let collected = Collected::default();
    let (session, _close, _handles) = run_session(port, "hunter2", collected.clone());

    let frames = collected.frames(1);
    let error = metadata(&frames[0]);
    assert_eq!(error["type"], "error");
    let message = error["payload"]["message"].as_str().unwrap();
    assert!(
        message.contains("authentication failed"),
        "서버 사유가 담겨야 한다: {message}"
    );

    session.join().unwrap();
}

// 포인터는 상태 기반이다. 버튼을 누른 채 움직이면 그 버튼이 마스크에 남아 있어야 한다 — 안 그러면
// 원격에서 드래그가 풀린다.
#[test]
fn pointer_state_carries_the_pressed_button_into_later_moves() {
    let (port, seen) = spawn_server(1, true);
    let collected = Collected::default();
    let output = Output::with_writer(collected.clone());
    let payload = ConnectPayload {
        host: "127.0.0.1".to_owned(),
        port,
        password: String::new(),
        username: String::new(),
        image_quality: String::new(),
        shared: true,
        tunnel_auth_token: None,
    };
    let (handle_tx, handle_rx) = channel();
    let session = thread::spawn(move || {
        let _ = session::run(
            "sess-1".to_owned(),
            "req-1".to_owned(),
            payload,
            output,
            move |handle| {
                handle_tx.send(handle).ok();
            },
        );
    });

    let handle = handle_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    // 첫 화면이 도착한 뒤에 입력을 보낸다(가짜 서버가 그 순서로 읽는다).
    collected.frames(2);
    handle
        .send_input(&[
            InputEvent::MouseButton {
                button: 0,
                pressed: true,
                x: 1,
                y: 1,
            },
            InputEvent::MouseMove { x: 2, y: 2 },
        ])
        .unwrap();

    let mut input = Vec::new();
    while let Ok(item) = seen.recv_timeout(Duration::from_secs(5)) {
        if let Seen::Input(bytes) = item {
            input = bytes;
            break;
        }
    }
    assert!(input.len() >= 12, "포인터 이벤트 두 개: {input:?}");
    // 누름: 마스크에 왼쪽 버튼(0b1)
    assert_eq!(&input[0..6], &[5, 1, 0, 1, 0, 1]);
    // 이동: 버튼이 눌린 상태가 유지돼야 한다.
    assert_eq!(&input[6..12], &[5, 1, 0, 2, 0, 2]);

    handle.close();
    session.join().unwrap();
}

/// 확장 세 가지를 한 번에 본다: 선언 → 커서 → 연속 갱신 → 울타리.
///
/// **선언은 이 테스트에서만 와이어로 확인된다.** 상수에 값을 넣어도 SetEncodings 에 싣지 않으면
/// 아무 확장도 켜지지 않는데, 그 상태로도 컴파일과 단위 테스트는 전부 통과한다(실제로 확장
/// 클립보드가 그랬다).
#[test]
fn negotiates_the_cursor_continuous_updates_and_fence_extensions() {
    let (port, seen) = spawn_extension_server();
    let collected = Collected::default();
    let (session, close, handles) = run_session(port, "", collected.clone());

    let Seen::Encodings(encodings) = seen.recv().unwrap() else {
        panic!("첫 관찰은 인코딩 목록이어야 한다");
    };
    // 번호를 손으로 적는다 — 코드의 상수를 그대로 쓰면 상수가 틀렸을 때 같이 틀린다. 실제로
    // 여기 확장 클립보드를 `-1063` 으로 적어 뒀었고(규격은 `0xc0a1e5ce` = -1063131698), 코드도
    // 같은 값이어서 이 테스트가 통과했다. 그 결과 어느 서버도 우리 선언을 알아보지 못했다.
    // 출처: RFB 규격 / TigerVNC rfbproto.h.
    for (value, name) in [
        (0xc0a1_e5ceu32 as i32, "확장 클립보드"),
        (-239, "커서"),
        (-312, "울타리"),
        (-313, "연속 갱신"),
    ] {
        assert!(
            encodings.contains(&value),
            "{name}({value}) 를 선언하지 않으면 서버는 그 확장을 시작하지 않는다: {encodings:?}"
        );
    }

    let Seen::UpdateRequest { incremental } = seen.recv().unwrap() else {
        panic!("첫 갱신 요청이 와야 한다");
    };
    assert!(!incremental, "첫 요청은 전체여야 한다");

    // EndOfContinuousUpdates 를 본 뒤에만 켜는 메시지를 보낸다.
    let Seen::EnableContinuousUpdates {
        enable,
        width,
        height,
    } = seen.recv().unwrap()
    else {
        panic!("연속 갱신을 켜야 한다");
    };
    assert!(enable);
    assert_eq!((width, height), (2, 2), "켜는 영역은 화면 전체여야 한다");

    // 울타리에 답해야 한다 — 답하지 않는 클라이언트는 서버가 갱신을 멈춘 채 기다린다.
    let Seen::FenceReply { flags, payload } = seen.recv().unwrap() else {
        panic!("울타리에 답해야 한다");
    };
    assert_eq!(payload, b"ping", "payload 는 그대로 돌려줘야 한다");
    assert_eq!(flags, 0, "지키지 못할 flags 를 세워 답하지 않는다");

    // 커서 모양이 stream frame 으로 올라온다.
    let frames = collected.frames(5);
    let cursor = frames
        .iter()
        .find(|frame| metadata(frame)["type"] == "vncCursor")
        .expect("커서 프레임이 있어야 한다");
    let meta = metadata(cursor);
    assert_eq!(meta["hotspotX"], 1);
    assert_eq!(meta["hotspotY"], 0);
    assert_eq!((meta["width"].as_u64(), meta["height"].as_u64()), (Some(2), Some(1)));
    // 마스크가 0 인 픽셀은 알파가 0 이어야 한다. 안 그러면 커서 바깥이 검은 사각형으로 남는다.
    assert_eq!(cursor.payload, vec![9, 8, 7, 0xFF, 6, 5, 4, 0x00]);

    // 화면도 그대로 온다(커서 사각형이 프레임 경계를 어긋내지 않았다는 증거다).
    assert!(
        frames
            .iter()
            .any(|frame| metadata(frame)["type"] == "vncFrame"),
        "화면 프레임도 와야 한다: {frames:?}"
    );

    // 협상 결과가 데스크톱까지 올라가야 탭 hover 가 그것을 보여줄 수 있다.
    const CAPABILITY_KIND: &str = "capabilities";
    let latest = frames
        .iter()
        .filter(|frame| metadata(frame)["type"] == CAPABILITY_KIND)
        .next_back()
        .map(metadata);
    let capabilities = latest.expect("capabilities 이벤트가 있어야 한다");
    let payload = &capabilities["payload"];
    assert_eq!(payload["cursor"], true, "커서 사각형을 받았으니 켜져 있어야 한다");
    assert_eq!(payload["continuousUpdates"], true);
    assert_eq!(payload["encoding"], "raw", "이 서버는 Raw 로 보냈다");
    assert_eq!(payload["extendedClipboard"], false, "이 서버는 caps 를 보내지 않았다");

    // 서버가 QEMU 확장 키 사각형을 보냈으니, 스캔코드가 있는 키는 그 메시지로 나가야 한다.
    let handle = handles.recv().unwrap();
    // 이 서버는 확장 클립보드 caps 를 보내지 않았다 → 고전 latin-1 경로다. 한글을 보내면 담을 수
    // 없는 글자를 셌다고 알려야 한다(알리지 않으면 사용자는 원격의 `?` 만 보고 이유를 모른다).
    handle.send_clipboard("한글 abc".to_owned()).unwrap();
    handle
        .send_input(&[InputEvent::Key {
            keysym: 0xFF0D,
            pressed: true,
            keycode: 0x1C,
        }])
        .unwrap();

    let Seen::AfterContinuousUpdates(rest) = seen.recv().unwrap() else {
        panic!("나머지 바이트를 받아야 한다");
    };
    assert!(
        !rest.contains(&3),
        "연속 갱신이 켜진 뒤에는 갱신 요청(3)을 보내지 않아야 한다: {rest:?}"
    );
    let qemu_key = [255, 0, 0, 1, 0, 0, 0xFF, 0x0D, 0, 0, 0, 0x1C];
    assert!(
        rest.ends_with(&qemu_key),
        "keysym 만 담은 고전 KeyEvent(4) 가 아니라 스캔코드가 실린 QEMU 메시지여야 한다: {rest:?}"
    );
    // 그 앞은 고전 ClientCutText 다. 담을 수 없는 한글이 `?`(0x3F) 로 바뀐 것이 와이어에 보인다 —
    // 확장을 쓰지 않는 서버에서 무엇이 실제로 나가는지가 여기서 드러난다.
    assert_eq!(
        &rest[..rest.len() - qemu_key.len()],
        &[6, 0, 0, 0, 0, 0, 0, 6, 0x3F, 0x3F, b' ', b'a', b'b', b'c'],
        "고전 경로는 latin-1 이라 한글이 ? 로 나간다: {rest:?}"
    );

    let lossy = collected
        .frames(9)
        .iter()
        .map(metadata)
        .find(|meta| meta["type"] == "clipboardLossy");
    assert_eq!(
        lossy.map(|meta| meta["payload"]["replaced"].as_u64()),
        Some(Some(2)),
        "한글 두 글자가 바뀌었다고 알려야 한다"
    );

    close.send(()).ok();
    session.join().unwrap();
}

/// notify 를 아는 서버(TigerVNC)에는 **notify → request → provide** 로 간다.
///
/// 이 순서가 규격의 게으른 흐름이고, **건너뛰면 붙여넣기가 조용히 안 된다** — TigerVNC 서버는
/// announce(notify) 없이 받은 provide 데이터를 버린다(SConnection::handleClipboardProvide →
/// VNCServerST 가 clipboardClient 가 아닌 데이터를 무시한다). 실측으로 확인했다: notify 없이
/// provide 만 보내면 원격 선택 영역의 소유자조차 없다.
#[test]
fn announces_with_notify_then_provides_on_request() {
    // TigerVNC 가 알리는 조합: request·peek·notify·provide.
    let advertise = (1 << 25) | (1 << 26) | (1 << 27) | (1 << 28);
    let (port, seen) = spawn_extended_clipboard_server(advertise, true);
    let collected = Collected::default();
    let (session, close, handles) = run_session(port, "", collected.clone());

    let Seen::Encodings(encodings) = seen.recv().unwrap() else {
        panic!("첫 관찰은 인코딩 목록이어야 한다");
    };
    // 이 서버는 목록에서 규격 번호를 본 뒤에만 caps 를 보낸다(실서버와 같은 조건).
    assert!(
        encodings.contains(&(0xc0a1_e5ceu32 as i32)),
        "확장 클립보드 번호(0xc0a1e5ce)가 없으면 서버는 caps 를 보내지 않는다: {encodings:?}"
    );
    let Seen::UpdateRequest { .. } = seen.recv().unwrap() else {
        panic!("첫 갱신 요청이 와야 한다");
    };

    let handle = handles.recv().unwrap();
    handle.send_clipboard("한글 abc".to_owned()).unwrap();

    // 1) 우리 caps. 지원 동작을 비워 보내면 TigerVNC 가 연결을 끊는다(우분투 VM 실측).
    let Seen::ExtendedCutText(ours) = seen.recv().unwrap() else {
        panic!("우리 caps 가 확장 메시지로 나가야 한다");
    };
    let flags = u32::from_be_bytes([ours[0], ours[1], ours[2], ours[3]]);
    assert_ne!(flags & (1 << 24), 0, "첫 확장 메시지는 caps(1<<24) 여야 한다: {flags:#x}");
    assert_ne!(flags & 0x0000_0001, 0, "텍스트 형식을 지원한다고 알려야 한다");
    for (bit, name) in [(1 << 25, "request"), (1 << 27, "notify"), (1 << 28, "provide")] {
        assert_ne!(flags & bit, 0, "{name} 를 알려야 한다: {flags:#x}");
    }

    // 2) 텍스트 자체가 아니라 notify 가 먼저 나가야 한다.
    let Seen::ExtendedCutText(notify) = seen.recv().unwrap() else {
        panic!("notify 가 나가야 한다");
    };
    let flags = u32::from_be_bytes([notify[0], notify[1], notify[2], notify[3]]);
    assert_ne!(flags & (1 << 27), 0, "notify(1<<27) 여야 한다: {flags:#x}");
    assert_eq!(notify.len(), 4, "notify 본문은 flags 뿐이다");

    // 3) 서버가 request 로 답하면 그때 provide 를 보낸다.
    let Seen::ExtendedCutText(provide) = seen.recv().unwrap() else {
        panic!("request 를 받으면 provide 로 답해야 한다");
    };
    let flags = u32::from_be_bytes([provide[0], provide[1], provide[2], provide[3]]);
    assert_ne!(flags & (1 << 28), 0, "provide(1<<28) 동작이어야 한다: {flags:#x}");
    assert_eq!(text_from_provide(&provide), "한글 abc");

    close.send(()).ok();
    session.join().unwrap();
}

/// notify 를 모르는 서버(x11vnc)에는 **고전을 먼저 보내고 확장도 보낸다.**
///
/// x11vnc 는 caps 에 provide 를 알리면서도 받은 확장 데이터를 버린다(setXCutTextUTF8 훅이 붙어
/// 있지 않다 — 실측: 확장만 보내면 선택 영역이 비어 있고, 고전으로 보내면 들어간다). 그래서
/// 고전이 앞이어야 영문이 동작하고, 확장이 뒤여야 제대로 적용하는 구현에서 UTF-8 이 이긴다.
#[test]
fn falls_back_to_classic_first_when_the_server_has_no_notify() {
    // x11vnc 가 알리는 조합: request·peek·provide (notify 없음).
    let advertise = (1 << 25) | (1 << 26) | (1 << 28);
    let (port, seen) = spawn_extended_clipboard_server(advertise, false);
    let collected = Collected::default();
    let (session, close, handles) = run_session(port, "", collected.clone());

    let Seen::Encodings(_) = seen.recv().unwrap() else {
        panic!("첫 관찰은 인코딩 목록이어야 한다");
    };
    let Seen::UpdateRequest { .. } = seen.recv().unwrap() else {
        panic!("첫 갱신 요청이 와야 한다");
    };

    let handle = handles.recv().unwrap();
    handle.send_clipboard("한글 abc".to_owned()).unwrap();

    let Seen::ExtendedCutText(caps) = seen.recv().unwrap() else {
        panic!("우리 caps 가 먼저 나가야 한다");
    };
    let flags = u32::from_be_bytes([caps[0], caps[1], caps[2], caps[3]]);
    assert_ne!(flags & (1 << 24), 0, "caps 여야 한다: {flags:#x}");

    // 고전 ClientCutText 가 먼저(가짜 서버는 확장만 넘겨주므로, 다음 확장 메시지가 provide 라는
    // 사실과 손실 알림으로 고전이 나갔음을 확인한다).
    let Seen::ExtendedCutText(provide) = seen.recv().unwrap() else {
        panic!("확장 provide 도 보내야 한다");
    };
    let flags = u32::from_be_bytes([provide[0], provide[1], provide[2], provide[3]]);
    assert_ne!(flags & (1 << 28), 0, "provide 여야 한다: {flags:#x}");
    assert_eq!(text_from_provide(&provide), "한글 abc");

    // 고전으로도 보냈으므로 그 경로에서 바뀐 글자 수를 알린다 — 확장을 버리는 서버에서 사용자가
    // `?` 를 보는 이유가 이 알림이다.
    let lossy = collected
        .frames(6)
        .iter()
        .map(metadata)
        .find(|meta| meta["type"] == "clipboardLossy");
    assert_eq!(
        lossy.map(|meta| meta["payload"]["replaced"].as_u64()),
        Some(Some(2)),
        "한글 두 글자가 고전 경로에서 바뀌었다고 알려야 한다"
    );

    close.send(()).ok();
    session.join().unwrap();
}

/// provide 본문(zlib) 에서 텍스트를 되돌린다.
fn text_from_provide(provide: &[u8]) -> String {
    let mut plain = Vec::new();
    flate2::read::ZlibDecoder::new(&provide[4..])
        .read_to_end(&mut plain)
        .expect("provide 본문은 zlib 스트림이어야 한다");
    let size = u32::from_be_bytes([plain[0], plain[1], plain[2], plain[3]]) as usize;
    // 규격이 와이어에서 CRLF 를 쓰라고 정했다. 로컬로 되돌릴 때 LF 로 바꾼다.
    String::from_utf8(plain[4..4 + size].to_vec())
        .expect("UTF-8 이어야 한다")
        .replace("\r\n", "\n")
}

/// macOS 화면 공유 경로. 계정과 비밀번호가 **함께** 암호화되어 가는지, 순서가 맞는지 본다.
#[test]
fn authenticates_with_apple_remote_desktop() {
    let (port, seen) = spawn_ard_server();
    let collected = Collected::default();
    let (session, close, _handles) =
        run_session_as(port, "긴-비밀번호-8자넘음", "operator", collected.clone());

    let Seen::ArdCredentials { username, password } = seen.recv().unwrap() else {
        panic!("ARD 자격증명을 받아야 한다");
    };
    assert_eq!(username, "operator");
    // VncAuth 라면 8바이트로 잘렸을 값이다. ARD 는 그 제약이 없다.
    assert_eq!(password, "긴-비밀번호-8자넘음");

    // 인증이 통과하면 connected 이벤트가 올라온다.
    let connected = collected
        .frames(2)
        .iter()
        .map(metadata)
        .find(|meta| meta["type"] == "connected");
    assert_eq!(
        connected.map(|meta| meta["payload"]["name"].as_str().map(str::to_owned)),
        Some(Some("mac1".to_owned())),
        "ARD 인증 뒤 세션이 붙어야 한다"
    );

    close.send(()).ok();
    session.join().unwrap();
}

/// 계정 없이 ARD 서버에 붙으면 무엇을 해야 하는지 말해 줘야 한다.
#[test]
fn explains_that_apple_remote_desktop_needs_an_account() {
    let (port, _seen) = spawn_ard_server();
    let collected = Collected::default();
    let (session, close, _handles) = run_session(port, "비밀번호", collected.clone());

    let error = collected
        .frames(1)
        .iter()
        .map(metadata)
        .find(|meta| meta["type"] == "error")
        .and_then(|meta| meta["payload"]["message"].as_str().map(str::to_owned))
        .unwrap_or_default();
    assert!(
        error.contains("계정"),
        "계정이 필요하다고 알려야 한다: {error}"
    );
    // 이 서버는 VncAuth 를 제시하지 않았으므로 "계정을 비우면 VNC 암호로" 안내는 나오지 않아야
    // 한다 — 그 길이 없는데 알려주면 사용자가 없는 설정을 찾는다.
    assert!(!error.contains("VNC 암호"), "{error}");

    close.send(()).ok();
    session.join().unwrap();
}
