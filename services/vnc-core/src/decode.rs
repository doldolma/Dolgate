//! 프레임버퍼와 사각형 디코더.
//!
//! 프레임버퍼는 항상 RGBA 로 들고 있는다. 렌더러가 그 형태를 기대하고([rdp-core protocol.rs 의
//! FramePayload] 와 같은 계약), 서버 포맷이 무엇이든 여기서 한 번만 변환하면 그 뒤 모든 경로가
//! 변환을 모른다.
//!
//! **알파는 우리가 채운다.** RFB 에는 알파가 없고 32비트 픽셀의 남는 바이트는 규격상 정의되지
//! 않은 패딩이다. 서버가 거기에 0 을 넣으면 알파 0 이 되어 화면이 통째로 투명해진다.

use crate::rfb::PixelFormat;

/// 화면에서 갱신된 영역. 이 좌표가 그대로 stream frame 메타데이터가 된다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug)]
pub struct Framebuffer {
    width: u16,
    height: u16,
    /// width * height * 4 바이트의 RGBA.
    pixels: Vec<u8>,
}

impl Framebuffer {
    pub fn new(width: u16, height: u16) -> Self {
        Self {
            width,
            height,
            pixels: vec![0_u8; usize::from(width) * usize::from(height) * 4],
        }
    }

    pub fn width(&self) -> u16 {
        self.width
    }

    pub fn height(&self) -> u16 {
        self.height
    }

    /// 크기를 바꾼다. 내용은 버린다 — 서버가 곧 전체를 다시 보낸다.
    pub fn resize(&mut self, width: u16, height: u16) {
        self.width = width;
        self.height = height;
        self.pixels = vec![0_u8; usize::from(width) * usize::from(height) * 4];
    }

    fn offset(&self, x: u16, y: u16) -> usize {
        (usize::from(y) * usize::from(self.width) + usize::from(x)) * 4
    }

    /// 프레임버퍼 안에 완전히 들어오는 사각형인가.
    ///
    /// 서버를 신뢰하지 않는다. 범위를 넘는 사각형을 그대로 쓰면 패닉이나 엉뚱한 메모리 덮어쓰기가
    /// 되고, 오래된 서버·BMC 펌웨어가 실제로 그런 값을 보낸다.
    fn contains(&self, rect: Rect) -> bool {
        usize::from(rect.x) + usize::from(rect.width) <= usize::from(self.width)
            && usize::from(rect.y) + usize::from(rect.height) <= usize::from(self.height)
    }

    /// 사각형 영역을 빽빽한 RGBA 로 꺼낸다. 이게 stream frame 의 페이로드가 된다.
    pub fn extract(&self, rect: Rect) -> Option<Vec<u8>> {
        if !self.contains(rect) {
            return None;
        }
        let row_bytes = usize::from(rect.width) * 4;
        let mut out = Vec::with_capacity(row_bytes * usize::from(rect.height));
        for row in 0..rect.height {
            let start = self.offset(rect.x, rect.y + row);
            out.extend_from_slice(&self.pixels[start..start + row_bytes]);
        }
        Some(out)
    }

    #[cfg(test)]
    fn pixel(&self, x: u16, y: u16) -> [u8; 4] {
        self.pixel_for_test(x, y)
    }

    /// 한 픽셀을 읽는다. 다른 모듈의 테스트가 결과를 확인하는 데 쓴다.
    ///
    /// 바이너리에서는 쓰이지 않아 죽은 코드로 보인다 — 테스트 전용이라는 사실을 이름과 이 표시로
    /// 남긴다(cfg(test) 로 감추면 다른 모듈의 테스트에서 못 쓴다).
    #[doc(hidden)]
    #[allow(dead_code)]
    pub fn pixel_for_test(&self, x: u16, y: u16) -> [u8; 4] {
        let start = self.offset(x, y);
        let mut out = [0_u8; 4];
        out.copy_from_slice(&self.pixels[start..start + 4]);
        out
    }

    /// 사각형을 한 색으로 채운다(ZRLE 단색 타일).
    pub fn fill(&mut self, rect: Rect, colour: [u8; 4]) -> Result<(), DecodeError> {
        if !self.contains(rect) {
            return Err(DecodeError::RectOutOfBounds(rect));
        }
        for row in 0..rect.height {
            let start = self.offset(rect.x, rect.y + row);
            for pixel in self.pixels[start..start + usize::from(rect.width) * 4].chunks_exact_mut(4)
            {
                pixel.copy_from_slice(&colour);
            }
        }
        Ok(())
    }

