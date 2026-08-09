//! NSCodec bitmap decoder ([MS-RDPNSC]).
//!
//! PATCH (Dolgate): upstream has no NSCodec decoder at all, and ClearCodec silently skipped the
//! subcodec tiles that use it — a real Windows server sends photographic regions that way, so
//! every image on screen came out as an empty rectangle with no error to explain it.
//!
//! The image is carried as four planes in the AYCoCg colour space: luma, orange chroma, green
//! chroma and an optional alpha. Each plane is either raw or RLE compressed, the chroma planes may
//! be half resolution, and their range is scaled down by the colour loss level.
//!
//! [MS-RDPNSC]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpnsc/

use ironrdp_core::{DecodeResult, ReadCursor, cast_length, ensure_size, invalid_field_err};

/// Four plane byte counts, colour loss level, subsampling flag, two reserved bytes.
const HEADER_SIZE: usize = 4 * 4 + 1 + 1 + 2;

/// The last four bytes of every plane are stored raw (NSCODEC_RLE_SEGMENTS::EndData).
const END_DATA_SIZE: usize = 4;

fn round_up(value: usize, multiple: usize) -> usize {
    value.div_ceil(multiple) * multiple
}

/// Decode an NSCodec bitmap into BGRA, row-major, `width * height * 4` bytes.
///
/// Alpha is forced opaque: the surfaces this feeds are opaque, and the callers composite BGRA.
pub fn decode(data: &[u8], width: u16, height: u16) -> DecodeResult<Vec<u8>> {
    let w = usize::from(width);
    let h = usize::from(height);
    if w == 0 || h == 0 {
        return Err(invalid_field_err!("dimensions", "NSCodec tile has a zero dimension"));
    }

    let mut src = ReadCursor::new(data);
    ensure_size!(ctx: "NsCodecHeader", in: src, size: HEADER_SIZE);

    let luma_byte_count: usize = cast_length!("LumaPlaneByteCount", src.read_u32())?;
    let orange_byte_count: usize = cast_length!("OrangeChromaPlaneByteCount", src.read_u32())?;
    let green_byte_count: usize = cast_length!("GreenChromaPlaneByteCount", src.read_u32())?;
    let alpha_byte_count: usize = cast_length!("AlphaPlaneByteCount", src.read_u32())?;
    let color_loss_level = src.read_u8();
    let subsampling = src.read_u8() != 0;
    let _reserved = src.read_u16();

    if !(1..=7).contains(&color_loss_level) {
        return Err(invalid_field_err!("ColorLossLevel", "colour loss level is outside 1-7"));
    }

    // Plane geometry per MS-RDPNSC 2.2.2. Subsampling rounds the luma width up to a multiple of 8
    // and halves the chroma planes, so the strides differ from the tile width.
    let (luma_stride, chroma_stride, chroma_height) = if subsampling {
        let stride = round_up(w, 8);
        (stride, stride / 2, round_up(h, 2) / 2)
    } else {
        (w, w, h)
    };

    let luma = read_plane(&mut src, "LumaPlane", luma_byte_count, luma_stride * h)?;
    let orange = read_plane(&mut src, "OrangeChromaPlane", orange_byte_count, chroma_stride * chroma_height)?;
    let green = read_plane(&mut src, "GreenChromaPlane", green_byte_count, chroma_stride * chroma_height)?;
    if alpha_byte_count > 0 {
        // Present but unused: everything downstream is opaque. Skipping it keeps the cursor honest
        // in case a caller ever reads past this stream.
        let _alpha = read_plane(&mut src, "AlphaPlane", alpha_byte_count, w * h)?;
    }

    // Colour loss reduction: the encoder shifted the chroma range down, so shift it back. The
    // result is deliberately truncated to a signed byte — the shift can carry out of eight bits and
    // the wrap is part of the format.
    let shift = color_loss_level - 1;

    let mut output = vec![0u8; w * h * 4];
    for y in 0..h {
        let luma_row = y * luma_stride;
        let chroma_row = if subsampling { (y / 2) * chroma_stride } else { y * chroma_stride };

        for x in 0..w {
            let chroma_index = chroma_row + if subsampling { x / 2 } else { x };

            let luma_value = i32::from(*luma.get(luma_row + x).unwrap_or(&0));
            let orange_value = i32::from(scale(*orange.get(chroma_index).unwrap_or(&0), shift));
            let green_value = i32::from(scale(*green.get(chroma_index).unwrap_or(&0), shift));

            // AYCoCg -> RGB ([MS-RDPEGDI] 3.1.9.1.2).
            let red = luma_value + orange_value - green_value;
            let grn = luma_value + green_value;
            let blue = luma_value - orange_value - green_value;

            let at = (y * w + x) * 4;
            output[at] = clamp(blue);
            output[at + 1] = clamp(grn);
            output[at + 2] = clamp(red);
            output[at + 3] = 0xFF;
        }
    }

    Ok(output)
}

