//! EGFX(그래픽 파이프라인) 핸들러.
//!
//! 레거시 표면 비트 경로에서는 스크롤할 때 화면 전체가 매번 다시 인코딩된다. 이 채널에는 그
//! 대신 "이 사각형을 저기로 복사"(SurfaceToSurface)와 H.264 가 있고, 최신 Windows 가 실제로
//! 쓰는 경로다.
//!
//! 명령 대부분은 픽셀을 나르지 않으므로, 지금 화면이 어떻게 생겼는지 들고 있는 곳이 필요하다.
//! 핸들러는 [`crate::egfx_surface::EgfxSurface`] 에 직접 합성하고, 펌프 루프가 바뀐 사각형만
//! 꺼내 렌더러로 보낸다 — 렌더러는 이미 잘 도는 프레임 경로(사각형 + 픽셀)만 쓴다.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use ironrdp_egfx::client::{BitmapUpdate, GraphicsPipelineHandler, Surface};
use ironrdp_egfx::pdu::{
    CacheToSurfacePdu, CapabilitiesV107Flags, CapabilitiesV81Flags, CapabilitiesV8Flags,
    CapabilitySet, Codec1Type, Codec2Type,
    EvictCacheEntryPdu, GfxPdu, SolidFillPdu, SurfaceToCachePdu, SurfaceToSurfacePdu,
    WireToSurface1Pdu,
};
use ironrdp_graphics::clearcodec::ClearCodecDecoder;
use ironrdp_graphics::progressive::ProgressiveDecoder;
use tracing::{info, warn};

use crate::egfx_surface::EgfxSurfaceHandle;

/// RemoteFX Progressive 타일 한 변의 길이.
const TILE_SIZE: u16 = 64;

/// H.264 가 연달아 그림을 못 내면 이 채널을 접는다.
///
/// 시작할 때 몇 조각은 그림이 나오지 않는 것이 정상이라 한 번으로 판단하면 안 되고, 계속
/// 못 내면 화면이 멎으므로 마냥 기다려서도 안 된다.
const AVC_FAILURE_LIMIT: u32 = 60;

/// "이 채널로는 화면을 못 그린다" 는 신호.
///
/// 한 번 켜지면 그 세션의 화면은 회복되지 않는다 — 서버는 이미 그래픽을 전부 이 채널로 보내고
/// 있고, 우리가 못 푼 조각은 다시 오지 않는다. 펌프 루프가 이걸 보고 그래픽 파이프라인 없이
/// 다시 접속한다(=예전 경로). 검은 화면으로 남기는 것보다 낫다.
pub type EgfxUnusable = Arc<AtomicBool>;

/// 서피스 하나의 H.264 스트림 상태.
struct AvcStream {
    decoder: Box<dyn ironrdp_egfx::decode::H264Decoder>,
    /// 연달아 그림을 못 낸 횟수. 성공하면 0 으로 돌아간다.
    ///
    /// 서피스별로 센다. 합쳐서 세면 한 화면의 일시적 실패가 다른 화면의 실패와 더해져, 둘 다
    /// 정상인데도 한도를 넘겨 EGFX 를 접을 수 있다.
    failures: u32,
}

pub struct EgfxHandler {
    session_id: String,
    surface: EgfxSurfaceHandle,
    unusable: EgfxUnusable,
    /// AVC444 용 H.264 디코더. **서피스마다 하나씩.**
    ///
    /// 크레이트는 AVC420 만 풀고 AVC444 는 흘려보낸다. 그런데 이 서버는 H.264 를 쓸 수 있으면
    /// AVC444 로 보낸다(4:2:0 만 달라고 해도 그렇다). AVC444 는 AVC420 스트림 두 개다 — 첫
    /// 번째가 4:2:0 화면이고 두 번째는 색차를 4:4:4 로 올리는 보강분이라, 첫 번째만 풀어도
    /// 화면은 제대로 나온다(색이 4:2:0 만큼만 곱다).
    ///
    /// 왜 서피스마다 따로 두는가: 모니터마다 서피스가 하나씩 오고, **서피스마다 독립된 H.264
    /// 스트림**이다(자기 SPS/PPS, 자기 참조 프레임). 한 디코더에 두 스트림을 번갈아 먹이면
    /// 상태가 오염되어 두 번째 스트림부터 영원히 못 푼다 — 계측으로 확인했다: 모니터 1개는
    /// 15초간 무결, 2개는 첫 프레임 직후 `dsNoParamSets | dsRefLost`(OpenH264 Native:22/18)로
    /// 죽고 EGFX 를 통째로 접었다. FreeRDP·mstsc 도 서피스마다 컨텍스트를 둔다.
    avc: HashMap<u16, AvcStream>,
    /// H.264 디코더를 아예 만들 수 없는 빌드. 매 프레임 경고하지 않도록 한 번만 남긴다.
    avc_unavailable: bool,
    /// RemoteFX Progressive 디코더.
    ///
    /// 이 서버는 사진·영상 같은 영역을 WireToSurface2 로 보낸다. 크레이트의 EGFX 클라이언트는
    /// 그 훅을 비워 두고 있어서, 붙이지 않으면 그 자리가 통째로 검은 채 남는다. 디코더 자체는
    /// ironrdp-graphics 에 있다.
    ///
    /// 상태를 들고 있다 — 타일마다 거친 화면부터 시작해 조금씩 선명해지는 코덱이라, 컨텍스트를
    /// 새로 만들면 그때까지 쌓인 화질이 사라진다.
    progressive: ProgressiveDecoder,
    /// 서피스 크기. progressive 는 타일 격자를 만들 때 이 값을 쓴다.
    sizes: HashMap<u16, (u16, u16)>,
    /// 화면에 얹힌 서피스와 그 원점(프레임버퍼 좌표).
    ///
    /// 서피스 좌표는 그 서피스 안에서의 좌표라 원점을 더해야 프레임버퍼 좌표가 된다.
    /// 모니터마다 서피스가 하나씩 오므로 두 번째 모니터는 원점이 (0,0) 이 아니다.
    ///
    /// 매핑되지 않은 서피스는 서버가 작업용으로 쓰는 것이다. 화면 어디에도 놓이지 않으므로
    /// 그대로 그리면 엉뚱한 자리에 엉뚱한 그림이 나온다 — 버린다.
    origins: HashMap<u16, (u16, u16)>,
    logged_first_bitmap: bool,
    logged_first_copy: bool,
    logged_first_cache: bool,
    logged_unmapped: bool,
    logged_unhandled: bool,
    /// 이미 알린 "못 푸는 코덱". 코덱마다 한 번씩만 남긴다.
    logged_codecs: HashSet<u16>,
    /// ClearCodec 디코더.
    ///
    /// 크레이트의 EGFX 클라이언트는 AVC420 과 무압축만 푼다. 이 서버는 AVC 를 꺼 둔 채
    /// ClearCodec 으로 보내므로(확인된 캡에 AVC420_ENABLED 가 없다) 여기서 직접 푼다.
    ///
    /// 상태를 들고 있다 — 글리프·V-bar 캐시가 프레임을 가로질러 쓰인다. 새로 만들면 캐시를
    /// 참조하는 프레임이 깨진다.
    clear_codec: ClearCodecDecoder,
    logged_first_clear: bool,
    logged_first_progressive: bool,
    logged_first_avc: bool,
    /// 무엇이 얼마나 오는지. 화면이 비면 어느 연산이 빠졌는지부터 알아야 한다.
    counts: EgfxCounts,
}