    /// 이미 RGBA 로 풀린 사각형을 그대로 옮긴다(디코더가 변환까지 끝낸 경우).
    pub fn write_rgba(&mut self, rect: Rect, pixels: &[u8]) -> Result<(), DecodeError> {
        if !self.contains(rect) {
            return Err(DecodeError::RectOutOfBounds(rect));
        }
        let expected = usize::from(rect.width) * usize::from(rect.height) * 4;
        if pixels.len() != expected {
            return Err(DecodeError::ShortData {
                expected,
                got: pixels.len(),
            });
        }
        let row_bytes = usize::from(rect.width) * 4;
        for row in 0..rect.height {
            let source = usize::from(row) * row_bytes;
            let target = self.offset(rect.x, rect.y + row);
            self.pixels[target..target + row_bytes]
                .copy_from_slice(&pixels[source..source + row_bytes]);
        }
        Ok(())
    }

    /// Raw 인코딩: 사각형 크기만큼의 픽셀이 그대로 온다.
    pub fn apply_raw(
        &mut self,
        rect: Rect,
        format: PixelFormat,
        data: &[u8],
    ) -> Result<(), DecodeError> {
        if !self.contains(rect) {
            return Err(DecodeError::RectOutOfBounds(rect));
        }
        let bytes_per_pixel = format.bytes_per_pixel();
        let expected = usize::from(rect.width) * usize::from(rect.height) * bytes_per_pixel;
        if data.len() != expected {
            return Err(DecodeError::ShortData {
                expected,
                got: data.len(),
            });
        }

        for row in 0..rect.height {
            let source_start = usize::from(row) * usize::from(rect.width) * bytes_per_pixel;
            let target_start = self.offset(rect.x, rect.y + row);
            let source_row =
                &data[source_start..source_start + usize::from(rect.width) * bytes_per_pixel];
            let target_row =
                &mut self.pixels[target_start..target_start + usize::from(rect.width) * 4];
            convert_row(source_row, target_row, format)?;
        }
        Ok(())
    }

    /// CopyRect: 화면 안의 다른 위치에서 복사한다. 스크롤이 이걸로 온다.
    ///
    /// 원본과 대상이 겹칠 수 있으므로 행 단위로 방향을 골라 복사한다 — 위로 스크롤할 때 위에서부터
    /// 복사하면 아직 읽어야 할 행을 덮어쓴다.
    pub fn apply_copy_rect(
        &mut self,
        rect: Rect,
        source_x: u16,
        source_y: u16,
    ) -> Result<(), DecodeError> {
        let source = Rect {
            x: source_x,
            y: source_y,
            width: rect.width,
            height: rect.height,
        };
        if !self.contains(rect) || !self.contains(source) {
            return Err(DecodeError::RectOutOfBounds(rect));
        }
        let row_bytes = usize::from(rect.width) * 4;
        let downward = rect.y > source_y;
        for index in 0..rect.height {
            let row = if downward { rect.height - 1 - index } else { index };
            let from = self.offset(source_x, source_y + row);
            let to = self.offset(rect.x, rect.y + row);
            // 같은 버퍼 안의 이동이라 copy_within 을 쓴다(겹침을 허용한다).
            self.pixels.copy_within(from..from + row_bytes, to);
        }
        Ok(())
    }
}

/// 한 행을 서버 포맷에서 RGBA 로 옮긴다.
fn convert_row(source: &[u8], target: &mut [u8], format: PixelFormat) -> Result<(), DecodeError> {
    if !format.true_colour {
        // 팔레트(컬러맵) 모드다. SetColourMapEntries 를 들고 있어야 풀 수 있어 지금은 다루지
        // 않는다 — 우리가 SetPixelFormat 으로 트루컬러를 요구하므로 정상 경로에서는 오지 않는다.
        return Err(DecodeError::UnsupportedPixelFormat(format));
    }
    let bytes_per_pixel = format.bytes_per_pixel();

    // 빠른 경로: 우리가 요구한 그대로면 알파만 채운다.
    if format.is_rgba32() {
        for (pixel, out) in source.chunks_exact(4).zip(target.chunks_exact_mut(4)) {
            out[0] = pixel[0];
            out[1] = pixel[1];
            out[2] = pixel[2];
            out[3] = 0xFF;
        }
        return Ok(());
    }

    // 일반 경로: SetPixelFormat 을 무시하는 서버(오래된 BMC 펌웨어가 그렇다)를 위해 시프트·최대값
    // 으로 직접 뽑는다. 8비트로 늘릴 때 최대값으로 나누므로 16비트 하이컬러도 맞는다.
    for (pixel, out) in source
        .chunks_exact(bytes_per_pixel)
        .zip(target.chunks_exact_mut(4))
    {
        let mut value: u32 = 0;
        if format.big_endian {
            for byte in pixel {
                value = (value << 8) | u32::from(*byte);
            }
        } else {
            for byte in pixel.iter().rev() {
                value = (value << 8) | u32::from(*byte);
            }
        }
        out[0] = scale(value >> format.red_shift & u32::from(format.red_max), format.red_max);
        out[1] = scale(
            value >> format.green_shift & u32::from(format.green_max),
            format.green_max,
        );
        out[2] = scale(
            value >> format.blue_shift & u32::from(format.blue_max),
            format.blue_max,
        );
        out[3] = 0xFF;
    }
    Ok(())
}