fn scale(value: u8, shift: u8) -> i8 {
    // Truncate to eight bits first, then read as signed — the chroma planes are signed values that
    // the encoder narrowed, and the high bits the shift produces are not part of the value.
    #[expect(clippy::cast_possible_truncation, reason = "the wrap is the format")]
    let narrowed = (u32::from(value) << shift) as u8;
    #[expect(clippy::cast_possible_wrap, reason = "chroma is a signed quantity")]
    let signed = narrowed as i8;
    signed
}

fn clamp(value: i32) -> u8 {
    #[expect(clippy::cast_possible_truncation, reason = "clamped to 0..=255 first")]
    let clamped = value.clamp(0, 0xFF) as u8;
    clamped
}

/// Read one plane, expanding it if it was RLE compressed.
///
/// A plane is raw when its byte count equals the uncompressed size, and compressed when it is
/// smaller. Larger means the stream disagrees with the geometry we derived, which is not something
/// to guess at.
fn read_plane(
    src: &mut ReadCursor<'_>,
    ctx: &'static str,
    byte_count: usize,
    raw_size: usize,
) -> DecodeResult<Vec<u8>> {
    if byte_count > raw_size {
        return Err(invalid_field_err!("PlaneByteCount", "plane is larger than its uncompressed size"));
    }

    ensure_size!(ctx: ctx, in: src, size: byte_count);
    let encoded = src.read_slice(byte_count);

    if byte_count == raw_size {
        return Ok(encoded.to_vec());
    }

    rle_decode(encoded, raw_size)
}

