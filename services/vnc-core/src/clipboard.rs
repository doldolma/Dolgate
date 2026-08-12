//! RFB 클립보드: 고전 CutText 와 `ExtendedClipboard` 의사 인코딩(`0xc0a1e5ce`).
//!
//! **협상이 메시지 안에 숨어 있다.** 별도의 능력 교환이 없고, CutText 의 길이 필드를 **음수**로
//! 실으면 확장 메시지라는 뜻이다(`|길이|` 가 본문 크기). 그래서 확장을 모르는 상대에게 보내면 그
//! 음수를 거대한 u32 로 읽고 스트림이 깨진다 — **상대의 caps 를 본 뒤에만 우리도 보낸다.**
//!
//! 고전 경로와의 차이 둘:
//!
//! - 글자: 고전은 latin-1(한글 불가), 확장은 UTF-8
//! - 줄바꿈: 고전은 LF, **확장은 CRLF** 다(규격이 그렇게 정했다)

use std::io::Write as _;

use flate2::write::ZlibEncoder;
use flate2::{Compression, Decompress, FlushDecompress};

/// 형식 비트(하위 16비트). 우리는 텍스트만 다룬다.
///
/// 동작 비트는 24번부터라 겹치지 않는다. 마스크를 24비트로 잡으면 상대의 동작 비트가 형식으로
/// 섞여 들어온다 — 규격의 구분대로 16비트만 본다.
pub const FORMAT_TEXT: u32 = 1 << 0;
pub const FORMAT_MASK: u32 = 0x0000_FFFF;


/// 동작 비트.
///
/// **`caps` 가 24번, `provide` 가 28번이다.** 이 표가 한 칸씩 밀려 있었다(caps=1<<28 … provide=1<<27).
/// 그러면 우리가 보내는 provide 가 상대에게는 notify 로 읽힌다 — notify 의 본문은 flags 뿐이라
/// 서버가 zlib 바이트를 읽지 않고 남기고, 그 첫 바이트(`0x78`)가 다음 메시지 종류로 해석되면서
/// **연결이 끊긴다**(TigerVNC 로그: `unknown message type 120`). 클립보드를 한 번 보내면 죽었다.
///
/// 값을 `1 << n` 으로 적어 둔다 — 16진수로 적었을 때 한 칸 밀린 것을 아무도 못 알아봤다.
/// 지금 쓰지 않는 것도 표에 남긴다(번호 표가 반쪽이면 다음 사람이 규격을 다시 찾아야 한다).
pub const ACTION_CAPS: u32 = 1 << 24;
pub const ACTION_REQUEST: u32 = 1 << 25;
#[allow(dead_code)]
pub const ACTION_PEEK: u32 = 1 << 26;
pub const ACTION_NOTIFY: u32 = 1 << 27;
pub const ACTION_PROVIDE: u32 = 1 << 28;

/// 상대가 요청 없이 바로 보내도 되는 최대 크기(우리 caps 에 싣는 값).
///
/// 이보다 큰 것은 상대가 `notify` 로 알리고 우리가 `request` 로 가져간다. 무제한으로 두면 원격에서
/// 큰 파일을 복사할 때마다 그 전체가 밀려 들어온다.
pub const MAX_UNSOLICITED_TEXT: u32 = 256 * 1024;

/// 우리가 받아들이는 압축 해제 후 최대 크기. 압축 폭탄을 막는다.
const MAX_INFLATED: usize = 4 * 1024 * 1024;

/// 서버에서 온 클립보드 메시지.
#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    /// 고전 CutText. latin-1 로 해석한 텍스트다.
    Classic(String),
    /// 확장을 쓴다는 선언. 이걸 본 뒤에야 우리도 확장을 보낼 수 있다.
    Caps { formats: u32 },
    /// 실제 텍스트가 실려 왔다.
    Provide { text: String },
    /// "가진 것이 있다" — 원하면 request 하라.
    Notify { formats: u32 },
    /// 상대가 우리 클립보드를 달라고 한다.
    Request { formats: u32 },
    /// 우리가 다루지 않는 동작(peek 등)이나 형식. 무시하지만 바이트는 이미 다 읽었다.
    Ignored,
}