/// 채널 값을 0..=255 로 늘린다.
fn scale(value: u32, max: u16) -> u8 {
    if max == 0 {
        return 0;
    }
    if max == 255 {
        return value as u8;
    }
    ((value * 255) / u32::from(max)) as u8
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    RectOutOfBounds(Rect),
    ShortData { expected: usize, got: usize },
    UnsupportedPixelFormat(PixelFormat),
    /// 압축 스트림이나 타일 데이터가 규격과 맞지 않는다. 어디서 어긋났는지 이름을 남긴다.
    CorruptStream(&'static str),
    /// 규격에 없는(또는 예약된) ZRLE 타일 방식이다.
    UnsupportedZrleSubencoding(u8),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RectOutOfBounds(rect) => write!(
                f,
                "서버가 화면 밖의 사각형을 보냈습니다({},{} {}x{})",
                rect.x, rect.y, rect.width, rect.height
            ),
            Self::ShortData { expected, got } => {
                write!(f, "사각형 데이터 길이가 맞지 않습니다(기대 {expected}, 받음 {got})")
            }
            Self::CorruptStream(where_) => {
                write!(f, "서버가 보낸 압축 데이터가 규격과 맞지 않습니다({where_})")
            }
            Self::UnsupportedZrleSubencoding(value) => {
                write!(f, "다룰 수 없는 ZRLE 타일 방식입니다({value})")
            }
            Self::UnsupportedPixelFormat(format) => write!(
                f,
                "다룰 수 없는 픽셀 포맷입니다({}bpp, true_colour={})",
                format.bits_per_pixel, format.true_colour
            ),
        }
    }
}

