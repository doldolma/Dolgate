//! ZRLE 인코딩.
//!
//! 사각형 하나가 `u32 길이 + zlib 데이터` 이고, 풀면 64x64 타일이 왼쪽에서 오른쪽·위에서 아래로
//! 이어진다. 타일마다 첫 바이트가 방식을 정한다.
//!
//! | 첫 바이트 | 뜻 |
//! |---|---|
//! | 0 | 타일 전체가 CPIXEL 나열(raw) |
//! | 1 | 단색 — CPIXEL 하나 |
//! | 2..=16 | 팔레트 — CPIXEL n개 + 비트로 눌러 담은 색인 |
//! | 128 | RLE — (CPIXEL, 길이) 반복 |
//! | 130..=255 | 팔레트 RLE — CPIXEL (n-128)개 + (색인, 길이) 반복 |
//!
//! **CPIXEL 이 3바이트인 조건이 함정이다.** 32bpp·depth ≤ 24 이고 R/G/B 비트가 최하위 3바이트나
//! 최상위 3바이트에 모두 들어가면 CPIXEL 은 그 3바이트만 보낸다(RFC 6143 §7.7.6). 우리가 요구하는
//! 포맷이 정확히 그 경우라 실서버는 거의 항상 3바이트로 보낸다 — 4바이트로 읽으면 첫 타일부터
//! 어긋난다.
//!
//! **zlib 스트림은 세션당 하나다.** 사각형마다 새로 만들면 압축 사전이 끊겨 두 번째 사각형부터
//! 풀리지 않는다. 그래서 스트림을 세션이 들고 있고 이 모듈은 이미 풀린 바이트만 받는다.

use flate2::{Decompress, FlushDecompress, Status};

use crate::decode::{DecodeError, Framebuffer, Rect};
use crate::rfb::PixelFormat;

/// ZRLE 타일 한 변의 길이.
const TILE: u16 = 64;

/// 세션 하나가 쓰는 zlib 스트림.
pub struct ZlibStream {
    inner: Decompress,
    /// 풀린 바이트를 담는 곳. 매 사각형마다 새로 할당하지 않게 재사용한다.
    out: Vec<u8>,
}

impl ZlibStream {
    pub fn new() -> Self {
        Self {
            // zlib 헤더가 있는 스트림이다(raw deflate 가 아니다).
            inner: Decompress::new(true),
            out: Vec::new(),
        }
    }

    /// 압축 조각 하나를 풀어 이번 사각형의 바이트를 돌려준다.
    ///
    /// 인코더가 사각형마다 flush 하므로 이 호출로 그 사각형 전부가 나온다. 출력 크기를 미리 알 수
    /// 없어 다 나올 때까지 버퍼를 늘린다.
    pub fn inflate(&mut self, input: &[u8]) -> Result<&[u8], DecodeError> {
        self.out.clear();
        let mut consumed = 0_usize;
        loop {
            let before_in = self.inner.total_in();
            let before_out = self.inner.total_out();
            // 남은 자리가 없으면 늘린다. 첫 회는 압축비를 6배로 어림잡는다.
            if self.out.len() == self.out.capacity() {
                self.out.reserve(if self.out.is_empty() {
                    input.len().saturating_mul(6).max(4096)
                } else {
                    self.out.capacity()
                });
            }
            let status = self
                .inner
                .decompress_vec(&input[consumed..], &mut self.out, FlushDecompress::Sync)
                .map_err(|_| DecodeError::CorruptStream("zlib"))?;
            consumed += (self.inner.total_in() - before_in) as usize;
            let produced = self.inner.total_out() - before_out;

            if consumed >= input.len() && produced == 0 {
                // 입력을 다 먹었고 더 나올 것이 없다.
                break;
            }
            if status == Status::StreamEnd {
                break;
            }
            if produced == 0 && consumed >= input.len() {
                break;
            }
        }
        Ok(&self.out)
    }
}

impl Default for ZlibStream {
    fn default() -> Self {
        Self::new()
    }
}

/// CPIXEL 의 바이트 수와 채널 위치.
#[derive(Debug, Clone, Copy)]
struct CompressedPixel {
    size: usize,
    /// CPIXEL 안에서 R,G,B 가 놓인 자리.
    red: usize,
    green: usize,
    blue: usize,
}

