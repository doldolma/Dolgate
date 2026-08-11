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
            if rest.len() >= 6 {
                break;
            }
        }
        tx.send(Seen::Input(rest)).ok();
    });

    (port, rx)
}

fn read_update_request(socket: &mut TcpStream) -> bool {
    let mut message = [0_u8; 10];
    socket.read_exact(&mut message).unwrap();
    assert_eq!(message[0], 3, "FramebufferUpdateRequest 여야 한다");
    message[1] != 0
}

fn run_session(port: u16, password: &str, collected: Collected) -> (thread::JoinHandle<()>, Sender<()>) {
    let output = Output::with_writer(collected);
    let payload = ConnectPayload {
        host: "127.0.0.1".to_owned(),
        port,
        password: password.to_owned(),
        shared: true,
    };
    let (close_tx, close_rx) = channel::<()>();
    let handle = thread::spawn(move || {
        let _ = session::run(
            "sess-1".to_owned(),
            "req-1".to_owned(),
            payload,
            output,
            move |handle| {
                // 세션이 등록되면 닫기 신호를 기다리는 스레드를 붙인다.
                thread::spawn(move || {
                    if close_rx.recv().is_ok() {
                        handle.close();
                    }
                });
            },
        );
    });
    (handle, close_tx)
}

#[test]
fn negotiates_and_delivers_the_first_screen() {
    let (port, seen) = spawn_server(1, true);
    let collected = Collected::default();
    let (session, close) = run_session(port, "", collected.clone());

    // connected 이벤트 + 픽셀 프레임.
    let frames = collected.frames(2);
    assert!(frames.len() >= 2, "프레임이 두 개는 와야 한다: {frames:?}");

    let connected = metadata(&frames[0]);
    assert_eq!(frames[0].kind, KIND_CONTROL);
    assert_eq!(connected["type"], "connected");
    assert_eq!(connected["sessionId"], "sess-1");
    assert_eq!(connected["requestId"], "req-1");
    assert_eq!(connected["payload"]["desktopWidth"], 2);
    assert_eq!(connected["payload"]["desktopHeight"], 2);
    assert_eq!(connected["payload"]["name"], "fake");

    let frame = &frames[1];
    assert_eq!(frame.kind, KIND_STREAM);
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
                assert!(!list.contains(&7), "Tight 는 아직 없다");
                assert!(!list.contains(&5), "Hextile 은 아직 없다");
                // 선호도는 순서다. ZRLE 가 Raw 보다 앞이어야 서버가 압축을 고른다.
                let zrle = list.iter().position(|value| *value == 16);
                let raw = list.iter().position(|value| *value == 0);
                assert!(zrle < raw, "ZRLE 가 Raw 보다 앞이어야 한다: {list:?}");
            }
            Seen::UpdateRequest { incremental } => requests.push(incremental),
            Seen::Input(_) => break,
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
    let (session, close) = run_session(port, "hunter2", collected.clone());

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
    let (session, _close) = run_session(port, "hunter2", collected.clone());

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
        shared: true,
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