/// 연산별 횟수. 주기적으로 한 줄로 남긴다.
#[derive(Default)]
struct EgfxCounts {
    bitmaps: u64,
    clear_bitmaps: u64,
    copies: u64,
    fills: u64,
    cache_stores: u64,
    cache_restores: u64,
    /// 우리가 담아 둔 적 없는 칸을 서버가 꺼내 쓴 횟수. 그 자리는 그려지지 않는다.
    cache_restores_unknown: u64,
    dropped_unmapped: u64,
    /// 담아 둔 칸 번호. 픽셀은 렌더러에 있고 여기는 번호만 센다.
    stored_slots: HashSet<u16>,
    /// WireToSurface2 개수와 거기서 나온 타일 수.
    wire2: u64,
    progressive_tiles: u64,
    avc444: u64,
    /// 다음에 남길 지점(연산 누계). 처음엔 촘촘히, 그 뒤엔 뜸하게.
    next_report: u64,
    /// 마지막으로 남긴 시각. 조용한 구간에서도 주기적으로 보이게 한다.
    last_report: Option<std::time::Instant>,
}

impl EgfxCounts {
    fn first_report_at() -> u64 {
        1
    }
}

impl EgfxHandler {
    pub fn new(session_id: String, surface: EgfxSurfaceHandle, unusable: EgfxUnusable) -> Self {
        Self {
            session_id,
            surface,
            unusable,
            origins: HashMap::new(),
            logged_first_bitmap: false,
            logged_first_copy: false,
            logged_first_cache: false,
            logged_unmapped: false,
            logged_unhandled: false,
            logged_codecs: HashSet::new(),
            // 디코더는 서피스가 실제로 H.264 를 보낼 때 만든다. 서피스 수를 미리 알 수 없다.
            avc: HashMap::new(),
            avc_unavailable: false,
            progressive: ProgressiveDecoder::new(),
            sizes: HashMap::new(),
            clear_codec: ClearCodecDecoder::new(),
            logged_first_clear: false,
            logged_first_progressive: false,
            logged_first_avc: false,
            counts: EgfxCounts {
                next_report: EgfxCounts::first_report_at(),
                ..EgfxCounts::default()
            },
        }
    }

    /// 연산 횟수를 이따금 한 줄로 남긴다.
    ///
    /// 화면 일부가 비어 있을 때, 그 자리를 그렸어야 할 연산이 아예 안 왔는지 아니면 왔는데
    /// 우리가 흘렸는지를 이 숫자들로 가른다.
    fn report(&mut self) {
        let total = self.counts.bitmaps
            + self.counts.clear_bitmaps
            + self.counts.copies
            + self.counts.fills
            + self.counts.cache_restores;
        let elapsed = self
            .counts
            .last_report
            .map(|at| at.elapsed() >= std::time::Duration::from_secs(2))
            .unwrap_or(true);
        if total < self.counts.next_report && !elapsed {
            return;
        }
        self.counts.last_report = Some(std::time::Instant::now());
        // 첫 화면은 촘촘히 보고 그 뒤로는 뜸하게. 로그로 파이프를 막으면 그것대로 문제다.
        self.counts.next_report = if total < 1_000 {
            total + 200
        } else {
            total + 1_000
        };
        info!(
            session_id = %self.session_id,
            bitmaps = self.counts.bitmaps,
            clearcodec = self.counts.clear_bitmaps,
            copies = self.counts.copies,
            fills = self.counts.fills,
            cache_stores = self.counts.cache_stores,
            cache_restores = self.counts.cache_restores,
            cache_restores_unknown = self.counts.cache_restores_unknown,
            cached_slots = self.counts.stored_slots.len(),
            wire2 = self.counts.wire2,
            progressive_tiles = self.counts.progressive_tiles,
            avc444 = self.counts.avc444,
            // 가장 나쁜 서피스의 연속 실패 수. 0 이 아니면 그 화면이 멎고 있다는 뜻이다.
            avc_failures = self.avc.values().map(|stream| stream.failures).max().unwrap_or(0),
            avc_surfaces = self.avc.len(),
            dropped_unmapped = self.counts.dropped_unmapped,
            "egfx counts"
        );
    }

    /// 이 채널로는 화면을 못 그린다고 알린다.
    fn give_up(&self, reason: &str) {
        if !self.unusable.swap(true, Ordering::Relaxed) {
            warn!(
                session_id = %self.session_id,
                reason,
                "egfx cannot render this session; falling back to the legacy path"
            );
        }
    }