/// 고전 CutText 본문(latin-1 바이트)을 문자열로.
pub fn decode_classic(body: &[u8]) -> String {
    body.iter().map(|byte| char::from(*byte)).collect()
}

/// 확장 메시지 본문을 해석한다.
///
/// 본문은 `flags(4) + 데이터` 다. `provide` 의 데이터는 zlib 스트림이고, 그 안에 형식마다
/// `크기(4) + 내용` 이 이어진다.
pub fn decode_extended(body: &[u8]) -> Incoming {
    if body.len() < 4 {
        return Incoming::Ignored;
    }
    let flags = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
    // 어느 동작·형식을 알려 왔는지 그대로 남긴다. 비트 위치가 틀렸을 때 이 줄이 유일한 증거다.
    tracing::trace!(flags = format_args!("{flags:#010x}"), "확장 클립보드 수신 flags");
    let formats = flags & FORMAT_MASK;
    let data = &body[4..];

    if flags & ACTION_CAPS != 0 {
        return Incoming::Caps { formats };
    }
    if flags & ACTION_PROVIDE != 0 {
        return match inflate_first_text(data, formats) {
            Some(text) => Incoming::Provide { text },
            None => Incoming::Ignored,
        };
    }
    if flags & ACTION_NOTIFY != 0 {
        return Incoming::Notify { formats };
    }
    if flags & ACTION_REQUEST != 0 {
        return Incoming::Request { formats };
    }
    // peek 은 "무엇을 가졌는지 알려 달라" 다. notify 로 답할 수 있지만 쓰는 서버가 드물어 미룬다.
    Incoming::Ignored
}

/// `provide` 데이터에서 텍스트를 뽑는다.
///
/// 형식 비트가 낮은 것부터 순서대로 들어 있고, 우리는 텍스트만 본다. 텍스트가 첫 형식이므로
/// (비트 0) 앞에서 바로 읽을 수 있다 — 다른 형식만 왔으면 버린다.
fn inflate_first_text(data: &[u8], formats: u32) -> Option<String> {
    if formats & FORMAT_TEXT == 0 {
        return None;
    }
    let plain = inflate(data)?;
    if plain.len() < 4 {
        return None;
    }
    let size = u32::from_be_bytes([plain[0], plain[1], plain[2], plain[3]]) as usize;
    let text = plain.get(4..4 + size)?;
    // 규격이 CRLF 를 쓰라고 정했다. 로컬 클립보드는 LF 를 기대하므로 여기서 되돌린다.
    Some(String::from_utf8_lossy(text).replace("\r\n", "\n"))
}

/// 확장 클립보드의 zlib 본문을 푼다.
///
/// **두 형태를 모두 받아야 한다.**
///
/// - 완결 스트림: LibVNCServer(x11vnc)는 one-shot `compress()` 로 보내 마지막 블록·Adler32 가 붙는다
/// - 미완결 스트림: TigerVNC 는 `flush()` 만 해서 sync flush 표시(`00 00 ff ff`)로 끝난다
///
/// 완결만 받아들이면 TigerVNC 에서 **원격의 복사가 조용히 안 들어온다**. 미완결만 받아들이면
/// x11vnc 쪽을 놓친다. 그래서 `StreamEnd` 와 "입력을 다 먹고 더 낼 것이 없음" 을 모두 성공으로 본다.
fn inflate(input: &[u8]) -> Option<Vec<u8>> {
    let mut stream = Decompress::new(true);
    let mut out = Vec::with_capacity(input.len() * 4);
    let mut consumed = 0;
    loop {
        let before_in = stream.total_in();
        let before_out = stream.total_out();
        out.reserve(8 * 1024);
        let status = stream
            .decompress_vec(&input[consumed..], &mut out, FlushDecompress::Sync)
            .ok()?;
        consumed += (stream.total_in() - before_in) as usize;
        let produced = stream.total_out() - before_out;
        if out.len() > MAX_INFLATED {
            return None;
        }
        match status {
            // 완결 스트림(x11vnc).
            flate2::Status::StreamEnd => return Some(out),
            // 미완결 스트림(TigerVNC): 입력을 다 먹었고 더 낼 것이 없다 = 이 메시지의 끝이다.
            // 아무것도 못 뽑았으면 잘린 것이므로 버린다(길이 필드조차 없다).
            _ if consumed >= input.len() && produced == 0 => {
                return if out.is_empty() { None } else { Some(out) };
            }
            _ => {}
        }
    }
}