impl CompressedPixel {
    fn for_format(format: PixelFormat) -> Result<Self, DecodeError> {
        if !format.true_colour {
            return Err(DecodeError::UnsupportedPixelFormat(format));
        }
        // 우리가 요구하는 포맷(32bpp, depth 24, shift 0/8/16, max 255)에서 CPIXEL 은 최하위
        // 3바이트다. 리틀엔디언이므로 그 3바이트가 곧 R,G,B 순서다.
        if format.is_rgba32() {
            return Ok(Self {
                size: 3,
                red: 0,
                green: 1,
                blue: 2,
            });
        }
        // 그 밖의 포맷은 아직 다루지 않는다. SetPixelFormat 을 무시하는 서버는 ZRLE 대신 Raw 로
        // 오는 경우가 대부분이고, 억지로 추측해 풀면 화면이 조용히 깨진다.
        Err(DecodeError::UnsupportedPixelFormat(format))
    }

    fn read(&self, bytes: &[u8]) -> [u8; 4] {
        [
            bytes[self.red],
            bytes[self.green],
            bytes[self.blue],
            0xFF,
        ]
    }
}

/// 풀린 ZRLE 바이트를 프레임버퍼에 그린다.
pub fn apply(
    framebuffer: &mut Framebuffer,
    rect: Rect,
    format: PixelFormat,
    data: &[u8],
) -> Result<(), DecodeError> {
    let cpixel = CompressedPixel::for_format(format)?;
    let mut reader = Reader::new(data);

    let mut tile_y = rect.y;
    while tile_y < rect.y + rect.height {
        let height = TILE.min(rect.y + rect.height - tile_y);
        let mut tile_x = rect.x;
        while tile_x < rect.x + rect.width {
            let width = TILE.min(rect.x + rect.width - tile_x);
            let tile = Rect {
                x: tile_x,
                y: tile_y,
                width,
                height,
            };
            decode_tile(framebuffer, tile, cpixel, &mut reader)?;
            tile_x += width;
        }
        tile_y += height;
    }
    Ok(())
}

fn decode_tile(
    framebuffer: &mut Framebuffer,
    tile: Rect,
    cpixel: CompressedPixel,
    reader: &mut Reader<'_>,
) -> Result<(), DecodeError> {
    let count = usize::from(tile.width) * usize::from(tile.height);
    let subencoding = reader.byte()?;

    match subencoding {
        0 => {
            // raw: CPIXEL 나열.
            let mut pixels = Vec::with_capacity(count * 4);
            for _ in 0..count {
                pixels.extend_from_slice(&cpixel.read(reader.take(cpixel.size)?));
            }
            framebuffer.write_rgba(tile, &pixels)
        }
        1 => {
            let colour = cpixel.read(reader.take(cpixel.size)?);
            framebuffer.fill(tile, colour)
        }
        2..=16 => {
            let palette = read_palette(reader, cpixel, usize::from(subencoding))?;
            // 색인은 팔레트 크기에 맞춰 1·2·4비트로 눌러 담고, **행마다 바이트 경계에서 다시
            // 시작한다** — 이걸 무시하면 폭이 8의 배수가 아닌 타일부터 어긋난다.
            let bits = match subencoding {
                2 => 1,
                3..=4 => 2,
                _ => 4,
            };
            let mut pixels = Vec::with_capacity(count * 4);
            for _ in 0..tile.height {
                let row_bytes = (usize::from(tile.width) * bits + 7) / 8;
                let row = reader.take(row_bytes)?;
                for column in 0..usize::from(tile.width) {
                    let bit_offset = column * bits;
                    let byte = row[bit_offset / 8];
                    let shift = 8 - bits - (bit_offset % 8);
                    let mask = (1_u16 << bits) - 1;
                    let index = usize::from((u16::from(byte) >> shift) & mask);
                    let colour = *palette
                        .get(index)
                        .ok_or(DecodeError::CorruptStream("ZRLE palette index"))?;
                    pixels.extend_from_slice(&colour);
                }
            }
            framebuffer.write_rgba(tile, &pixels)
        }
        128 => {
            // plain RLE: (CPIXEL, 길이) 반복. 길이는 255 를 여러 번 이어 붙여 표현한다.
            let mut pixels = Vec::with_capacity(count * 4);
            while pixels.len() < count * 4 {
                let colour = cpixel.read(reader.take(cpixel.size)?);
                let run = read_run_length(reader)?;
                for _ in 0..run {
                    pixels.extend_from_slice(&colour);
                    if pixels.len() >= count * 4 {
                        break;
                    }
                }
            }
            framebuffer.write_rgba(tile, &pixels)
        }
        130..=255 => {
            let palette = read_palette(reader, cpixel, usize::from(subencoding) - 128)?;
            let mut pixels = Vec::with_capacity(count * 4);
            while pixels.len() < count * 4 {
                let byte = reader.byte()?;
                let index = usize::from(byte & 0x7F);
                let colour = *palette
                    .get(index)
                    .ok_or(DecodeError::CorruptStream("ZRLE palette index"))?;
                // 최상위 비트가 서 있으면 길이가 따라온다. 없으면 한 픽셀이다.
                let run = if byte & 0x80 != 0 {
                    read_run_length(reader)?
                } else {
                    1
                };
                for _ in 0..run {
                    pixels.extend_from_slice(&colour);
                    if pixels.len() >= count * 4 {
                        break;
                    }
                }
            }
            framebuffer.write_rgba(tile, &pixels)
        }
        other => Err(DecodeError::UnsupportedZrleSubencoding(other)),
    }
}

