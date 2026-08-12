//! Tight 인코딩(7) 해독.
//!
//! TigerVNC 의 기본 인코딩이고, 넓은 단색 면과 사진을 각각 다른 방법으로 줄인다. ZRLE 하나만
//! 쓸 때보다 대역폭이 크게 준다 — 특히 브라우저·문서 화면에서 팔레트 압축이 잘 먹는다.
//!
//! **사각형마다 압축 방법이 다르다.** 첫 바이트(control)가 그것을 정하고, 그 안에 zlib 스트림
//! 번호까지 실려 있다. 스트림은 **세션 내내 이어지는 네 개**라 사각형마다 새로 만들면 두 번째
//! 사각형부터 풀리지 않는다(ZRLE 와 같은 함정, 다만 여기는 네 개다).
//!
//! ```text
//! control 바이트
//!   bit 0..3  : 스트림 0..3 을 초기화하라
//!   bit 4     : 필터 id 가 따라온다(basic 일 때만)
//!   bit 5..6  : 스트림 번호(basic 일 때만)
//!   bit 7     : 1 이면 basic 이 아니다 → 상위 4비트로 갈린다(0x8 fill, 0x9 jpeg)
//! ```
//!
//! **픽셀이 3바이트다.** Tight 는 32비트 트루컬러에서 알파 자리를 빼고 보낸다(TPIXEL). 이걸
//! 4바이트로 읽으면 화면이 사선으로 밀린다.

use std::io::Read;

use crate::decode::{DecodeError, Framebuffer, Rect};
use crate::rfb::PixelFormat;
use crate::zrle::ZlibStream;

/// zlib 을 쓰지 않는 경계. 이보다 작은 데이터는 압축 없이 그대로 온다.
///
/// 규격이 정한 값이다. 작은 조각은 압축해도 커지기만 해서 서버가 생략한다 — 이 분기를 빼면
/// 작은 사각형에서 zlib 오류가 난다.
const MIN_TO_COMPRESS: usize = 12;

/// 한 사각형의 압축 방법.
#[derive(Debug, PartialEq, Eq)]
pub enum Compression {
    /// 단색 한 픽셀. 넓은 배경이 이 경로로 온다(가장 싼 경로다).
    Fill,
    /// JPEG. 사진·영상 영역에 쓰인다.
    Jpeg,
    /// zlib(+필터). 대부분의 화면이 여기로 온다.
    Basic { stream: usize, filter: Filter },
}

/// basic 압축의 필터. 압축 전에 픽셀을 어떻게 바꿔 두었는지다.
#[derive(Debug, PartialEq, Eq)]
pub enum Filter {
    /// 그대로.
    Copy,
    /// 색 표. 화면에 쓰인 색이 적을 때(글자·UI) 여기서 크게 줄어든다.
    Palette,
    /// 왼쪽·위 픽셀로 예측한 차이값. 그라데이션에 쓰인다.
    Gradient,
}

/// control 바이트를 읽는다. 스트림 초기화 지시는 여기서 처리한다.
pub fn read_control(control: u8, streams: &mut [ZlibStream; 4]) -> Result<Compression, DecodeError> {
    // 하위 4비트가 "이 스트림을 초기화하라" 다. 서버가 압축 사전을 버릴 때 쓰고, 우리도 같이
    // 버려야 그 뒤가 풀린다.
    for (index, stream) in streams.iter_mut().enumerate() {
        if control & (1 << index) != 0 {
            *stream = ZlibStream::new();
        }
    }

    let kind = control >> 4;
    if kind == 0x08 {
        return Ok(Compression::Fill);
    }
    if kind == 0x09 {
        return Ok(Compression::Jpeg);
    }
    if kind & 0x08 != 0 {
        // 0x0A~0x0F. 규격에 없다(예약).
        return Err(DecodeError::CorruptStream("Tight: 알 수 없는 압축 종류"));
    }

    Ok(Compression::Basic {
        stream: usize::from((control >> 4) & 0x03),
        // bit 6(=kind 의 bit 2) 가 서 있으면 필터 id 가 본문 앞에 온다. 없으면 Copy 다.
        filter: if kind & 0x04 != 0 {
            Filter::Palette // 자리만 채운다 — 실제 값은 호출부가 필터 바이트를 읽어 정한다
        } else {
            Filter::Copy
        },
    })
}

