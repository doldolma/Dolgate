//! Cursor 의사 인코딩(-239) 해독.
//!
//! **이걸 선언하면 서버는 커서를 화면에 그려 주지 않는다.** 그 대신 모양을 사각형으로 보내고,
//! 그리는 책임이 우리에게 넘어온다 — 받은 모양을 실제로 그리지 않으면 원격 화면에 커서가 아예
//! 보이지 않는다. 얻는 것은 반응성이다: 커서가 네트워크 왕복 없이 로컬에서 움직이고, 모양도
//! 원격이 정한 것(I-빔·크기 조절 화살표)으로 바뀐다.
//!
//! 사각형 헤더의 x·y 는 좌표가 아니라 **핫스팟**이다(그 점이 실제 포인터 위치다). 본문은
//! `픽셀(w*h*bpp) + 마스크(((w+7)/8)*h)` 이고, 마스크는 비트 하나가 픽셀 하나의 불투명 여부다.

use crate::decode::{DecodeError, Rect};
use crate::rfb::PixelFormat;

/// 우리가 받아들이는 커서 한 변의 최대 길이.
///
/// 규격에 상한이 없다. 실제 커서는 32~64px 이고 그보다 큰 값은 깨진 스트림이나 악의적인 서버다 —
/// 65535x65535 를 그대로 믿으면 그 자리에서 16GB 를 할당한다.
const MAX_SIDE: u16 = 512;

/// 서버가 보낸 커서 모양.
#[derive(Debug, PartialEq, Eq)]
pub struct Cursor {
    /// 포인터의 실제 위치가 되는 점(모양 안에서의 좌표).
    pub hotspot_x: u16,
    pub hotspot_y: u16,
    pub width: u16,
    pub height: u16,
    /// `width * height * 4` 바이트. 마스크가 0 인 픽셀은 알파도 0 이다.
    pub rgba: Vec<u8>,
}

impl Cursor {
    /// 커서를 숨기라는 뜻인가.
    ///
    /// 서버는 0x0 사각형으로 "커서 없음" 을 알린다(전체화면 영상 재생 등). 빈 모양을 그리는 것과
    /// 숨기는 것은 다르다 — 숨길 때는 로컬 포인터까지 감춰야 원격과 같아 보인다.
    pub fn is_hidden(&self) -> bool {
        self.width == 0 || self.height == 0
    }
}

/// 본문 크기. 호출부가 읽을 바이트 수를 먼저 알아야 한다(스트림에는 길이 필드가 없다).
pub fn body_length(rect: Rect, format: PixelFormat) -> usize {
    let pixels = usize::from(rect.width) * usize::from(rect.height);
    pixels * format.bytes_per_pixel() + mask_length(rect.width, rect.height)
}

/// Validate the cursor dimensions before trusting them as an allocation length.
pub fn checked_body_length(rect: Rect, format: PixelFormat) -> Option<usize> {
    if rect.width > MAX_SIDE || rect.height > MAX_SIDE {
        return None;
    }
    let pixels = usize::from(rect.width).checked_mul(usize::from(rect.height))?;
    let pixel_bytes = pixels.checked_mul(format.bytes_per_pixel())?;
    pixel_bytes.checked_add(mask_length(rect.width, rect.height))
}

fn mask_length(width: u16, height: u16) -> usize {
    // 한 행이 바이트 경계에서 끝난다 — 폭이 8의 배수가 아니면 남는 비트는 패딩이다.
    (usize::from(width) + 7) / 8 * usize::from(height)
}