    /// 이 서피스의 H.264 스트림. 처음 보는 서피스면 디코더를 만든다.
    ///
    /// 디코더를 못 만드는 빌드에서는 `None` 이고, 그때 경고는 한 번만 남긴다 — 프레임마다
    /// 남기면 로그가 쓸려나간다.
    fn avc_stream(&mut self, surface_id: u16) -> Option<&mut AvcStream> {
        if self.avc_unavailable {
            return None;
        }
        if !self.avc.contains_key(&surface_id) {
            match ironrdp_egfx::decode::OpenH264Decoder::new() {
                Ok(decoder) => {
                    info!(
                        session_id = %self.session_id,
                        surface_id,
                        "created an H.264 decoder for this surface"
                    );
                    self.avc.insert(
                        surface_id,
                        AvcStream {
                            decoder: Box::new(decoder),
                            failures: 0,
                        },
                    );
                }
                Err(error) => {
                    self.avc_unavailable = true;
                    warn!(%error, "no H.264 decoder; AVC444 frames will not be drawn");
                    return None;
                }
            }
        }
        self.avc.get_mut(&surface_id)
    }

    /// 화면에 합성한다. 잠금은 같은 스레드 안에서만 오가므로 다툼이 없다.
    fn with_surface<T>(&self, apply: impl FnOnce(&mut crate::egfx_surface::EgfxSurface) -> T) -> Option<T> {
        self.surface.lock().ok().map(|mut surface| apply(&mut surface))
    }

    /// AVC444 로 온 화면을 푼다. 첫 스트림(4:2:0)만 쓴다.
    fn decode_avc444(&mut self, wire: &WireToSurface1Pdu) {
        let Some((origin_x, origin_y)) = self.origin_of(wire.surface_id) else {
            return;
        };
        if wire.bitmap_data.len() < 4 {
            return;
        }

        // 앞 4바이트: 하위 30비트가 첫 스트림 길이, 상위 2비트가 무엇이 들어 있는지.
        let header = u32::from_le_bytes([
            wire.bitmap_data[0],
            wire.bitmap_data[1],
            wire.bitmap_data[2],
            wire.bitmap_data[3],
        ]);
        let first_len = (header & 0x3FFF_FFFF) as usize;
        let rest = &wire.bitmap_data[4..];

        let luma = match header >> 30 {
            // 0: 두 스트림이 다 있다. 1: 4:2:0 화면만 있다.
            0 if first_len <= rest.len() => &rest[..first_len],
            1 => rest,
            // 2: 색차 보강분만 왔다. 화면 자체는 그대로이므로 넘어간다.
            _ => return,
        };

        use ironrdp_core::Decode as _;
        let stream = match ironrdp_egfx::pdu::Avc420BitmapStream::decode(
            &mut ironrdp_core::ReadCursor::new(luma),
        ) {
            Ok(stream) => stream,
            Err(error) => {
                warn!(
                    session_id = %self.session_id,
                    surface_id = wire.surface_id,
                    %error,
                    "avc444 stream decode failed"
                );
                self.give_up("avc444 stream decode failed");
                return;
            }
        };

        // 이 서피스 몫의 디코더로만 푼다. DecodedFrame 은 소유값이라 여기서 빌림이 끝난다.
        let surface_id = wire.surface_id;
        let decoded = {
            let Some(avc) = self.avc_stream(surface_id) else {
                return;
            };
            avc.decoder.decode(stream.data)
        };

        let frame = match decoded {
            Ok(frame) => frame,
            Err(error) => {
                // 낼 그림이 아직 없는 것은 정상이다 — H.264 는 파라미터 세트만 담긴 조각으로
                // 시작하고, 그때는 디코더가 아무것도 내놓지 않는다. 여기서 접으면 H.264 를
                // 쓰는 서버에서 매번 예전 경로로 떨어진다.
                //
                // 다만 계속 못 풀면 그 화면이 멎은 채로 남으므로, 연달아 실패하면 그때 접는다.
                let failures = self
                    .avc
                    .get_mut(&surface_id)
                    .map(|avc| {
                        avc.failures += 1;
                        avc.failures
                    })
                    .unwrap_or(0);
                if failures <= 3 {
                    info!(
                        session_id = %self.session_id,
                        surface_id, failures, %error,
                        "avc444 frame produced no picture"
                    );
                }
                if failures >= AVC_FAILURE_LIMIT {
                    warn!(
                        session_id = %self.session_id,
                        surface_id, failures, %error,
                        "avc444 decoding keeps failing"
                    );
                    self.give_up("avc444 decode failed");
                }
                return;
            }
        };
        if let Some(avc) = self.avc.get_mut(&surface_id) {
            avc.failures = 0;
        }

        let width = wire
            .destination_rectangle
            .right
            .saturating_sub(wire.destination_rectangle.left);
        let height = wire
            .destination_rectangle
            .bottom
            .saturating_sub(wire.destination_rectangle.top);
        if width == 0 || height == 0 {
            return;
        }

        // 디코더는 매크로블록(16픽셀) 단위로 맞춰 내놓으므로 목적지보다 클 수 있다. 왼쪽 위를
        // 잘라 쓴다.
        if frame.width() < u32::from(width) || frame.height() < u32::from(height) {
            warn!(
                session_id = %self.session_id,
                frame_width = frame.width(),
                frame_height = frame.height(),
                width, height,
                "avc444 frame is smaller than its destination"
            );
            return;
        }

        // 프레임은 화면 전체 크기지만, 실제로 바뀐 곳은 스트림이 사각형으로 알려 준다. 전체를
        // 쓰면 화면 한 장(8MB)을 매번 렌더러로 밀게 된다 — 스크롤이 무거운 이유가 이것이다.
        let decoded_stride = frame.width() as usize * 4;
        let data = frame.data();
        let dest_left = wire.destination_rectangle.left;
        let dest_top = wire.destination_rectangle.top;

        self.counts.avc444 += 1;
        self.report();

        if !self.logged_first_avc {
            self.logged_first_avc = true;
            info!(
                session_id = %self.session_id,
                surface_id,
                width, height,
                dest_left, dest_top,
                frame_width = frame.width(),
                frame_height = frame.height(),
                rects = stream.rectangles.len(),
                first_rect = ?stream.rectangles.first(),
                "egfx first avc444 frame"
            );
        }

        // 사각형이 하나도 없으면 프레임 전체가 바뀐 것으로 본다.
        let mut regions: Vec<(u16, u16, u16, u16)> = stream
            .rectangles
            .iter()
            .map(|rect| {
                // 타입 이름은 InclusiveRectangle 이지만 값은 열린 구간이다 — 폭 1440 화면의 전체
                // 갱신이 right=1440 으로 온다(실측). 포함으로 보고 1 을 더하면 화면보다 커져서
                // 경계 검사에 걸리고, 전체 화면 갱신이 통째로 버려진다.
                (
                    rect.left,
                    rect.top,
                    rect.right.saturating_sub(rect.left),
                    rect.bottom.saturating_sub(rect.top),
                )
            })
            .collect();
        if regions.is_empty() {
            regions.push((dest_left, dest_top, width, height));
        }

        let mut pixels = Vec::new();
        for (left, top, region_width, region_height) in regions {
            // 사각형은 화면 좌표다. 프레임에서 읽을 자리는 목적지 원점을 뺀 값이다.
            let Some(from_x) = left.checked_sub(dest_left) else {
                continue;
            };
            let Some(from_y) = top.checked_sub(dest_top) else {
                continue;
            };
            if region_width == 0 || region_height == 0 {
                continue;
            }
            if usize::from(from_x) + usize::from(region_width) > frame.width() as usize
                || usize::from(from_y) + usize::from(region_height) > frame.height() as usize
            {
                continue;
            }

            let row_bytes = usize::from(region_width) * 4;
            pixels.clear();
            pixels.reserve(row_bytes * usize::from(region_height));
            for row in 0..usize::from(region_height) {
                let at = (usize::from(from_y) + row) * decoded_stride + usize::from(from_x) * 4;
                pixels.extend_from_slice(&data[at..at + row_bytes]);
            }

            if let Ok(mut surface) = self.surface.lock() {
                surface.write(
                    origin_x.saturating_add(left),
                    origin_y.saturating_add(top),
                    region_width,
                    region_height,
                    &pixels,
                );
            }
        }
    }