impl std::error::Error for DecodeError {}

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

    // 서버가 채워 주지 않는 알파를 우리가 255 로 채워야 한다. 안 그러면 화면이 통째로 투명해진다.
    #[test]
    fn raw_fills_alpha_even_when_the_server_sends_zero_padding() {
        let mut framebuffer = Framebuffer::new(2, 1);
        let data = vec![
            10, 20, 30, 0, // R,G,B,패딩(0)
            40, 50, 60, 0,
        ];
        framebuffer
            .apply_raw(rect(0, 0, 2, 1), PixelFormat::rgba32(), &data)
            .unwrap();
        assert_eq!(framebuffer.pixel(0, 0), [10, 20, 30, 0xFF]);
        assert_eq!(framebuffer.pixel(1, 0), [40, 50, 60, 0xFF]);
    }

    #[test]
    fn raw_writes_only_inside_the_rect() {
        let mut framebuffer = Framebuffer::new(3, 3);
        let data = vec![1, 2, 3, 0];
        framebuffer
            .apply_raw(rect(1, 1, 1, 1), PixelFormat::rgba32(), &data)
            .unwrap();
        assert_eq!(framebuffer.pixel(1, 1), [1, 2, 3, 0xFF]);
        assert_eq!(framebuffer.pixel(0, 0), [0, 0, 0, 0]);
        assert_eq!(framebuffer.pixel(2, 2), [0, 0, 0, 0]);
    }

    // 서버를 신뢰하지 않는다. 범위를 넘는 사각형은 패닉이 아니라 오류여야 한다.
    #[test]
    fn refuses_a_rect_outside_the_framebuffer() {
        let mut framebuffer = Framebuffer::new(2, 2);
        let data = vec![0_u8; 4 * 4];
        let error = framebuffer
            .apply_raw(rect(1, 1, 2, 2), PixelFormat::rgba32(), &data)
            .unwrap_err();
        assert!(matches!(error, DecodeError::RectOutOfBounds(_)));
        assert!(framebuffer.extract(rect(1, 1, 2, 2)).is_none());
    }

    #[test]
    fn refuses_data_that_does_not_match_the_rect() {
        let mut framebuffer = Framebuffer::new(4, 4);
        let error = framebuffer
            .apply_raw(rect(0, 0, 2, 2), PixelFormat::rgba32(), &[0_u8; 8])
            .unwrap_err();
        assert_eq!(
            error,
            DecodeError::ShortData {
                expected: 16,
                got: 8
            }
        );
    }

    // 스크롤이 이 경로로 온다. 겹치는 이동에서 아직 읽어야 할 행을 덮어쓰면 화면이 번진다.
    #[test]
    fn copy_rect_handles_overlapping_downward_moves() {
        let mut framebuffer = Framebuffer::new(1, 4);
        for row in 0..4_u16 {
            framebuffer
                .apply_raw(
                    rect(0, row, 1, 1),
                    PixelFormat::rgba32(),
                    &[row as u8 + 1, 0, 0, 0],
                )
                .unwrap();
        }
        // 위 세 줄을 한 줄 아래로 옮긴다(원본과 대상이 두 줄 겹친다).
        framebuffer.apply_copy_rect(rect(0, 1, 1, 3), 0, 0).unwrap();
        assert_eq!(framebuffer.pixel(0, 1)[0], 1);
        assert_eq!(framebuffer.pixel(0, 2)[0], 2);
        assert_eq!(framebuffer.pixel(0, 3)[0], 3);
    }

    #[test]
    fn copy_rect_handles_overlapping_upward_moves() {
        let mut framebuffer = Framebuffer::new(1, 4);
        for row in 0..4_u16 {
            framebuffer
                .apply_raw(
                    rect(0, row, 1, 1),
                    PixelFormat::rgba32(),
                    &[row as u8 + 1, 0, 0, 0],
                )
                .unwrap();
        }
        framebuffer.apply_copy_rect(rect(0, 0, 1, 3), 0, 1).unwrap();
        assert_eq!(framebuffer.pixel(0, 0)[0], 2);
        assert_eq!(framebuffer.pixel(0, 1)[0], 3);
        assert_eq!(framebuffer.pixel(0, 2)[0], 4);
    }

    #[test]
    fn extract_returns_tightly_packed_rows() {
        let mut framebuffer = Framebuffer::new(3, 2);
        framebuffer
            .apply_raw(
                rect(1, 0, 2, 2),
                PixelFormat::rgba32(),
                &[9, 9, 9, 0, 8, 8, 8, 0, 7, 7, 7, 0, 6, 6, 6, 0],
            )
            .unwrap();
        let pixels = framebuffer.extract(rect(1, 0, 2, 2)).unwrap();
        // 행마다 rect 폭만큼만, 프레임버퍼 stride 없이 붙어 나와야 한다.
        assert_eq!(pixels.len(), 2 * 2 * 4);
        assert_eq!(&pixels[0..4], &[9, 9, 9, 0xFF]);
        assert_eq!(&pixels[4..8], &[8, 8, 8, 0xFF]);
        assert_eq!(&pixels[8..12], &[7, 7, 7, 0xFF]);
    }

    // SetPixelFormat 을 무시하는 서버(오래된 BMC 펌웨어)를 위한 일반 경로.
    #[test]
    fn converts_16bit_high_colour_from_the_servers_own_format() {
        let format = PixelFormat {
            bits_per_pixel: 16,
            depth: 16,
            big_endian: false,
            true_colour: true,
            red_max: 31,
            green_max: 63,
            blue_max: 31,
            red_shift: 11,
            green_shift: 5,
            blue_shift: 0,
        };
        let mut framebuffer = Framebuffer::new(1, 1);
        // 빨강 최대치: red=31, green=0, blue=0 → 0xF800
        framebuffer
            .apply_raw(rect(0, 0, 1, 1), format, &0xF800_u16.to_le_bytes())
            .unwrap();
        assert_eq!(framebuffer.pixel(0, 0), [255, 0, 0, 0xFF]);
    }

    #[test]
    fn resize_replaces_the_surface() {
        let mut framebuffer = Framebuffer::new(2, 2);
        framebuffer
            .apply_raw(rect(0, 0, 1, 1), PixelFormat::rgba32(), &[1, 2, 3, 0])
            .unwrap();
        framebuffer.resize(4, 1);
        assert_eq!((framebuffer.width(), framebuffer.height()), (4, 1));
        // 내용은 버린다 — 서버가 곧 전체를 다시 보낸다.
        assert_eq!(framebuffer.pixel(0, 0), [0, 0, 0, 0]);
    }
}