/// 본문을 RGBA 커서로 옮긴다.
///
/// 크기가 상한을 넘으면 `None` 이다. **호출부는 그래도 본문을 다 읽어야 한다** — 남기면 다음
/// 사각형 경계가 어긋나 세션이 통째로 깨진다.
pub fn decode(rect: Rect, format: PixelFormat, body: &[u8]) -> Option<Cursor> {
    if rect.width > MAX_SIDE || rect.height > MAX_SIDE {
        return None;
    }
    if rect.width == 0 || rect.height == 0 {
        return Some(Cursor {
            hotspot_x: rect.x,
            hotspot_y: rect.y,
            width: 0,
            height: 0,
            rgba: Vec::new(),
        });
    }

    let pixels = usize::from(rect.width) * usize::from(rect.height);
    let pixel_bytes = pixels * format.bytes_per_pixel();
    if body.len() < pixel_bytes + mask_length(rect.width, rect.height) {
        return None;
    }

    let mut rgba = match crate::decode::to_rgba(&body[..pixel_bytes], pixels, format) {
        Ok(rgba) => rgba,
        Err(DecodeError::UnsupportedPixelFormat(_)) | Err(_) => return None,
    };

    // 마스크로 알파를 덮는다. 이걸 안 하면 커서의 투명한 바깥이 검은 사각형으로 남는다.
    let stride = (usize::from(rect.width) + 7) / 8;
    let mask = &body[pixel_bytes..];
    for y in 0..usize::from(rect.height) {
        for x in 0..usize::from(rect.width) {
            // 비트는 **MSB 부터** 왼쪽 픽셀에 대응한다.
            let byte = mask[y * stride + x / 8];
            let opaque = byte & (0x80 >> (x % 8)) != 0;
            if !opaque {
                rgba[(y * usize::from(rect.width) + x) * 4 + 3] = 0;
            }
        }
    }

    Some(Cursor {
        hotspot_x: rect.x,
        hotspot_y: rect.y,
        width: rect.width,
        height: rect.height,
        rgba,
    })
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

    #[test]
    fn body_length_counts_pixels_and_the_padded_mask() {
        // 폭 9 는 마스크 한 행이 2바이트다(9비트가 두 바이트에 걸친다). 이 계산이 1바이트라도
        // 틀리면 다음 사각형 경계가 어긋나 세션이 깨진다.
        assert_eq!(
            body_length(rect(0, 0, 9, 3), PixelFormat::rgba32()),
            9 * 3 * 4 + 2 * 3
        );
        assert_eq!(body_length(rect(0, 0, 8, 1), PixelFormat::rgba32()), 32 + 1);
        assert_eq!(body_length(rect(0, 0, 0, 0), PixelFormat::rgba32()), 0);
    }

    #[test]
    fn checked_body_length_rejects_an_oversized_cursor() {
        assert_eq!(
            checked_body_length(rect(0, 0, 512, 512), PixelFormat::rgba32()),
            Some(512 * 512 * 4 + 64 * 512)
        );
        assert_eq!(
            checked_body_length(rect(0, 0, 513, 1), PixelFormat::rgba32()),
            None
        );
    }

    #[test]
    fn masks_out_transparent_pixels() {
        // 2x1 커서. 왼쪽만 불투명(마스크 0b1000_0000).
        let mut body = Vec::new();
        body.extend_from_slice(&[10, 20, 30, 0]); // 왼쪽 픽셀
        body.extend_from_slice(&[40, 50, 60, 0]); // 오른쪽 픽셀
        body.push(0b1000_0000);

        let cursor = decode(rect(1, 0, 2, 1), PixelFormat::rgba32(), &body).unwrap();
        assert_eq!(cursor.hotspot_x, 1);
        assert_eq!(cursor.rgba, vec![10, 20, 30, 0xFF, 40, 50, 60, 0x00]);
        assert!(!cursor.is_hidden());
    }

    #[test]
    fn reads_the_mask_most_significant_bit_first() {
        // 9픽셀 한 행. 마스크 두 바이트에서 첫 픽셀과 마지막(9번째) 픽셀만 불투명하다.
        let mut body = vec![0_u8; 9 * 4];
        for (index, chunk) in body.chunks_exact_mut(4).enumerate() {
            chunk[0] = index as u8;
        }
        body.push(0b1000_0000);
        body.push(0b1000_0000);

        let cursor = decode(rect(0, 0, 9, 1), PixelFormat::rgba32(), &body).unwrap();
        let alphas: Vec<u8> = cursor.rgba.chunks_exact(4).map(|pixel| pixel[3]).collect();
        assert_eq!(alphas, vec![255, 0, 0, 0, 0, 0, 0, 0, 255]);
    }

    #[test]
    fn treats_an_empty_rect_as_hide() {
        // 서버가 "커서 없음" 을 이렇게 알린다. 핫스팟은 그대로 실려 온다.
        let cursor = decode(rect(0, 0, 0, 0), PixelFormat::rgba32(), &[]).unwrap();
        assert!(cursor.is_hidden());
        assert!(cursor.rgba.is_empty());
    }

    #[test]
    fn refuses_an_absurd_size_and_a_short_body() {
        // 크기를 그대로 믿으면 그 자리에서 기가바이트를 할당한다.
        assert!(decode(rect(0, 0, 4096, 4096), PixelFormat::rgba32(), &[]).is_none());
        // 본문이 모자라면 조용히 포기한다 — 커서 하나 때문에 화면을 끊지 않는다.
        assert!(decode(rect(0, 0, 2, 1), PixelFormat::rgba32(), &[0; 4]).is_none());
    }

    #[test]
    fn converts_a_servers_own_pixel_format() {
        // SetPixelFormat 을 무시하는 서버가 있다(오래된 BMC 펌웨어). 커서도 같은 규칙으로 푼다.
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
        // 빨강 최대값만 세운 픽셀 하나.
        let mut body = (0b11111_000000_00000_u16).to_le_bytes().to_vec();
        body.push(0b1000_0000);

        let cursor = decode(rect(0, 0, 1, 1), format, &body).unwrap();
        assert_eq!(cursor.rgba, vec![255, 0, 0, 255]);
    }
}