    /// ClearCodec 로 온 화면 조각을 푼다.
    fn decode_clear_codec(&mut self, wire: &WireToSurface1Pdu) {
        let Some((origin_x, origin_y)) = self.origin_of(wire.surface_id) else {
            return;
        };

        let width = wire
            .destination_rectangle
            .right
            .saturating_sub(wire.destination_rectangle.left);
        let height = wire
            .destination_rectangle
            .bottom
            .saturating_sub(wire.destination_rectangle.top);
        if width == 0 || height == 0 {
            return;
        }

        let mut pixels = match self.clear_codec.decode(&wire.bitmap_data, width, height) {
            Ok(pixels) => pixels,
            Err(error) => {
                // 캐시를 쓰는 코덱이라 한 번 실패하면 그 뒤가 전부 어긋난다 — 실패한 스트림의
                // V-Bar 들이 캐시에 들어가지 못해서, 그걸 참조하는 다음 프레임들도 줄줄이
                // 깨진다. 한 번이라도 실패하면 이 채널은 포기하는 것이 맞다.
                warn!(%error, session_id = %self.session_id, "clearcodec decode failed");
                self.give_up("clearcodec decode failed");
                return;
            }
        };

        // 디코더는 BGRA 로 내놓고 우리 프레임은 RGBA 다.
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }

        self.counts.clear_bitmaps += 1;
        self.report();

        if !self.logged_first_clear {
            self.logged_first_clear = true;
            info!(
                session_id = %self.session_id,
                width, height,
                "egfx first clearcodec bitmap"
            );
        }

        self.with_surface(|surface| {
            surface.write(
                origin_x.saturating_add(wire.destination_rectangle.left),
                origin_y.saturating_add(wire.destination_rectangle.top),
                width,
                height,
                &pixels,
            );
        });
    }

    /// 이 서피스가 화면 어디에 놓여 있는지. 놓여 있지 않으면 None.
    fn origin_of(&mut self, surface_id: u16) -> Option<(u16, u16)> {
        match self.origins.get(&surface_id) {
            Some(origin) => Some(*origin),
            None => {
                self.counts.dropped_unmapped += 1;
                if !self.logged_unmapped {
                    self.logged_unmapped = true;
                    // 화면 밖 서피스를 서버가 실제로 쓴다면 그 내용도 들고 있어야 한다. 지금은
                    // 버리므로, 이 줄이 보이면 그때 다뤄야 한다는 뜻이다.
                    info!(
                        session_id = %self.session_id,
                        surface_id,
                        "egfx dropped an update for a surface that is not on screen"
                    );
                }
                None
            }
        }
    }
}

impl GraphicsPipelineHandler for EgfxHandler {
    fn capabilities(&self) -> Vec<CapabilitySet> {
        // 우리가 실제로 풀 수 있는 것만 내건다.
        //
        // AVC_THIN_CLIENT 는 "AVC 는 4:2:0 으로만 달라"는 뜻이다. 이걸 세우지 않고 V10_7 을
        // 내걸면 서버가 AVC444 를 고를 수 있는데, ironrdp-egfx 0.3 은 그걸 디코딩하지 못하고
        // 그대로 흘려보내므로 그 화면은 아예 그려지지 않는다.
        //
        // V10_7 을 아예 빼면 H.264 를 못 쓴다 — Windows 는 V8_1 로 협상되면 AVC420 을 켜지
        // 않는다(확인된 캡에 AVC420_ENABLED 가 없다). 스크롤·영상이 전부 화면 조각 전송으로
        // 돌아가므로, 4:2:0 만 받겠다고 명시해서 H.264 를 살린다.
        vec![
            CapabilitySet::V10_7 {
                // SCALEDMAP_DISABLE: 서피스를 늘려 붙이지 말라는 뜻이다. 늘려 붙이면 우리가
                // 그대로 그릴 수 없고, 1:1 이 아닌 배율은 다룰 수도 없다.
                flags: CapabilitiesV107Flags::SMALL_CACHE
                    | CapabilitiesV107Flags::AVC_THIN_CLIENT
                    | CapabilitiesV107Flags::SCALEDMAP_DISABLE,
            },
            CapabilitySet::V8_1 {
                flags: CapabilitiesV81Flags::AVC420_ENABLED | CapabilitiesV81Flags::SMALL_CACHE,
            },
            CapabilitySet::V8 {
                flags: CapabilitiesV8Flags::SMALL_CACHE,
            },
        ]
    }