/// 필터 id 바이트가 따라오는지.
pub fn has_filter_id(control: u8) -> bool {
    let kind = control >> 4;
    kind & 0x08 == 0 && kind & 0x04 != 0
}

pub fn filter_from_id(id: u8) -> Result<Filter, DecodeError> {
    match id {
        0 => Ok(Filter::Copy),
        1 => Ok(Filter::Palette),
        2 => Ok(Filter::Gradient),
        _ => Err(DecodeError::CorruptStream("Tight: 알 수 없는 필터")),
    }
}

/// Tight 의 길이 필드. 1~3바이트 가변이다(작은 값이 흔하니 한 바이트로 끝낸다).
///
/// 각 바이트의 최상위 비트가 "다음 바이트도 길이" 라는 표시다. 이걸 고정 길이로 읽으면 그 뒤가
/// 전부 밀린다.
pub fn read_compact_length(stream: &mut impl Read) -> Result<usize, DecodeError> {
    let mut byte = [0_u8; 1];
    let mut read_byte = |stream: &mut dyn Read| -> Result<u8, DecodeError> {
        stream
            .read_exact(&mut byte)
            .map_err(|_| DecodeError::CorruptStream("Tight: 길이가 잘렸다"))?;
        Ok(byte[0])
    };

    let first = read_byte(stream)?;
    let mut length = usize::from(first & 0x7F);
    if first & 0x80 == 0 {
        return Ok(length);
    }
    let second = read_byte(stream)?;
    length |= usize::from(second & 0x7F) << 7;
    if second & 0x80 == 0 {
        return Ok(length);
    }
    let third = read_byte(stream)?;
    length |= usize::from(third) << 14;
    Ok(length)
}

/// TPIXEL 하나를 RGBA 로. **3바이트**다(알파 자리를 뺀다).
fn tpixel(bytes: &[u8], format: PixelFormat) -> [u8; 4] {
    // 서버가 우리가 요청한 rgba32 를 쓰면 바이트 순서가 그대로 R,G,B 다. 그 외에는 시프트로
    // 뽑아야 하는데, Tight 는 24비트 트루컬러에서만 3바이트를 쓰므로 최대값이 255 로 고정이다.
    if format.red_shift == 16 {
        // BGR 순서로 오는 서버(red_shift 16)다.
        [bytes[2], bytes[1], bytes[0], 0xFF]
    } else {
        [bytes[0], bytes[1], bytes[2], 0xFF]
    }
}

/// Tight 사각형이 몇 바이트짜리 픽셀을 쓰는지.
///
/// 32비트 트루컬러에서만 3바이트로 줄이고(TPIXEL), 그 밖에는 포맷 그대로다.
pub fn bytes_per_pixel(format: PixelFormat) -> usize {
    if format.bits_per_pixel == 32 && format.red_max == 255 && format.green_max == 255 && format.blue_max == 255
    {
        3
    } else {
        format.bytes_per_pixel()
    }
}

/// 색 표 항목 하나를 RGBA 로. 표는 압축되지 않은 TPIXEL 나열이다.
pub fn palette_entry(bytes: &[u8], format: PixelFormat) -> [u8; 4] {
    tpixel(bytes, format)
}

/// 필터를 거친 뒤의 데이터 크기.
///
/// 이 값으로 "압축 없이 오는가" 를 판정하고, 압축이 없으면 그만큼을 그대로 읽는다. 그래서 필터별
/// 크기 계산이 **읽기 경계 자체**다 — 한 바이트라도 틀리면 그 뒤 사각형이 전부 어긋난다.
pub fn filtered_length(
    rect: Rect,
    format: PixelFormat,
    filter: &Filter,
    palette_len: usize,
) -> usize {
    let width = usize::from(rect.width);
    let height = usize::from(rect.height);
    match filter {
        Filter::Palette => {
            if palette_len == 2 {
                // 색이 둘이면 1비트씩이고 행마다 바이트 경계에서 끊긴다.
                (width + 7) / 8 * height
            } else {
                width * height
            }
        }
        // Copy·Gradient 는 픽셀 그대로의 크기다(Gradient 는 24비트 전용이라 3바이트).
        _ => width * height * bytes_per_pixel(format),
    }
}

