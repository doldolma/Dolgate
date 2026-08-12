//! 헤드리스 진단 하네스. 데스크톱 없이 실제 서버에 붙어 화면을 파일로 뽑는다.
//!
//! **왜 필요한가:** 프로토콜 구현의 실패는 대개 "붙었는데 화면이 이상하다" 로만 나타난다. 그것을
//! 앱에서 눈으로 좇으면 원인을 좁힐 수 없다. 이 도구는 사이드카가 실제로 받은 것을 그대로
//! 보여준다 — 어떤 인증을 골랐고, 사각형이 몇 개 어떤 인코딩으로 왔고, 화면이 실제로 채워졌는지.
//!
//! rdp-core 를 GUI 없이 몰아 보는 하네스와 같은 생각이다.
//!
//! ```text
//! cargo run --bin vnc-probe -- 127.0.0.1:5904 vncpass out.ppm
//! ```
//!
//! 출력은 PPM(P6)이다 — 의존성 없이 쓸 수 있고 macOS 는 `qlmanage -t`·`sips` 로 바로 본다.

use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use core_framing::{read_frame, KIND_STREAM};
use vnc_core::output::Output;
use vnc_core::protocol::ConnectPayload;
use vnc_core::session;

/// 하네스가 프레임을 모으는 곳.
///
/// 알림 채널을 쓰지 않고 길이만 본다. write_frame 이 한 프레임을 여러 번 write 로 나눠 쓰므로
/// 알림이 프레임 수보다 많이 쌓이고, 그러면 "조용해졌다" 판정이 첫 이벤트 직후에 성립해 화면이
/// 오기 전에 빠져나온다(실제로 그렇게 0개를 봤다).
#[derive(Clone)]
struct Sink {
    buffer: Arc<Mutex<Vec<u8>>>,
}

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.buffer.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct Screen {
    width: u16,
    height: u16,
    pixels: Vec<u8>,
    /// 채워진 좌표를 세어 "화면이 실제로 왔는지" 를 판정한다.
    painted: usize,
}