    fn on_wire_to_surface2(&mut self, pdu: &ironrdp_egfx::pdu::WireToSurface2Pdu) {
        if pdu.codec_id != Codec2Type::RemoteFxProgressive {
            if self.counts.wire2 == 0 {
                warn!(session_id = %self.session_id, codec = ?pdu.codec_id, "egfx codec we cannot decode on wire-to-surface-2");
            }
            self.counts.wire2 += 1;
            self.give_up("wire-to-surface-2 codec");
            return;
        }

        let Some((origin_x, origin_y)) = self.origin_of(pdu.surface_id) else {
            return;
        };
        let Some((surface_width, surface_height)) = self.sizes.get(&pdu.surface_id).copied() else {
            return;
        };

        let tiles = match self.progressive.decode_bitmap(
            pdu.codec_context_id,
            surface_width,
            surface_height,
            &pdu.bitmap_data,
        ) {
            Ok(tiles) => tiles,
            Err(error) => {
                // 타일마다 쌓아 가는 코덱이라 한 번 어긋나면 그 뒤가 어긋난 채로 남는다.
                warn!(session_id = %self.session_id, ?error, "progressive decode failed");
                self.give_up("progressive decode failed");
                return;
            }
        };

        self.counts.wire2 += 1;
        self.counts.progressive_tiles += tiles.len() as u64;
        self.report();

        if !self.logged_first_progressive {
            self.logged_first_progressive = true;
            info!(
                session_id = %self.session_id,
                tiles = tiles.len(),
                "egfx first progressive frame"
            );
        }

        self.with_surface(|surface| {
            for tile in &tiles {
                // 타일은 64x64 고정이다. 화면 끝에 걸치면 프레임버퍼 쪽에서 잘린다.
                surface.write(
                    origin_x.saturating_add(tile.x_idx.saturating_mul(TILE_SIZE)),
                    origin_y.saturating_add(tile.y_idx.saturating_mul(TILE_SIZE)),
                    TILE_SIZE,
                    TILE_SIZE,
                    &tile.pixels,
                );
            }
        });
    }

    fn on_delete_encoding_context(
        &mut self,
        pdu: &ironrdp_egfx::pdu::DeleteEncodingContextPdu,
    ) {
        self.progressive.delete_context(pdu.codec_context_id);
    }

    fn on_map_surface_to_window(&mut self, pdu: &ironrdp_egfx::pdu::MapSurfaceToWindowPdu) {
        // 창 단위로 붙이는 것은 RemoteApp 용이다. 데스크톱 세션에서는 오지 않아야 한다.
        warn!(session_id = %self.session_id, ?pdu, "egfx surface mapped to a window (unhandled)");
    }

    fn on_map_surface_to_scaled_output(
        &mut self,
        pdu: &ironrdp_egfx::pdu::MapSurfaceToScaledOutputPdu,
    ) {
        // 늘리지 말라고 요청했지만(SCALEDMAP_DISABLE) 서버가 이걸로 붙일 수 있다. 배율이 1:1
        // 이면 평범한 매핑과 같으므로 그대로 받는다.
        //
        // 이 훅을 비워 두면 서피스가 화면 어디에 놓였는지 모르게 되고, 그러면 그 서피스로 오는
        // 모든 그리기를 버린다 — 화면이 통째로 비는 결과가 된다.
        let same_size = self
            .sizes
            .get(&pdu.surface_id)
            .map(|(width, height)| {
                u32::from(*width) == pdu.target_width && u32::from(*height) == pdu.target_height
            })
            .unwrap_or(false);

        if !same_size {
            warn!(
                session_id = %self.session_id,
                ?pdu,
                "egfx surface mapped to a scaled output; we cannot scale"
            );
            self.give_up("scaled surface mapping");
            return;
        }

        self.on_surface_mapped(pdu.surface_id, pdu.output_origin_x, pdu.output_origin_y);
    }

    fn on_unhandled_pdu(&mut self, pdu: &GfxPdu) {
        if let GfxPdu::WireToSurface1(wire) = pdu {
            if wire.codec_id == Codec1Type::ClearCodec {
                self.decode_clear_codec(wire);
                return;
            }

            if matches!(wire.codec_id, Codec1Type::Avc444 | Codec1Type::Avc444v2) {
                self.decode_avc444(wire);
                return;
            }

            // 코덱마다 한 번씩. 서버가 여러 코덱을 섞어 쓰면 하나만 보고 다 안다고 할 수 없다.
            if self.logged_codecs.insert(wire.codec_id as u16) {
                warn!(
                    session_id = %self.session_id,
                    codec = ?wire.codec_id,
                    "egfx codec we cannot decode"
                );
            }
            self.give_up("codec we cannot decode");
            return;
        }

        // 여기까지 온 것은 우리가 못 그리는 것이다. 화면 일부가 낡은 채로 남는다면 이 줄이 원인을
        // 알려 준다.
        if !self.logged_unhandled {
            self.logged_unhandled = true;
            info!(
                session_id = %self.session_id,
                pdu = ?pdu,
                "egfx pdu we do not handle"
            );
        }
    }

    fn on_capabilities_confirmed(&mut self, caps: &CapabilitySet) {
        info!(
            session_id = %self.session_id,
            capabilities = ?caps,
            "egfx capabilities confirmed"
        );
    }

    fn on_reset_graphics(&mut self, width: u32, height: u32) {
        let width = u16::try_from(width).unwrap_or(u16::MAX);
        let height = u16::try_from(height).unwrap_or(u16::MAX);

        // 여기가 화면 전체 크기다. 프레임버퍼를 여기에 맞춘다 — 같은 크기로 다시 오면 그대로
        // 두어야 한다(접속 때 두 번 온다). 다시 잡으면 그리던 화면이 날아간다.
        let changed = self
            .with_surface(|surface| {
                let before = surface.size();
                surface.resize(width, height);
                before != surface.size()
            })
            .unwrap_or(false);

        if changed {
            // 크기가 바뀌면 화면을 나르던 코덱들도 처음부터 다시 시작한다.
            //
            // H.264 는 앞 프레임에 기대어 풀리므로, 옛 크기의 상태를 붙든 디코더는 새 스트림을
            // 계속 못 푼다. 그러면 연달아 실패한 것으로 보고 이 채널을 접어 버린다 — 창 크기를
            // 바꿨을 뿐인데 세션이 예전 경로로 떨어지거나 끊긴다.
            // 서피스마다 스트림이 다르므로 통째로 버린다. 다음 프레임이 새 디코더를 만든다.
            self.avc.clear();
            self.progressive.reset();
        }

        info!(session_id = %self.session_id, width, height, changed, "egfx reset graphics");
    }