fn read_palette(
    reader: &mut Reader<'_>,
    cpixel: CompressedPixel,
    size: usize,
) -> Result<Vec<[u8; 4]>, DecodeError> {
    let mut palette = Vec::with_capacity(size);
    for _ in 0..size {
        palette.push(cpixel.read(reader.take(cpixel.size)?));
    }
    Ok(palette)
}

/// RLE 길이. 255 가 이어지는 동안 더하고, 마지막 바이트까지 더한 값에 1 을 더한다.
fn read_run_length(reader: &mut Reader<'_>) -> Result<usize, DecodeError> {
    let mut run = 1_usize;
    loop {
        let byte = reader.byte()?;
        run += usize::from(byte);
        if byte != 255 {
            return Ok(run);
        }
    }
}

/// 풀린 바이트를 앞에서부터 읽는 커서. 모자라면 오류다 — 넘겨 읽으면 패닉이 된다.
struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }

    fn byte(&mut self) -> Result<u8, DecodeError> {
        let byte = *self
            .data
            .get(self.offset)
            .ok_or(DecodeError::CorruptStream("ZRLE truncated"))?;
        self.offset += 1;
        Ok(byte)
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], DecodeError> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or(DecodeError::CorruptStream("ZRLE length overflow"))?;
        if end > self.data.len() {
            return Err(DecodeError::CorruptStream("ZRLE truncated"));
        }
        let slice = &self.data[self.offset..end];
        self.offset = end;
        Ok(slice)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: u16, y: u16, width: u16, height: u16) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn cpixel(red: u8, green: u8, blue: u8) -> [u8; 3] {
        [red, green, blue]
    }

    #[test]
    fn solid_tile_fills_the_whole_tile() {
        let mut framebuffer = Framebuffer::new(2, 2);
        let mut data = vec![1_u8];
        data.extend_from_slice(&cpixel(10, 20, 30));
        apply(&mut framebuffer, rect(0, 0, 2, 2), PixelFormat::rgba32(), &data).unwrap();
        assert_eq!(framebuffer.pixel_for_test(0, 0), [10, 20, 30, 255]);
        assert_eq!(framebuffer.pixel_for_test(1, 1), [10, 20, 30, 255]);
    }

    #[test]
    fn raw_tile_reads_three_byte_pixels() {
        let mut framebuffer = Framebuffer::new(2, 1);
        let mut data = vec![0_u8];
        data.extend_from_slice(&cpixel(1, 2, 3));
        data.extend_from_slice(&cpixel(4, 5, 6));
        apply(&mut framebuffer, rect(0, 0, 2, 1), PixelFormat::rgba32(), &data).unwrap();
        assert_eq!(framebuffer.pixel_for_test(0, 0), [1, 2, 3, 255]);
        assert_eq!(framebuffer.pixel_for_test(1, 0), [4, 5, 6, 255]);
    }

    // 색인은 행마다 바이트 경계에서 다시 시작한다. 폭이 8 의 배수가 아닌 타일에서 이걸 틀리면
    // 두 번째 행부터 색이 밀린다.
    #[test]
    fn packed_palette_restarts_at_a_byte_boundary_each_row() {
        let mut framebuffer = Framebuffer::new(3, 2);
        let mut data = vec![2_u8]; // 팔레트 2색 → 1비트
        data.extend_from_slice(&cpixel(0, 0, 0));
        data.extend_from_slice(&cpixel(255, 255, 255));
        // 첫 행: 색인 1,0,1 → 0b101_00000
        data.push(0b1010_0000);
        // 둘째 행: 색인 0,1,1 → 0b011_00000
        data.push(0b0110_0000);
        apply(&mut framebuffer, rect(0, 0, 3, 2), PixelFormat::rgba32(), &data).unwrap();
        assert_eq!(framebuffer.pixel_for_test(0, 0), [255, 255, 255, 255]);
        assert_eq!(framebuffer.pixel_for_test(1, 0), [0, 0, 0, 255]);
        assert_eq!(framebuffer.pixel_for_test(2, 0), [255, 255, 255, 255]);
        assert_eq!(framebuffer.pixel_for_test(0, 1), [0, 0, 0, 255]);
        assert_eq!(framebuffer.pixel_for_test(1, 1), [255, 255, 255, 255]);
        assert_eq!(framebuffer.pixel_for_test(2, 1), [255, 255, 255, 255]);
    }

    #[test]
    fn plain_rle_expands_runs() {
        let mut framebuffer = Framebuffer::new(4, 1);
        let mut data = vec![128_u8];
        data.extend_from_slice(&cpixel(9, 9, 9));
        data.push(2); // 길이 3
        data.extend_from_slice(&cpixel(1, 1, 1));
        data.push(0); // 길이 1
        apply(&mut framebuffer, rect(0, 0, 4, 1), PixelFormat::rgba32(), &data).unwrap();
        assert_eq!(framebuffer.pixel_for_test(0, 0), [9, 9, 9, 255]);
        assert_eq!(framebuffer.pixel_for_test(2, 0), [9, 9, 9, 255]);
        assert_eq!(framebuffer.pixel_for_test(3, 0), [1, 1, 1, 255]);
    }

    // 255 가 이어지면 길이를 더해 나간다. 이걸 틀리면 긴 단색 줄에서 화면이 밀린다.
    #[test]
    fn run_length_accumulates_across_255_bytes() {
        let mut reader = Reader::new(&[255, 255, 4]);
        assert_eq!(read_run_length(&mut reader).unwrap(), 1 + 255 + 255 + 4);
    }

    #[test]
    fn palette_rle_uses_the_high_bit_to_mark_runs() {
        let mut framebuffer = Framebuffer::new(3, 1);
        let mut data = vec![130_u8]; // 팔레트 2색 RLE
        data.extend_from_slice(&cpixel(7, 7, 7));
        data.extend_from_slice(&cpixel(8, 8, 8));
        data.push(0x80); // 색인 0, 길이 따라옴
        data.push(1); // 길이 2
        data.push(0x01); // 색인 1, 한 픽셀
        apply(&mut framebuffer, rect(0, 0, 3, 1), PixelFormat::rgba32(), &data).unwrap();
        assert_eq!(framebuffer.pixel_for_test(0, 0), [7, 7, 7, 255]);
        assert_eq!(framebuffer.pixel_for_test(1, 0), [7, 7, 7, 255]);
        assert_eq!(framebuffer.pixel_for_test(2, 0), [8, 8, 8, 255]);
    }

    // 64 를 넘는 사각형은 타일로 쪼개지고 마지막 타일은 잘린다. 이 경계가 틀리면 큰 화면의
    // 오른쪽·아래가 어긋난다.
    #[test]
    fn splits_into_64_pixel_tiles_with_partial_edges() {
        let mut framebuffer = Framebuffer::new(70, 1);
        let mut data = Vec::new();
        // 첫 타일(64칸) 단색, 둘째 타일(6칸) 다른 단색.
        data.push(1);
        data.extend_from_slice(&cpixel(1, 0, 0));
        data.push(1);
        data.extend_from_slice(&cpixel(0, 2, 0));
        apply(&mut framebuffer, rect(0, 0, 70, 1), PixelFormat::rgba32(), &data).unwrap();
        assert_eq!(framebuffer.pixel_for_test(63, 0), [1, 0, 0, 255]);
        assert_eq!(framebuffer.pixel_for_test(64, 0), [0, 2, 0, 255]);
        assert_eq!(framebuffer.pixel_for_test(69, 0), [0, 2, 0, 255]);
    }

    // 데이터가 모자라면 패닉이 아니라 오류여야 한다. 서버를 신뢰하지 않는다.
    #[test]
    fn truncated_data_is_an_error() {
        let mut framebuffer = Framebuffer::new(2, 2);
        let error = apply(
            &mut framebuffer,
            rect(0, 0, 2, 2),
            PixelFormat::rgba32(),
            &[1, 10, 20],
        )
        .unwrap_err();
        assert!(matches!(error, DecodeError::CorruptStream(_)));
    }

    #[test]
    fn zlib_stream_survives_across_rects() {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write as _;

        // 인코더 하나로 두 조각을 flush 해 보낸다 — 실서버가 하는 방식이다.
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(b"first-chunk-of-tiles").unwrap();
        encoder.flush().unwrap();
        let first = std::mem::take(encoder.get_mut());
        encoder.write_all(b"second-chunk-of-tiles").unwrap();
        encoder.flush().unwrap();
        let second = std::mem::take(encoder.get_mut());

        let mut stream = ZlibStream::new();
        assert_eq!(stream.inflate(&first).unwrap(), b"first-chunk-of-tiles");
        // 스트림을 새로 만들면 여기서 실패한다(사전이 끊긴다).
        assert_eq!(stream.inflate(&second).unwrap(), b"second-chunk-of-tiles");
    }
}