/// Expand NSCODEC_RLE_SEGMENTS into a plane of exactly `raw_size` bytes.
///
/// A run is a byte repeated immediately (RunValue == RunConfirm) followed by a length; anything
/// else is a literal byte. The last four bytes of the plane are always stored raw, so the loop
/// stops short of them.
fn rle_decode(encoded: &[u8], raw_size: usize) -> DecodeResult<Vec<u8>> {
    if raw_size < END_DATA_SIZE || encoded.len() < END_DATA_SIZE {
        return Err(invalid_field_err!("NsCodecRle", "plane is too small to hold the raw tail"));
    }

    let mut output = Vec::with_capacity(raw_size);
    let mut read = 0usize;
    // Everything but the trailing raw bytes.
    let body_end = encoded.len() - END_DATA_SIZE;
    let body_target = raw_size - END_DATA_SIZE;

    while output.len() < body_target {
        if read >= body_end {
            return Err(invalid_field_err!("NsCodecRle", "segments ended before the plane was filled"));
        }

        let value = encoded[read];
        // A run needs the confirming copy, so a single byte left can only be a literal.
        let is_run = read + 1 < body_end && encoded[read + 1] == value;
        if !is_run {
            output.push(value);
            read += 1;
            continue;
        }

        read += 2;
        // The length bytes are part of the segment stream, so they must stay clear of the raw
        // tail — a malformed run must not be allowed to eat it.
        if read >= body_end {
            return Err(invalid_field_err!("NsCodecRle", "run segment is missing its length"));
        }

        let factor1 = encoded[read];
        read += 1;
        let run_length = if factor1 < 0xFF {
            usize::from(factor1) + 2
        } else {
            if read + 4 > body_end {
                return Err(invalid_field_err!("NsCodecRle", "run segment is missing its long length"));
            }
            let long = u32::from_le_bytes([
                encoded[read],
                encoded[read + 1],
                encoded[read + 2],
                encoded[read + 3],
            ]);
            read += 4;
            cast_length!("RunLengthFactor2", long)?
        };

        // A run that overshoots would either allocate wildly or write past the plane.
        let remaining = body_target - output.len();
        if run_length > remaining {
            return Err(invalid_field_err!("NsCodecRle", "run runs past the end of the plane"));
        }
        output.resize(output.len() + run_length, value);
    }

    // EndData: the last four bytes of the plane, stored raw.
    output.extend_from_slice(&encoded[encoded.len() - END_DATA_SIZE..]);

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Header with the four plane byte counts, colour loss level and subsampling flag.
    fn header(luma: u32, orange: u32, green: u32, alpha: u32, loss: u8, subsampling: bool) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&luma.to_le_bytes());
        data.extend_from_slice(&orange.to_le_bytes());
        data.extend_from_slice(&green.to_le_bytes());
        data.extend_from_slice(&alpha.to_le_bytes());
        data.push(loss);
        data.push(u8::from(subsampling));
        data.extend_from_slice(&[0, 0]); // reserved
        data
    }

    #[test]
    fn decodes_raw_planes_without_subsampling() {
        // 2x2, no subsampling, colour loss level 1 (shift 0) so the chroma passes through.
        // Luma 0x80 with zero chroma is a mid grey.
        let luma = vec![0x80u8; 4];
        let chroma = vec![0x00u8; 4];

        let mut data = header(4, 4, 4, 0, 1, false);
        data.extend_from_slice(&luma);
        data.extend_from_slice(&chroma);
        data.extend_from_slice(&chroma);

        let pixels = decode(&data, 2, 2).unwrap();

        assert_eq!(pixels.len(), 2 * 2 * 4);
        for pixel in pixels.chunks_exact(4) {
            assert_eq!(pixel, &[0x80, 0x80, 0x80, 0xFF]);
        }
    }

    #[test]
    fn applies_the_colour_transform() {
        // Y = 0x40, Co = 0x40, Cg = 0x00 -> R = Y + Co = 0x80, G = Y, B = Y - Co = 0x00.
        let mut data = header(4, 4, 4, 0, 1, false);
        data.extend_from_slice(&[0x40u8; 4]); // luma
        data.extend_from_slice(&[0x40u8; 4]); // orange chroma
        data.extend_from_slice(&[0x00u8; 4]); // green chroma

        let pixels = decode(&data, 2, 2).unwrap();

        // BGRA.
        assert_eq!(&pixels[0..4], &[0x00, 0x40, 0x80, 0xFF]);
    }

    #[test]
    fn scales_chroma_back_up_by_the_colour_loss_level() {
        // Colour loss level 3 means the encoder halved the range twice; shifting 0x10 left by 2
        // gives 0x40 again.
        let mut data = header(4, 4, 4, 0, 3, false);
        data.extend_from_slice(&[0x40u8; 4]);
        data.extend_from_slice(&[0x10u8; 4]);
        data.extend_from_slice(&[0x00u8; 4]);

        let pixels = decode(&data, 2, 2).unwrap();

        assert_eq!(&pixels[0..4], &[0x00, 0x40, 0x80, 0xFF]);
    }

    #[test]
    fn shares_one_chroma_sample_across_a_2x2_block() {
        // Subsampled: luma is padded to a multiple of 8 wide, chroma is half in both directions.
        // A 2x2 tile therefore has a single chroma sample for the whole tile.
        let luma_stride = 8;
        let luma = vec![0x40u8; luma_stride * 2];
        let chroma_orange = vec![0x40u8; 4]; // stride 4, height 1
        let chroma_green = vec![0x00u8; 4];

        let mut data = header(
            u32::try_from(luma.len()).unwrap(),
            4,
            4,
            0,
            1,
            true,
        );
        data.extend_from_slice(&luma);
        data.extend_from_slice(&chroma_orange);
        data.extend_from_slice(&chroma_green);

        let pixels = decode(&data, 2, 2).unwrap();

        for pixel in pixels.chunks_exact(4) {
            assert_eq!(pixel, &[0x00, 0x40, 0x80, 0xFF]);
        }
    }

    #[test]
    fn expands_a_run_and_keeps_the_raw_tail() {
        // 8 bytes: a run of four 0xAA, then the four raw tail bytes.
        // Run segment: value, confirm, factor1 where the length is factor1 + 2.
        let encoded = [0xAA, 0xAA, 0x02, 0x01, 0x02, 0x03, 0x04];
        let plane = rle_decode(&encoded, 8).unwrap();

        assert_eq!(plane, vec![0xAA, 0xAA, 0xAA, 0xAA, 0x01, 0x02, 0x03, 0x04]);
    }

    #[test]
    fn expands_literals() {
        let encoded = [0x01, 0x02, 0x03, 0x04, 0x05];
        let plane = rle_decode(&encoded, 5).unwrap();

        assert_eq!(plane, vec![0x01, 0x02, 0x03, 0x04, 0x05]);
    }

    #[test]
    fn rejects_a_run_that_overshoots_the_plane() {
        // A run of 200 bytes into a plane with room for one. Trusting it would write out of bounds.
        let encoded = [0xAA, 0xAA, 0xC6, 0x01, 0x02, 0x03, 0x04];

        assert!(rle_decode(&encoded, 5).is_err());
    }

    #[test]
    fn rejects_a_plane_bigger_than_its_uncompressed_size() {
        let mut data = header(64, 4, 4, 0, 1, false);
        data.extend_from_slice(&[0u8; 64]);

        assert!(decode(&data, 2, 2).is_err());
    }
}