    fn on_surface_created(&mut self, surface: &Surface) {
        self.sizes.insert(surface.id, (surface.width, surface.height));
        info!(
            session_id = %self.session_id,
            surface_id = surface.id,
            width = surface.width,
            height = surface.height,
            "egfx surface created"
        );
    }

    fn on_surface_deleted(&mut self, surface_id: u16) {
        self.origins.remove(&surface_id);
        self.sizes.remove(&surface_id);
        // 이 서피스의 디코더도 같이 버린다. 같은 번호로 새 서피스가 오면 그것은 새 스트림이고,
        // 옛 상태를 붙든 디코더는 그걸 못 푼다.
        self.avc.remove(&surface_id);
    }

    fn on_surface_mapped(&mut self, surface_id: u16, origin_x: u32, origin_y: u32) {
        // 프레임버퍼는 하나이고 모니터들이 그 안에 나란히 놓인다. 여기서 받은 원점이 그 자리다.
        self.origins.insert(
            surface_id,
            (
                u16::try_from(origin_x).unwrap_or(u16::MAX),
                u16::try_from(origin_y).unwrap_or(u16::MAX),
            ),
        );
        info!(
            session_id = %self.session_id,
            surface_id, origin_x, origin_y,
            "egfx surface mapped to output"
        );
    }

    fn on_bitmap_updated(&mut self, update: &BitmapUpdate) {
        if update.data.is_empty() {
            return;
        }
        let Some((origin_x, origin_y)) = self.origin_of(update.surface_id) else {
            return;
        };

        if !self.logged_first_bitmap {
            self.logged_first_bitmap = true;
            info!(
                session_id = %self.session_id,
                codec = ?update.codec_id,
                width = update.width,
                height = update.height,
                "egfx first bitmap update"
            );
        }

        self.counts.bitmaps += 1;
        self.report();

        self.with_surface(|surface| {
            surface.write(
                origin_x.saturating_add(update.destination_rectangle.left),
                origin_y.saturating_add(update.destination_rectangle.top),
                update.width,
                update.height,
                &update.data,
            );
        });
    }

    fn on_surface_to_surface(&mut self, pdu: &SurfaceToSurfacePdu) {
        // 원본과 목적지가 다른 서피스일 수 있다. 각자의 원점으로 옮겨야 한다.
        let Some((source_origin_x, source_origin_y)) = self.origin_of(pdu.source_surface_id) else {
            return;
        };
        let Some((dest_origin_x, dest_origin_y)) = self.origin_of(pdu.destination_surface_id)
        else {
            return;
        };

        // 목적지가 여러 개면 서버가 같은 원본을 여러 곳에 복사하는 것이다.
        self.counts.copies += pdu.destination_points.len() as u64;
        self.report();
        let width = pdu
            .source_rectangle
            .right
            .saturating_sub(pdu.source_rectangle.left);
        let height = pdu
            .source_rectangle
            .bottom
            .saturating_sub(pdu.source_rectangle.top);
        self.with_surface(|surface| {
            for point in &pdu.destination_points {
                surface.copy(
                    source_origin_x.saturating_add(pdu.source_rectangle.left),
                    source_origin_y.saturating_add(pdu.source_rectangle.top),
                    width,
                    height,
                    dest_origin_x.saturating_add(point.x),
                    dest_origin_y.saturating_add(point.y),
                );
            }
        });

        // 처음 몇 번은 좌표까지 남긴다. 화면이 어긋날 때 값이 이상한 것인지 값은 맞는데 우리가
        // 못 옮기는 것인지부터 갈라야 한다.
        if self.counts.copies <= 3 {
            info!(
                session_id = %self.session_id,
                source_x = source_origin_x.saturating_add(pdu.source_rectangle.left),
                source_y = source_origin_y.saturating_add(pdu.source_rectangle.top),
                width = pdu.source_rectangle.right.saturating_sub(pdu.source_rectangle.left),
                height = pdu.source_rectangle.bottom.saturating_sub(pdu.source_rectangle.top),
                dest = ?pdu.destination_points,
                "egfx surface-to-surface copy"
            );
        }

        if !self.logged_first_copy {
            self.logged_first_copy = true;
            info!(
                session_id = %self.session_id,
                "egfx surface-to-surface copy in use"
            );
        }
    }

    fn on_solid_fill(&mut self, pdu: &SolidFillPdu) {
        let Some((origin_x, origin_y)) = self.origin_of(pdu.surface_id) else {
            return;
        };
        self.counts.fills += pdu.rectangles.len() as u64;
        self.report();
        self.with_surface(|surface| {
            for rectangle in &pdu.rectangles {
                surface.fill(
                    origin_x.saturating_add(rectangle.left),
                    origin_y.saturating_add(rectangle.top),
                    rectangle.right.saturating_sub(rectangle.left),
                    rectangle.bottom.saturating_sub(rectangle.top),
                    pdu.fill_pixel.r,
                    pdu.fill_pixel.g,
                    pdu.fill_pixel.b,
                );
            }
        });
    }

    fn on_surface_to_cache(&mut self, pdu: &SurfaceToCachePdu) {
        let Some((origin_x, origin_y)) = self.origin_of(pdu.surface_id) else {
            return;
        };

        if !self.logged_first_cache {
            self.logged_first_cache = true;
            info!(session_id = %self.session_id, "egfx bitmap cache in use");
        }

        self.counts.cache_stores += 1;
        self.counts.stored_slots.insert(pdu.cache_slot);

        self.with_surface(|surface| {
            surface.cache_store(
                pdu.cache_slot,
                origin_x.saturating_add(pdu.source_rectangle.left),
                origin_y.saturating_add(pdu.source_rectangle.top),
                pdu.source_rectangle
                    .right
                    .saturating_sub(pdu.source_rectangle.left),
                pdu.source_rectangle
                    .bottom
                    .saturating_sub(pdu.source_rectangle.top),
            );
        });
    }