/// 단색 사각형을 칠한다.
pub fn apply_fill(
    framebuffer: &mut Framebuffer,
    rect: Rect,
    format: PixelFormat,
    pixel: &[u8],
) -> Result<(), DecodeError> {
    if pixel.len() < bytes_per_pixel(format) {
        return Err(DecodeError::ShortData {
            expected: bytes_per_pixel(format),
            got: pixel.len(),
        });
    }
    framebuffer.fill(rect, tpixel(pixel, format))
}

/// JPEG 사각형을 칠한다.
pub fn apply_jpeg(
    framebuffer: &mut Framebuffer,
    rect: Rect,
    data: &[u8],
) -> Result<(), DecodeError> {
    // 출력 색공간을 RGB 로 고정한다. 원본이 회색조여도 3채널로 나와 아래 변환이 한 갈래로 끝난다.
    let options = zune_jpeg::zune_core::options::DecoderOptions::default()
        .jpeg_set_out_colorspace(zune_jpeg::zune_core::colorspace::ColorSpace::RGB);
    // 0.5 의 리더는 Seek 을 요구한다(슬라이스는 그것을 만족하지 않는다).
    let mut decoder =
        zune_jpeg::JpegDecoder::new_with_options(std::io::Cursor::new(data), options);
    let rgb = decoder
        .decode()
        .map_err(|_| DecodeError::CorruptStream("Tight: JPEG 를 풀 수 없다"))?;

    let pixels = usize::from(rect.width) * usize::from(rect.height);
    if rgb.len() < pixels * 3 {
        return Err(DecodeError::ShortData {
            expected: pixels * 3,
            got: rgb.len(),
        });
    }
    let mut rgba = vec![0_u8; pixels * 4];
    for (index, chunk) in rgb.chunks_exact(3).take(pixels).enumerate() {
        rgba[index * 4] = chunk[0];
        rgba[index * 4 + 1] = chunk[1];
        rgba[index * 4 + 2] = chunk[2];
        rgba[index * 4 + 3] = 0xFF;
    }
    framebuffer.write_rgba(rect, &rgba)
}

/// 필터를 거친 basic 데이터를 픽셀로 되돌려 사각형에 쓴다.
pub fn apply_basic(
    framebuffer: &mut Framebuffer,
    rect: Rect,
    format: PixelFormat,
    filter: &Filter,
    palette: &[[u8; 4]],
    data: &[u8],
) -> Result<(), DecodeError> {
    let width = usize::from(rect.width);
    let height = usize::from(rect.height);
    let pixels = width * height;
    let mut rgba = vec![0_u8; pixels * 4];

    match filter {
        Filter::Copy => {
            let stride = bytes_per_pixel(format);
            if data.len() < pixels * stride {
                return Err(DecodeError::ShortData {
                    expected: pixels * stride,
                    got: data.len(),
                });
            }
            for (index, chunk) in data.chunks_exact(stride).take(pixels).enumerate() {
                rgba[index * 4..index * 4 + 4].copy_from_slice(&tpixel(chunk, format));
            }
        }
        Filter::Palette => {
            // 색이 둘이면 **1비트**로 온다(행마다 바이트 경계에서 끊긴다). 셋 이상이면 1바이트다.
            if palette.len() == 2 {
                let row_bytes = (width + 7) / 8;
                if data.len() < row_bytes * height {
                    return Err(DecodeError::ShortData {
                        expected: row_bytes * height,
                        got: data.len(),
                    });
                }
                for y in 0..height {
                    for x in 0..width {
                        let byte = data[y * row_bytes + x / 8];
                        let bit = byte & (0x80 >> (x % 8)) != 0;
                        let colour = palette[usize::from(bit)];
                        let at = (y * width + x) * 4;
                        rgba[at..at + 4].copy_from_slice(&colour);
                    }
                }
            } else {
                if data.len() < pixels {
                    return Err(DecodeError::ShortData {
                        expected: pixels,
                        got: data.len(),
                    });
                }
                for (index, value) in data.iter().take(pixels).enumerate() {
                    let colour = palette
                        .get(usize::from(*value))
                        .ok_or(DecodeError::CorruptStream("Tight: 색 표 범위를 넘었다"))?;
                    rgba[index * 4..index * 4 + 4].copy_from_slice(colour);
                }
            }
        }
        Filter::Gradient => {
            apply_gradient(&mut rgba, rect, format, data)?;
        }
    }

    framebuffer.write_rgba(rect, &rgba)
}