/// 우리 능력을 알린다(caps). 형식은 텍스트 하나다.
///
/// 본문은 `flags(4) + 지원 형식마다 최대 크기(4)` 다. 크기는 **형식 비트(하위 16비트)마다** 하나이고
/// 동작 비트는 개수에 들어가지 않는다 — 상대가 그렇게 센다.
///
/// **지원하는 동작을 반드시 함께 싣는다.** 형식만 싣고 동작을 비워 보냈더니 TigerVNC 서버가 그
/// 메시지를 받고 **연결을 끊었다**(실측: 우분투 VM 의 Xtigervnc — 첫 화면 사각형 하나만 받고 EOF.
/// 데비안 12 의 같은 서버는 관대해서 그냥 붙었다 — 버전에 따라 갈린다). 우리는 request·notify·
/// provide 를 모두 처리하므로 그대로 알린다. peek 은 처리하지 않아 넣지 않는다 — 알리면 상대가
/// 그 동작을 보내고 우리는 답하지 못한다.
pub fn encode_caps() -> Vec<u8> {
    let mut body = Vec::with_capacity(8);
    body.extend_from_slice(
        &(ACTION_CAPS | ACTION_REQUEST | ACTION_NOTIFY | ACTION_PROVIDE | FORMAT_TEXT)
            .to_be_bytes(),
    );
    body.extend_from_slice(&MAX_UNSOLICITED_TEXT.to_be_bytes());
    body
}

/// 텍스트를 달라고 요청한다.
pub fn encode_request() -> Vec<u8> {
    (ACTION_REQUEST | FORMAT_TEXT).to_be_bytes().to_vec()
}

/// "가진 것이 있다" 고 알린다. 상대의 한도를 넘는 텍스트는 이렇게 알리고 request 를 기다린다.
pub fn encode_notify() -> Vec<u8> {
    (ACTION_NOTIFY | FORMAT_TEXT).to_be_bytes().to_vec()
}

/// 텍스트를 실어 보낸다(provide).
///
/// 줄바꿈을 CRLF 로 바꾼다 — 규격이 이 형식에 CRLF 를 요구한다. 고전 경로가 LF 를 요구하는 것과
/// 정반대라, 두 경로를 한 함수로 합치면 반드시 한쪽이 깨진다.
pub fn encode_provide(text: &str) -> Option<Vec<u8>> {
    let wire = to_crlf(text);
    let mut plain = Vec::with_capacity(4 + wire.len());
    plain.extend_from_slice(&(wire.len() as u32).to_be_bytes());
    plain.extend_from_slice(wire.as_bytes());

    // **스트림을 끝내지 않는다(flush 만 한다).**
    //
    // `finish()` 는 마지막 블록과 Adler32 를 붙여 스트림을 완결한다. 그러면 받는 쪽 `inflate` 가
    // 마지막 조각에서 `Z_STREAM_END` 를 돌려주는데, LibVNCServer(x11vnc)는 **`Z_OK` 가 아니면
    // 오류로 보고 연결을 끊는다**(실측 로그: `rfbProcessExtendedServerCutTextData: zlib inflation
    // error`). 클립보드를 한 번 보내면 세션이 죽었다.
    //
    // TigerVNC 도 같은 방식으로 보낸다(CMsgWriter::writeClipboardProvide 는 ZlibOutStream 을
    // `flush()` 만 한다) — 즉 미완결 스트림이 이 확장의 관행이다.
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&plain).ok()?;
    encoder.flush().ok()?;
    let compressed = std::mem::take(encoder.get_mut());

    let mut body = Vec::with_capacity(4 + compressed.len());
    body.extend_from_slice(&(ACTION_PROVIDE | FORMAT_TEXT).to_be_bytes());
    body.extend_from_slice(&compressed);
    Some(body)
}