    fn on_cache_to_surface(&mut self, pdu: &CacheToSurfacePdu) {
        let Some((origin_x, origin_y)) = self.origin_of(pdu.surface_id) else {
            return;
        };
        self.counts.cache_restores += pdu.destination_points.len() as u64;
        self.report();

        let known = self
            .with_surface(|surface| {
                let mut known = true;
                for point in &pdu.destination_points {
                    known = surface.cache_restore(
                        pdu.cache_slot,
                        origin_x.saturating_add(point.x),
                        origin_y.saturating_add(point.y),
                    );
                }
                known
            })
            .unwrap_or(true);

        if !known {
            // 우리가 담아 둔 적 없는 칸이다. 그 자리는 그려지지 않는다 — 화면에 구멍이 남는다.
            self.counts.cache_restores_unknown += pdu.destination_points.len() as u64;
        }
    }

    fn on_evict_cache_entry(&mut self, pdu: &EvictCacheEntryPdu) {
        self.counts.stored_slots.remove(&pdu.cache_slot);
        // 서버가 칸을 비우면 렌더러도 버려야 한다. 안 그러면 그 칸이 낡은 그림을 들고 있다가
        // 다음에 같은 번호가 재사용될 때 엉뚱한 것이 나온다.
        self.with_surface(|surface| surface.cache_evict(pdu.cache_slot));
    }
}

#[cfg(test)]
mod tests {
    use ironrdp_egfx::pdu::{Color, Point};
    use ironrdp_pdu::geometry::ExclusiveRectangle;

    use super::*;
    use crate::egfx_surface::{DirtyRect, new_surface};

    /// 서피스마다 H.264 디코더가 따로 있어야 한다.
    ///
    /// 하나를 공유하면 두 번째 서피스의 프레임부터 영원히 못 푼다. 서피스마다 독립된 H.264
    /// 스트림이라(자기 SPS/PPS, 자기 참조 프레임) 한 디코더에 번갈아 먹이면 상태가 오염된다.
    /// 계측: 모니터 1개는 무결, 2개는 첫 프레임 직후 OpenH264 Native:22 로 죽고 EGFX 를 접었다.
    #[test]
    fn keeps_one_h264_decoder_per_surface() {
        let (mut handler, _surface) = two_monitors();

        assert!(handler.avc_stream(1).is_some());
        assert!(handler.avc_stream(2).is_some());
        assert_eq!(handler.avc.len(), 2, "서피스마다 하나씩");

        // 같은 서피스를 다시 물으면 새로 만들지 않는다. 새로 만들면 그때까지의 참조 프레임이
        // 사라져 다음 프레임을 못 푼다.
        assert!(handler.avc_stream(1).is_some());
        assert_eq!(handler.avc.len(), 2);
    }

    #[test]
    fn drops_the_decoder_with_its_surface() {
        // 같은 번호로 새 서피스가 오면 그것은 새 스트림이다. 옛 상태를 붙든 디코더는 못 푼다.
        let (mut handler, _surface) = two_monitors();
        handler.avc_stream(1);
        handler.avc_stream(2);

        handler.on_surface_deleted(1);
        assert_eq!(handler.avc.len(), 1);
        assert!(!handler.avc.contains_key(&1));
    }

    #[test]
    fn drops_every_decoder_when_the_desktop_is_resized() {
        // 크기가 바뀌면 서버가 스트림을 처음부터 다시 시작한다. 옛 상태로는 못 푼다.
        let (mut handler, _surface) = two_monitors();
        handler.avc_stream(1);
        handler.avc_stream(2);

        handler.on_reset_graphics(1920, 1080);
        assert!(handler.avc.is_empty());
    }

    fn rectangle(left: u16, top: u16, right: u16, bottom: u16) -> ExclusiveRectangle {
        ExclusiveRectangle {
            left,
            top,
            right,
            bottom,
        }
    }

    /// 모니터 두 개. 두 번째는 프레임버퍼 안에서 x=1920 에 놓인다.
    fn two_monitors() -> (EgfxHandler, EgfxSurfaceHandle) {
        let (handler, surface, _) = two_monitors_with_flag();
        (handler, surface)
    }

    fn two_monitors_with_flag() -> (EgfxHandler, EgfxSurfaceHandle, EgfxUnusable) {
        let surface = new_surface();
        let unusable: EgfxUnusable = Arc::new(AtomicBool::new(false));
        let mut handler =
            EgfxHandler::new("s1".to_owned(), Arc::clone(&surface), Arc::clone(&unusable));
        handler.on_reset_graphics(3840, 1080);
        handler.on_surface_mapped(1, 0, 0);
        handler.on_surface_mapped(2, 1920, 0);
        (handler, surface, unusable)
    }

    fn dirty(surface: &EgfxSurfaceHandle) -> Option<DirtyRect> {
        let mut rects = Vec::new();
        surface.lock().unwrap().take_dirty(&mut rects);
        assert!(rects.len() <= 1, "expected at most one rectangle, got {rects:?}");
        rects.into_iter().next()
    }

    /// 한 픽셀을 RGBA 로 읽는다.
    fn pixel(surface: &EgfxSurfaceHandle, x: u16, y: u16) -> [u8; 4] {
        let surface = surface.lock().unwrap();
        let rect = DirtyRect {
            x,
            y,
            width: 1,
            height: 1,
        };
        let mut out = Vec::new();
        surface.extract(rect, &mut out);
        [out[0], out[1], out[2], out[3]]
    }