/// 그라데이션 필터를 되돌린다.
///
/// 각 채널을 "왼쪽 + 위 - 왼쪽위" 로 예측하고 그 차이만 보낸다. 예측값은 0..255 로 물려야 한다 —
/// 물리지 않으면 밝은 면에서 색이 뒤집힌다.
fn apply_gradient(
    rgba: &mut [u8],
    rect: Rect,
    format: PixelFormat,
    data: &[u8],
) -> Result<(), DecodeError> {
    let width = usize::from(rect.width);
    let height = usize::from(rect.height);
    let stride = bytes_per_pixel(format);
    if stride != 3 {
        // 규격이 24비트 트루컬러에만 이 필터를 정의한다.
        return Err(DecodeError::CorruptStream(
            "Tight: 그라데이션은 24비트에서만 쓸 수 있다",
        ));
    }
    if data.len() < width * height * 3 {
        return Err(DecodeError::ShortData {
            expected: width * height * 3,
            got: data.len(),
        });
    }

    // 이전 행의 복원값을 채널 순서(와이어 순서)대로 들고 있는다.
    let mut previous = vec![0_i32; width * 3];
    let mut current = vec![0_i32; width * 3];
    for y in 0..height {
        for x in 0..width {
            for channel in 0..3 {
                let left = if x > 0 { current[(x - 1) * 3 + channel] } else { 0 };
                let above = previous[x * 3 + channel];
                let above_left = if x > 0 { previous[(x - 1) * 3 + channel] } else { 0 };
                let predicted = (left + above - above_left).clamp(0, 255);
                let difference = i32::from(data[(y * width + x) * 3 + channel]);
                let value = (predicted + difference) & 0xFF;
                current[x * 3 + channel] = value;
            }
            // 와이어의 채널 순서는 TPIXEL 과 같다. 같은 함수로 옮겨 두 경로가 갈리지 않게 한다.
            let wire = [
                current[x * 3] as u8,
                current[x * 3 + 1] as u8,
                current[x * 3 + 2] as u8,
            ];
            let at = (y * width + x) * 4;
            rgba[at..at + 4].copy_from_slice(&tpixel(&wire, format));
        }
        previous.copy_from_slice(&current);
    }
    Ok(())
}