/// LF 를 CRLF 로. 이미 CRLF 인 것은 그대로 둔다(CR 이 두 번 붙으면 원격에 빈 줄이 생긴다).
fn to_crlf(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 16);
    let mut previous = '\0';
    for character in text.chars() {
        if character == '\n' && previous != '\r' {
            out.push('\r');
        }
        out.push(character);
        previous = character;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 동작 비트의 **위치**를 규격 값으로 못박는다.
    ///
    /// 상수를 참조해 만든 테스트는 상수가 틀렸을 때 같이 틀린다 — 이 표가 한 칸 밀려 있었고
    /// (caps=1<<28 … provide=1<<27) 코드와 테스트가 같은 값을 공유해 전부 통과했다. 그 결과
    /// 우리 provide 가 상대에게 notify 로 읽혀 zlib 바이트가 스트림에 남고, 서버가
    /// `unknown message type 120`(=0x78, zlib 헤더) 으로 연결을 끊었다.
    ///
    /// 출처: RFB 확장 클립보드 규격 / TigerVNC rfb/clipboardTypes.h.
    #[test]
    fn action_bit_positions_match_the_spec() {
        assert_eq!(ACTION_CAPS, 1 << 24);
        assert_eq!(ACTION_REQUEST, 1 << 25);
        assert_eq!(ACTION_PEEK, 1 << 26);
        assert_eq!(ACTION_NOTIFY, 1 << 27);
        assert_eq!(ACTION_PROVIDE, 1 << 28);
        // 형식은 하위 16비트다. 동작 비트가 형식 마스크에 걸리면 상대의 동작이 형식으로 섞인다.
        assert_eq!(FORMAT_TEXT, 1 << 0);
        assert_eq!(FORMAT_MASK & ACTION_CAPS, 0);
        assert_eq!(FORMAT_MASK & ACTION_PROVIDE, 0);
    }

    /// provide 메시지의 flags 가 실제로 provide 여야 한다.
    ///
    /// 여기가 끊김의 자리였다 — notify 로 읽히면 서버가 본문(zlib)을 읽지 않는다.
    #[test]
    fn provide_uses_the_provide_action() {
        let body = encode_provide("한글").expect("본문이 만들어져야 한다");
        let flags = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
        assert_ne!(flags & (1 << 28), 0, "provide(1<<28) 여야 한다: {flags:#x}");
        assert_ne!(flags & FORMAT_TEXT, 0);
        // 본문 뒤는 zlib 스트림이다. 첫 바이트가 0x78 인 것이 그 증거이고, 그 바이트가 메시지
        // 종류로 읽히면 서버가 끊는다.
        assert_eq!(body[4], 0x78, "flags 뒤부터 zlib 이어야 한다");
    }

    #[test]
    fn caps_advertise_the_actions_we_handle() {
        let body = encode_caps();
        let flags = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);

        assert_ne!(flags & ACTION_CAPS, 0, "caps 동작이 서 있어야 한다");
        assert_ne!(flags & FORMAT_TEXT, 0, "텍스트 형식을 지원한다고 알려야 한다");

        // **동작 비트를 비워 보내면 TigerVNC 서버가 연결을 끊는다**(우분투 VM 실측). 우리가
        // 처리하는 동작은 그대로 알려야 한다.
        for (bit, name) in [
            (ACTION_REQUEST, "request"),
            (ACTION_NOTIFY, "notify"),
            (ACTION_PROVIDE, "provide"),
        ] {
            assert_ne!(flags & bit, 0, "{name} 를 알리지 않으면 상대가 그 동작을 쓰지 않는다");
        }
        // 처리하지 않는 동작은 알리지 않는다 — 알리면 상대가 보내고 우리는 답할 수 없다.
        assert_eq!(flags & ACTION_PEEK, 0, "peek 은 처리하지 않으므로 알리면 안 된다");

        // 크기는 형식 비트 개수만큼 붙는다(동작 비트는 세지 않는다). 어긋나면 상대가 본문 길이를
        // 검사하다 메시지를 버리거나 끊는다.
        let formats = (flags & 0x0000_FFFF).count_ones() as usize;
        assert_eq!(body.len(), 4 + 4 * formats);
    }

    #[test]
    fn reads_the_servers_caps() {
        let mut body = (ACTION_CAPS | FORMAT_TEXT).to_be_bytes().to_vec();
        body.extend_from_slice(&(64_u32 * 1024).to_be_bytes());

        assert_eq!(
            decode_extended(&body),
            Incoming::Caps {
                formats: FORMAT_TEXT
            }
        );
    }

    #[test]
    fn round_trips_utf8_text() {
        // 고전 경로로는 못 보내던 한글이 이 경로의 존재 이유다.
        let provide = encode_provide("한글 test").unwrap();
        assert_eq!(
            decode_extended(&provide),
            Incoming::Provide {
                text: "한글 test".to_owned()
            }
        );
    }

    #[test]
    fn uses_crlf_on_the_wire_and_lf_locally() {
        // 이 형식은 CRLF 를 요구한다. 고전 CutText 는 LF 를 요구한다 — 정반대다.
        let provide = encode_provide("a\nb").unwrap();
        let Incoming::Provide { text } = decode_extended(&provide) else {
            panic!("provide 여야 한다");
        };
        // 되돌아온 값은 로컬이 기대하는 LF 다.
        assert_eq!(text, "a\nb");
        // 그리고 와이어에는 CRLF 가 실렸다.
        assert_eq!(to_crlf("a\nb"), "a\r\nb");
        // 이미 CRLF 면 CR 을 더 붙이지 않는다.
        assert_eq!(to_crlf("a\r\nb"), "a\r\nb");
    }

    #[test]
    fn recognises_notify_and_request() {
        assert_eq!(
            decode_extended(&(ACTION_NOTIFY | FORMAT_TEXT).to_be_bytes()),
            Incoming::Notify {
                formats: FORMAT_TEXT
            }
        );
        assert_eq!(
            decode_extended(&(ACTION_REQUEST | FORMAT_TEXT).to_be_bytes()),
            Incoming::Request {
                formats: FORMAT_TEXT
            }
        );
    }

    #[test]
    fn ignores_formats_we_do_not_handle() {
        // 이미지·파일 형식만 온 provide 는 버린다. 바이트는 호출부가 이미 다 읽었다.
        let flags = ACTION_PROVIDE | 0x0000_0008; // dib
        assert_eq!(decode_extended(&flags.to_be_bytes()), Incoming::Ignored);
        // peek 도 지금은 다루지 않는다.
        assert_eq!(
            decode_extended(&(ACTION_PEEK | FORMAT_TEXT).to_be_bytes()),
            Incoming::Ignored
        );
    }

    #[test]
    fn refuses_a_truncated_or_broken_stream() {
        // 깨진 zlib 로 세션을 끊지 않는다 — 클립보드 하나 때문에 화면이 죽으면 안 된다.
        let mut body = (ACTION_PROVIDE | FORMAT_TEXT).to_be_bytes().to_vec();
        body.extend_from_slice(&[0x78, 0x9c, 0x01, 0x02]);
        assert_eq!(decode_extended(&body), Incoming::Ignored);
        // 본문이 flags 도 못 채우는 경우.
        assert_eq!(decode_extended(&[0x08]), Incoming::Ignored);
    }

    #[test]
    fn decodes_classic_latin1() {
        assert_eq!(decode_classic(&[b'c', b'a', b'f', 0xE9]), "café");
    }
}
