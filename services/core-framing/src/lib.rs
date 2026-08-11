//! stdio framing, byte-for-byte compatible with `services/ssh-core/internal/protocol` (Go) and
//! `apps/desktop/src/main/core-framing.ts` (TypeScript).
//!
//! **왜 별도 크레이트인가:** 이 헤더는 사이드카 세 종류와 데스크톱이 모두 지키는 계약이다. 코어마다
//! 복사해 두면 한쪽만 고쳐지는 순간 프레임 경계가 어긋나고, 그 증상은 "가끔 화면이 깨진다" 로만
//! 나타난다. 구현을 한 곳에 두어 그럴 여지를 없앤다.
//!
//! Every frame is a 9-byte header followed by JSON metadata and an optional binary payload:
//!
//! ```text
//! [0]     kind            u8   (1 = control, 2 = stream)
//! [1..5]  metadataLength  u32  big endian
//! [5..9]  payloadLength   u32  big endian
//! [9..]   metadata JSON, then payload bytes
//! ```
//!
//! Control frames carry metadata only. Stream frames carry metadata plus raw bytes — for the SSH
//! core that is terminal output; for the RDP/VNC cores it is pixel data or PCM.

use std::io::{self, Read, Write};

pub const HEADER_SIZE: usize = 9;

pub const KIND_CONTROL: u8 = 1;
pub const KIND_STREAM: u8 = 2;

/// Refuse absurd frames rather than trying to allocate for them.
const MAX_METADATA: u32 = 8 * 1024 * 1024;
const MAX_PAYLOAD: u32 = 256 * 1024 * 1024;

#[derive(Debug)]
pub struct Frame {
    pub kind: u8,
    pub metadata: Vec<u8>,
    pub payload: Vec<u8>,
}

pub fn read_frame(reader: &mut impl Read) -> io::Result<Frame> {
    let mut header = [0_u8; HEADER_SIZE];
    reader.read_exact(&mut header)?;

    let kind = header[0];
    let metadata_length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);
    let payload_length = u32::from_be_bytes([header[5], header[6], header[7], header[8]]);

    if metadata_length > MAX_METADATA {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("metadata length {metadata_length} exceeds cap"),
        ));
    }
    if payload_length > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("payload length {payload_length} exceeds cap"),
        ));
    }

    let mut metadata = vec![0_u8; metadata_length as usize];
    reader.read_exact(&mut metadata)?;

    let mut payload = vec![0_u8; payload_length as usize];
    reader.read_exact(&mut payload)?;

    Ok(Frame {
        kind,
        metadata,
        payload,
    })
}

fn encode_header(kind: u8, metadata_length: usize, payload_length: usize) -> io::Result<[u8; HEADER_SIZE]> {
    let metadata_length = u32::try_from(metadata_length)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "metadata too large for u32"))?;
    let payload_length = u32::try_from(payload_length)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "payload too large for u32"))?;

    let mut header = [0_u8; HEADER_SIZE];
    header[0] = kind;
    header[1..5].copy_from_slice(&metadata_length.to_be_bytes());
    header[5..9].copy_from_slice(&payload_length.to_be_bytes());
    Ok(header)
}

/// Writes one frame. The header, metadata and payload go out under a single lock so concurrent
/// senders cannot interleave halves of a frame — the reader has no way to resynchronize if they do.
pub fn write_frame(writer: &mut impl Write, kind: u8, metadata: &[u8], payload: &[u8]) -> io::Result<()> {
    let header = encode_header(kind, metadata.len(), payload.len())?;
    writer.write_all(&header)?;
    writer.write_all(metadata)?;
    if !payload.is_empty() {
        writer.write_all(payload)?;
    }
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_control_frame() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, KIND_CONTROL, br#"{"type":"ready"}"#, &[]).unwrap();

        let frame = read_frame(&mut buffer.as_slice()).unwrap();
        assert_eq!(frame.kind, KIND_CONTROL);
        assert_eq!(frame.metadata, br#"{"type":"ready"}"#);
        assert!(frame.payload.is_empty());
    }

    #[test]
    fn round_trips_a_stream_frame() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, KIND_STREAM, br#"{"type":"rdpFrame"}"#, &[1, 2, 3, 4]).unwrap();

        let frame = read_frame(&mut buffer.as_slice()).unwrap();
        assert_eq!(frame.kind, KIND_STREAM);
        assert_eq!(frame.payload, vec![1, 2, 3, 4]);
    }

    /// The header layout is a contract with core-framing.ts, so pin the exact bytes.
    #[test]
    fn header_layout_matches_the_typescript_encoder() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, KIND_STREAM, b"ab", &[9, 9, 9]).unwrap();

        assert_eq!(buffer[0], 2, "kind");
        assert_eq!(&buffer[1..5], &[0, 0, 0, 2], "metadata length, big endian");
        assert_eq!(&buffer[5..9], &[0, 0, 0, 3], "payload length, big endian");
        assert_eq!(&buffer[9..11], b"ab");
        assert_eq!(&buffer[11..14], &[9, 9, 9]);
    }

    #[test]
    fn reads_back_several_frames_in_sequence() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, KIND_CONTROL, b"{}", &[]).unwrap();
        write_frame(&mut buffer, KIND_STREAM, b"{}", &[7]).unwrap();
        write_frame(&mut buffer, KIND_CONTROL, b"{}", &[]).unwrap();

        let mut cursor = buffer.as_slice();
        assert_eq!(read_frame(&mut cursor).unwrap().kind, KIND_CONTROL);
        assert_eq!(read_frame(&mut cursor).unwrap().payload, vec![7]);
        assert_eq!(read_frame(&mut cursor).unwrap().kind, KIND_CONTROL);
        assert!(read_frame(&mut cursor).is_err(), "stream is exhausted");
    }

    #[test]
    fn rejects_an_oversized_metadata_length() {
        let mut buffer = vec![KIND_CONTROL];
        buffer.extend_from_slice(&u32::MAX.to_be_bytes());
        buffer.extend_from_slice(&0_u32.to_be_bytes());

        let error = read_frame(&mut buffer.as_slice()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