/// zlib 을 거치지 않는 크기인가.
pub fn is_uncompressed(length: usize) -> bool {
    length < MIN_TO_COMPRESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(width: u16, height: u16) -> Rect {
        Rect {
            x: 0,
            y: 0,
            width,
            height,
        }
    }

    #[test]
    fn reads_the_compression_kinds() {
        let mut streams = [
            ZlibStream::new(),
            ZlibStream::new(),
            ZlibStream::new(),
            ZlibStream::new(),
        ];
        assert_eq!(read_control(0x80, &mut streams).unwrap(), Compression::Fill);
        assert_eq!(read_control(0x90, &mut streams).unwrap(), Compression::Jpeg);
        // basic, 스트림 2, 필터 없음.
        assert_eq!(
            read_control(0x20, &mut streams).unwrap(),
            Compression::Basic {
                stream: 2,
                filter: Filter::Copy
            }
        );
        // 예약 값은 거절한다 — 계속 읽으면 그 뒤가 전부 어긋난다.
        assert!(read_control(0xA0, &mut streams).is_err());
    }

    #[test]
    fn knows_when_a_filter_id_follows() {
        // bit 6 이 서면 필터 id 바이트가 본문 앞에 온다. 이걸 놓치면 픽셀이 한 바이트 밀린다.
        assert!(has_filter_id(0x40));
        assert!(!has_filter_id(0x00));
        // fill·jpeg 에는 필터가 없다.
        assert!(!has_filter_id(0x80));
        assert!(!has_filter_id(0x90));
    }

    #[test]
    fn reads_the_variable_length_field() {
        // 1바이트: 최상위 비트가 0.
        assert_eq!(read_compact_length(&mut [0x7F_u8].as_slice()).unwrap(), 127);
        // 2바이트: 0x80 | 0x01, 0x02 → 1 | (2 << 7).
        assert_eq!(
            read_compact_length(&mut [0x81_u8, 0x02].as_slice()).unwrap(),
            1 + (2 << 7)
        );
        // 3바이트.
        assert_eq!(
            read_compact_length(&mut [0x81_u8, 0x82, 0x03].as_slice()).unwrap(),
            1 + (2 << 7) + (3 << 14)
        );
    }

    #[test]
    fn fills_a_solid_rect_from_three_bytes() {
        // TPIXEL 은 3바이트다. 4바이트로 읽으면 화면이 사선으로 밀린다.
        let mut framebuffer = Framebuffer::new(2, 2);
        apply_fill(
            &mut framebuffer,
            rect(2, 2),
            PixelFormat::rgba32(),
            &[10, 20, 30],
        )
        .unwrap();
        assert_eq!(framebuffer.pixel_for_test(1, 1), [10, 20, 30, 0xFF]);
    }

    #[test]
    fn expands_a_two_colour_palette_bit_by_bit() {
        // 색이 둘이면 1비트씩 오고 **행마다 바이트 경계에서 끊긴다**. 그걸 놓치면 폭이 8의 배수가
        // 아닌 사각형에서 줄이 밀린다.
        let mut framebuffer = Framebuffer::new(3, 2);
        let palette = [[1, 2, 3, 0xFF], [9, 9, 9, 0xFF]];
        // 첫 행 101, 둘째 행 010 (각 행이 한 바이트).
        apply_basic(
            &mut framebuffer,
            rect(3, 2),
            PixelFormat::rgba32(),
            &Filter::Palette,
            &palette,
            &[0b1010_0000, 0b0100_0000],
        )
        .unwrap();
        assert_eq!(framebuffer.pixel_for_test(0, 0), [9, 9, 9, 0xFF]);
        assert_eq!(framebuffer.pixel_for_test(1, 0), [1, 2, 3, 0xFF]);
        assert_eq!(framebuffer.pixel_for_test(2, 0), [9, 9, 9, 0xFF]);
        assert_eq!(framebuffer.pixel_for_test(0, 1), [1, 2, 3, 0xFF]);
        assert_eq!(framebuffer.pixel_for_test(1, 1), [9, 9, 9, 0xFF]);
    }

    #[test]
    fn indexes_a_larger_palette_by_byte() {
        let mut framebuffer = Framebuffer::new(2, 1);
        let palette = [
            [0, 0, 0, 0xFF],
            [1, 1, 1, 0xFF],
            [2, 2, 2, 0xFF],
        ];
        apply_basic(
            &mut framebuffer,
            rect(2, 1),
            PixelFormat::rgba32(),
            &Filter::Palette,
            &palette,
            &[2, 0],
        )
        .unwrap();
        assert_eq!(framebuffer.pixel_for_test(0, 0), [2, 2, 2, 0xFF]);
        assert_eq!(framebuffer.pixel_for_test(1, 0), [0, 0, 0, 0xFF]);
    }

    #[test]
    fn refuses_a_palette_index_out_of_range() {
        // 깨진 스트림으로 엉뚱한 색을 그리는 것보다 끊는 편이 낫다.
        let mut framebuffer = Framebuffer::new(1, 1);
        assert!(apply_basic(
            &mut framebuffer,
            rect(1, 1),
            PixelFormat::rgba32(),
            &Filter::Palette,
            &[[0, 0, 0, 0xFF]],
            &[7],
        )
        .is_err());
    }

    #[test]
    fn reverses_the_gradient_prediction() {
        // 첫 픽셀은 예측값 0 이라 차이값이 그대로 색이 된다. 그다음은 왼쪽 예측이 걸린다.
        let mut framebuffer = Framebuffer::new(2, 1);
        apply_basic(
            &mut framebuffer,
            rect(2, 1),
            PixelFormat::rgba32(),
            &Filter::Gradient,
            &[],
            &[10, 20, 30, 5, 5, 5],
        )
        .unwrap();
        assert_eq!(framebuffer.pixel_for_test(0, 0), [10, 20, 30, 0xFF]);
        assert_eq!(framebuffer.pixel_for_test(1, 0), [15, 25, 35, 0xFF]);
    }

    #[test]
    fn wraps_the_gradient_at_255() {
        // 규격이 8비트 안에서 감싸도록 정했다. 물리지 않으면 밝은 면에서 색이 뒤집힌다.
        let mut framebuffer = Framebuffer::new(2, 1);
        apply_basic(
            &mut framebuffer,
            rect(2, 1),
            PixelFormat::rgba32(),
            &Filter::Gradient,
            &[],
            &[250, 0, 0, 10, 0, 0],
        )
        .unwrap();
        assert_eq!(framebuffer.pixel_for_test(1, 0)[0], 4, "250 + 10 = 260 → 4");
    }

    #[test]
    fn computes_the_filtered_length_per_filter() {
        // 이 값이 곧 읽기 경계다. 틀리면 그 뒤 사각형이 전부 어긋난다.
        let format = PixelFormat::rgba32();
        // 색 둘: 1비트씩, 행마다 바이트 경계.
        assert_eq!(
            filtered_length(rect(9, 3), format, &Filter::Palette, 2),
            2 * 3
        );
        // 색 셋 이상: 1바이트씩.
        assert_eq!(
            filtered_length(rect(9, 3), format, &Filter::Palette, 5),
            9 * 3
        );
        // Copy·Gradient: TPIXEL 3바이트.
        assert_eq!(filtered_length(rect(2, 2), format, &Filter::Copy, 0), 12);
        assert_eq!(filtered_length(rect(2, 2), format, &Filter::Gradient, 0), 12);
    }

    #[test]
    fn treats_small_payloads_as_uncompressed() {
        // 이 경계를 빼면 작은 사각형마다 zlib 오류가 난다.
        assert!(is_uncompressed(11));
        assert!(!is_uncompressed(12));
    }

    #[test]
    fn decodes_a_jpeg_rect() {
        // 실제 JPEG 한 장을 만들어 넣는다. 헤더 파싱·색공간 변환까지 한 번에 지나간다.
        let jpeg = make_test_jpeg();
        let mut framebuffer = Framebuffer::new(8, 8);
        apply_jpeg(&mut framebuffer, rect(8, 8), &jpeg).unwrap();
        // 손실 압축이라 값이 정확히 같지는 않다. 빨강 계열인지만 본다.
        let pixel = framebuffer.pixel_for_test(4, 4);
        assert!(pixel[0] > 200, "빨강이 살아 있어야 한다: {pixel:?}");
        assert!(pixel[1] < 60 && pixel[2] < 60, "다른 채널은 낮아야 한다: {pixel:?}");
        assert_eq!(pixel[3], 0xFF, "알파는 채워져야 한다");
    }

    #[test]
    fn refuses_a_broken_jpeg() {
        // JPEG 하나 때문에 세션을 끊지 않도록 오류로 돌려준다(호출부가 판단한다).
        let mut framebuffer = Framebuffer::new(2, 2);
        assert!(apply_jpeg(&mut framebuffer, rect(2, 2), &[0xFF, 0xD8, 0x00]).is_err());
    }

    /// 8x8 빨강 JPEG. 픽스처 파일을 두지 않으려고 바이트를 그대로 박아 둔다.
    ///
    /// 손으로 만든 바이트열로는 안 된다 — 엔트로피 코딩까지 맞아야 색이 나온다(처음에 그렇게
    /// 하려다 회색으로 풀렸다). 이건 실제 인코더가 만든 것이다.
    fn make_test_jpeg() -> Vec<u8> {
        const RED_8X8: &[u8] = &[
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x48,
            0x00, 0x48, 0x00, 0x00, 0xFF, 0xE1, 0x00, 0x4C, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4D, 0x4D,
            0x00, 0x2A, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x87, 0x69, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x1A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xA0, 0x01, 0x00, 0x03, 0x00, 0x00,
            0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xA0, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
            0x00, 0x08, 0xA0, 0x03, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00,
            0x00, 0x00, 0xFF, 0xED, 0x00, 0x38, 0x50, 0x68, 0x6F, 0x74, 0x6F, 0x73, 0x68, 0x6F, 0x70, 0x20,
            0x33, 0x2E, 0x30, 0x00, 0x38, 0x42, 0x49, 0x4D, 0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x38, 0x42, 0x49, 0x4D, 0x04, 0x25, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0xD4, 0x1D, 0x8C, 0xD9,
            0x8F, 0x00, 0xB2, 0x04, 0xE9, 0x80, 0x09, 0x98, 0xEC, 0xF8, 0x42, 0x7E, 0xFF, 0xC0, 0x00, 0x11,
            0x08, 0x00, 0x08, 0x00, 0x08, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF,
            0xC4, 0x00, 0x1F, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B,
            0xFF, 0xC4, 0x00, 0xB5, 0x10, 0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04,
            0x04, 0x00, 0x00, 0x01, 0x7D, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41,
            0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1,
            0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19,
            0x1A, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44,
            0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64,
            0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84,
            0x85, 0x86, 0x87, 0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2,
            0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9,
            0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7,
            0xD8, 0xD9, 0xDA, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3,
            0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFF, 0xC4, 0x00, 0x1F, 0x01, 0x00, 0x03, 0x01, 0x01,
            0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03,
            0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x11, 0x00, 0x02, 0x01,
            0x02, 0x04, 0x04, 0x03, 0x04, 0x07, 0x05, 0x04, 0x04, 0x00, 0x01, 0x02, 0x77, 0x00, 0x01, 0x02,
            0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32,
            0x81, 0x08, 0x14, 0x42, 0x91, 0xA1, 0xB1, 0xC1, 0x09, 0x23, 0x33, 0x52, 0xF0, 0x15, 0x62, 0x72,
            0xD1, 0x0A, 0x16, 0x24, 0x34, 0xE1, 0x25, 0xF1, 0x17, 0x18, 0x19, 0x1A, 0x26, 0x27, 0x28, 0x29,
            0x2A, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53,
            0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73,
            0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A,
            0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8,
            0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6,
            0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE2, 0xE3, 0xE4,
            0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFF,
            0xDB, 0x00, 0x43, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x02, 0x01, 0x01, 0x02, 0x03, 0x02,
            0x02, 0x02, 0x03, 0x04, 0x03, 0x03, 0x03, 0x03, 0x04, 0x05, 0x04, 0x04, 0x04, 0x04, 0x04, 0x05,
            0x06, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x07,
            0x07, 0x07, 0x07, 0x07, 0x07, 0x08, 0x08, 0x08, 0x08, 0x08, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09,
            0x09, 0x09, 0x09, 0x09, 0xFF, 0xDB, 0x00, 0x43, 0x01, 0x01, 0x01, 0x01, 0x02, 0x02, 0x02, 0x04,
            0x02, 0x02, 0x04, 0x09, 0x06, 0x05, 0x06, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09,
            0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09,
            0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09,
            0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0xFF, 0xDD, 0x00, 0x04, 0x00, 0x01, 0xFF,
            0xDA, 0x00, 0x0C, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00, 0xFC, 0x5F, 0xA2,
            0x8A, 0x2B, 0xFC, 0xA7, 0x3F, 0xEF, 0xE0, 0xFF, 0xD9,
        ];
        RED_8X8.to_vec()
    }
}