    #[test]
    fn moves_a_copy_into_frame_buffer_coordinates() {
        let (mut handler, surface) = two_monitors();

        // 두 번째 모니터 왼쪽 위를 알아볼 수 있게 칠해 둔다.
        handler.on_solid_fill(&SolidFillPdu {
            surface_id: 2,
            fill_pixel: Color {
                b: 1,
                g: 2,
                r: 3,
                xa: 0,
            },
            rectangles: vec![rectangle(0, 100, 4, 104)],
        });
        let _ = dirty(&surface);

        // 두 번째 모니터 안에서의 스크롤. 서피스 좌표는 0 부터 시작한다.
        handler.on_surface_to_surface(&SurfaceToSurfacePdu {
            source_surface_id: 2,
            destination_surface_id: 2,
            source_rectangle: rectangle(0, 100, 1920, 1080),
            destination_points: vec![Point { x: 0, y: 0 }],
        });

        // 원점을 더하지 않으면 첫 모니터를 스크롤한 것처럼 그려진다.
        assert_eq!(pixel(&surface, 1920, 0), [3, 2, 1, 255]);
        assert_eq!(
            dirty(&surface),
            Some(DirtyRect {
                x: 1920,
                y: 0,
                width: 1920,
                height: 980
            })
        );
    }

    #[test]
    fn fills_and_caches_land_on_the_right_monitor() {
        let (mut handler, surface) = two_monitors();

        handler.on_solid_fill(&SolidFillPdu {
            surface_id: 2,
            fill_pixel: Color {
                b: 1,
                g: 2,
                r: 3,
                xa: 0,
            },
            rectangles: vec![rectangle(10, 20, 110, 70)],
        });

        assert_eq!(pixel(&surface, 1930, 20), [3, 2, 1, 255]);
        assert_eq!(
            dirty(&surface),
            Some(DirtyRect {
                x: 1930,
                y: 20,
                width: 100,
                height: 50
            })
        );

        handler.on_surface_to_cache(&SurfaceToCachePdu {
            surface_id: 2,
            cache_key: 0,
            cache_slot: 7,
            source_rectangle: rectangle(10, 20, 12, 22),
        });
        handler.on_cache_to_surface(&CacheToSurfacePdu {
            cache_slot: 7,
            surface_id: 2,
            destination_points: vec![Point { x: 5, y: 6 }],
        });

        // 두 번째 모니터 좌표로 놓인다.
        assert_eq!(pixel(&surface, 1925, 6), [3, 2, 1, 255]);
        assert_eq!(
            dirty(&surface),
            Some(DirtyRect {
                x: 1925,
                y: 6,
                width: 2,
                height: 2
            })
        );
    }

    #[test]
    fn drops_updates_for_a_surface_that_is_not_on_screen() {
        let (mut handler, surface) = two_monitors();

        // 서버가 작업용으로 만든 서피스. 화면 어디에도 놓여 있지 않으므로 그릴 자리가 없다.
        handler.on_solid_fill(&SolidFillPdu {
            surface_id: 9,
            fill_pixel: Color {
                b: 0,
                g: 0,
                r: 0,
                xa: 0,
            },
            rectangles: vec![rectangle(0, 0, 10, 10)],
        });

        assert_eq!(dirty(&surface), None);
    }

    #[test]
    fn decodes_a_clearcodec_bitmap_into_rgba() {
        let (mut handler, surface) = two_monitors();

        // 2x1 픽셀: 빨강, 파랑. 인코더는 BGRA 를 받는다.
        let bgra = vec![0, 0, 255, 255, 255, 0, 0, 255];
        let encoded = ironrdp_graphics::clearcodec::ClearCodecEncoder::new().encode(&bgra, 2, 1);

        handler.on_unhandled_pdu(&GfxPdu::WireToSurface1(WireToSurface1Pdu {
            surface_id: 2,
            codec_id: Codec1Type::ClearCodec,
            pixel_format: ironrdp_egfx::pdu::PixelFormat::XRgb,
            destination_rectangle: rectangle(10, 20, 12, 21),
            bitmap_data: encoded,
        }));

        // 두 번째 모니터라 원점이 더해진다. 렌더러는 RGBA 로 받는다 — 바꿔 주지 않으면 빨강과
        // 파랑이 뒤집힌다.
        assert_eq!(pixel(&surface, 1930, 20), [255, 0, 0, 255]);
        assert_eq!(pixel(&surface, 1931, 20), [0, 0, 255, 255]);
        assert_eq!(
            dirty(&surface),
            Some(DirtyRect {
                x: 1930,
                y: 20,
                width: 2,
                height: 1
            })
        );
    }

    #[test]
    fn gives_up_on_a_codec_it_cannot_decode() {
        let (mut handler, _surface, unusable) = two_monitors_with_flag();

        handler.on_unhandled_pdu(&GfxPdu::WireToSurface1(WireToSurface1Pdu {
            surface_id: 2,
            codec_id: Codec1Type::Planar,
            pixel_format: ironrdp_egfx::pdu::PixelFormat::XRgb,
            destination_rectangle: rectangle(0, 0, 16, 16),
            bitmap_data: vec![0; 8],
        }));

        // 못 그리는 것을 조용히 버리면 화면이 낡은 채로 남는다. 예전 경로로 다시 붙어야 한다.
        assert!(unusable.load(Ordering::Relaxed));
    }

    #[test]
    fn gives_up_when_clearcodec_decoding_breaks() {
        let (mut handler, _surface, unusable) = two_monitors_with_flag();

        handler.on_unhandled_pdu(&GfxPdu::WireToSurface1(WireToSurface1Pdu {
            surface_id: 2,
            codec_id: Codec1Type::ClearCodec,
            pixel_format: ironrdp_egfx::pdu::PixelFormat::XRgb,
            destination_rectangle: rectangle(0, 0, 16, 16),
            bitmap_data: vec![0xff; 4],
        }));

        // 캐시를 쓰는 코덱이라 한 번 어긋나면 뒤가 전부 깨진다. 그 자리에서 접는 것이 맞다.
        assert!(unusable.load(Ordering::Relaxed));
    }

    #[test]
    fn forgets_a_surface_once_it_is_deleted() {
        let (mut handler, surface) = two_monitors();
        handler.on_surface_deleted(2);

        handler.on_solid_fill(&SolidFillPdu {
            surface_id: 2,
            fill_pixel: Color {
                b: 1,
                g: 1,
                r: 1,
                xa: 0,
            },
            rectangles: vec![rectangle(0, 0, 4, 4)],
        });

        // 지워진 서피스의 좌표를 계속 믿으면 남의 자리에 그리게 된다.
        assert_eq!(dirty(&surface), None);
    }
}