fn main() {
    let mut args = std::env::args().skip(1);
    let target = args.next().unwrap_or_else(|| {
        eprintln!("사용법: vnc-probe <host:port> [password] [out.ppm]");
        std::process::exit(2);
    });
    let password = args.next().unwrap_or_default();
    let out_path = args.next();

    let (host, port) = match target.rsplit_once(':') {
        Some((host, port)) => (host.to_owned(), port.parse::<u16>().unwrap_or(5900)),
        None => (target.clone(), 5900),
    };

    // 코어의 진단을 그대로 본다. 인코딩별 계수가 여기로 나온다 — 이 도구의 존재 이유다.
    tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("DOLGATE_VNC_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("vnc_core=debug")),
        )
        .init();

    let sink = Sink {
        buffer: Arc::new(Mutex::new(Vec::new())),
    };
    let output = Output::with_writer(sink.clone());

    let payload = ConnectPayload {
        host: host.clone(),
        port,
        password,
        // VeNCrypt Plain 계열은 계정으로 인증한다. 계정을 넘길 방법이 없으면 그 조합을 아예
        // 검증할 수 없다 — 실제로 TLSPlain 서버를 "실패" 로 잘못 읽었다.
        username: std::env::var("VNC_PROBE_USER").unwrap_or_default(),
        image_quality: String::new(),
        shared: true,
    };

    let session = thread::spawn(move || {
        if let Err(error) = session::run(
            "probe".to_owned(),
            "req".to_owned(),
            payload,
            output,
            |handle| {
                // 클립보드를 **여러 번** 보내 본다. 확장 클립보드는 provide 마다 zlib 스트림을
                // 새로 만드는지/이어 가는지가 갈리는 지점이라, 한 번만 보내면 그 차이가 드러나지
                // 않는다 — 실제로 "붙었다가 몇 초 뒤 끊김" 을 그렇게 놓쳤다.
                if let Ok(list) = std::env::var("VNC_PROBE_CLIP") {
                    let handle = handle.clone();
                    thread::spawn(move || {
                        for (index, text) in list.split(',').enumerate() {
                            thread::sleep(Duration::from_millis(1500));
                            eprintln!("[probe] 클립보드 전송 #{}: {text}", index + 1);
                            handle.send_clipboard(text.to_owned()).ok();
                        }
                    });
                }
            },
        ) {
            eprintln!("세션 오류: {error:#}");
        }
    });

    // 더 이상 바이트가 늘지 않으면 화면이 안정된 것으로 본다.
    //
    // **붙잡고 있어야 보이는 것이 있다.** 첫 화면을 받은 직후 종료하면 그 뒤에 끊기는 세션을
    // 정상으로 오판한다 — 실제로 확장 클립보드 결함을 그렇게 놓쳤다(화면은 왔고, 몇 초 뒤에
    // 서버가 끊었다). `VNC_PROBE_HOLD_SECS` 로 그 구간까지 지켜본다.
    let hold = std::env::var("VNC_PROBE_HOLD_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok());
    let quiet = match hold {
        Some(_) => Duration::from_secs(u64::MAX / 4),
        None => Duration::from_millis(1500),
    };
    let deadline = Instant::now() + Duration::from_secs(hold.unwrap_or(20));
    let mut screen: Option<Screen> = None;
    let mut encodings: HashMap<String, usize> = HashMap::new();
    let mut consumed = 0_usize;
    let mut bytes = 0_usize;
    let mut seen_len = 0_usize;
    let mut idle_since = Instant::now();

    loop {
        thread::sleep(Duration::from_millis(50));
        let snapshot = sink.buffer.lock().unwrap().clone();
        if snapshot.len() != seen_len {
            seen_len = snapshot.len();
            idle_since = Instant::now();
        }
        let mut cursor = &snapshot[consumed..];
        while let Ok(frame) = read_frame(&mut cursor) {
            consumed = snapshot.len() - cursor.len();
            let meta: serde_json::Value = serde_json::from_slice(&frame.metadata).unwrap();
            let kind = meta["type"].as_str().unwrap_or("?");
            if frame.kind == KIND_STREAM {
                bytes += frame.payload.len();
                *encodings.entry(kind.to_owned()).or_default() += 1;
                if let Some(screen) = screen.as_mut() {
                    paint(screen, &meta, &frame.payload);
                }
                continue;
            }
            match kind {
                "connected" => {
                    let width = meta["payload"]["desktopWidth"].as_u64().unwrap_or(0) as u16;
                    let height = meta["payload"]["desktopHeight"].as_u64().unwrap_or(0) as u16;
                    println!(
                        "connected  {width}x{height}  name={:?}",
                        meta["payload"]["name"].as_str().unwrap_or("")
                    );
                    screen = Some(Screen {
                        width,
                        height,
                        pixels: vec![0; usize::from(width) * usize::from(height) * 4],
                        painted: 0,
                    });
                }
                "resized" => println!(
                    "resized    {}x{}",
                    meta["payload"]["desktopWidth"], meta["payload"]["desktopHeight"]
                ),
                "error" => {
                    println!("error      {}", meta["payload"]["message"]);
                }
                "closed" => println!("closed"),
                other => println!("event      {other}"),
            }
        }
        if Instant::now() > deadline {
            break;
        }
        // 화면을 받기 시작한 뒤 조용해지면 끝낸다. 아직 아무것도 못 받았으면 기한까지 기다린다 —
        // 인증 실패처럼 이벤트 하나로 끝나는 경우도 그 이벤트를 남겨야 한다.
        if screen.is_some() && idle_since.elapsed() > quiet {
            break;
        }
        if screen.is_none() && idle_since.elapsed() > Duration::from_secs(3) {
            break;
        }
    }

    let rects: usize = encodings.values().sum();
    println!("사각형 {rects}개, 픽셀 {} KiB", bytes / 1024);
    if let Some(screen) = screen.as_ref() {
        let total = usize::from(screen.width) * usize::from(screen.height);
        println!(
            "채워진 픽셀 {}/{} ({:.0}%)",
            screen.painted,
            total,
            if total == 0 {
                0.0
            } else {
                screen.painted as f64 * 100.0 / total as f64
            }
        );
        if let Some(path) = out_path {
            write_ppm(&path, screen).expect("PPM 쓰기");
            println!("화면을 {path} 에 썼다");
        }
    }

    // 세션 스레드는 소켓에서 기다린다. 프로세스를 끝내면 같이 정리된다.
    drop(sink);
    let _ = session.join_timeout();
}

fn paint(screen: &mut Screen, meta: &serde_json::Value, payload: &[u8]) {
    let x = meta["x"].as_u64().unwrap_or(0) as usize;
    let y = meta["y"].as_u64().unwrap_or(0) as usize;
    let width = meta["width"].as_u64().unwrap_or(0) as usize;
    let height = meta["height"].as_u64().unwrap_or(0) as usize;
    let stride = usize::from(screen.width) * 4;
    for row in 0..height {
        let source = row * width * 4;
        let target = (y + row) * stride + x * 4;
        if target + width * 4 > screen.pixels.len() || source + width * 4 > payload.len() {
            break;
        }
        screen.pixels[target..target + width * 4]
            .copy_from_slice(&payload[source..source + width * 4]);
    }
    screen.painted += width * height;
}

fn write_ppm(path: &str, screen: &Screen) -> io::Result<()> {
    let mut file = std::fs::File::create(path)?;
    write!(file, "P6\n{} {}\n255\n", screen.width, screen.height)?;
    // RGBA → RGB. 알파는 우리가 채운 값이라 저장할 것이 없다.
    let mut rgb = Vec::with_capacity(screen.pixels.len() / 4 * 3);
    for pixel in screen.pixels.chunks_exact(4) {
        rgb.extend_from_slice(&pixel[0..3]);
    }
    file.write_all(&rgb)
}

/// 세션 스레드를 무한정 기다리지 않는다.
trait JoinTimeout {
    fn join_timeout(self) -> thread::Result<()>;
}

impl JoinTimeout for thread::JoinHandle<()> {
    fn join_timeout(self) -> thread::Result<()> {
        // 소켓에서 막힌 스레드는 프로세스 종료로 정리한다. 진단 도구라 그걸로 충분하다.
        if self.is_finished() {
            return self.join();
        }
        Ok(())
    }
}
