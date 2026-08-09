//! EGFX 가 그려 나가는 프레임버퍼.
//!
//! 그래픽 파이프라인의 명령은 대부분 픽셀을 나르지 않는다 — "이 사각형을 저기로 옮겨라",
//! "이 칸에 담아 뒀다가 저기에 놓아라", "여기를 이 색으로 채워라". 그러려면 지금 화면이 어떻게
//! 생겼는지 들고 있는 곳이 있어야 하고, 그게 여기다.
//!
//! 렌더러가 아니라 여기서 합성한다. 렌더러는 이미 잘 도는 프레임 경로(사각형 + 픽셀)만 쓰고,
//! 옮기고 채우는 일은 전부 이쪽에서 끝난다 — 그래야 한 연산 한 연산을 테스트로 붙들 수 있다.
//!
//! 서버가 화면 한 장을 다시 인코딩해 보내지 않는다는 이득은 그대로다. 여기서 옮긴 결과만
//! 로컬 파이프로 나간다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 픽셀당 바이트. 렌더러가 RGBA 를 기대한다.
const BYTES_PER_PIXEL: usize = 4;

/// 한 번에 들고 갈 변경 사각형의 최대 개수.
///
/// 너무 적으면 멀리 떨어진 변경들이 하나로 뭉쳐 그 사이까지 다시 보내게 되고, 너무 많으면
/// 프레임 수가 늘어 그 자체가 비용이 된다.
const MAX_DIRTY_RECTS: usize = 8;

/// 합치면서 늘어나도 받아들일 넓이(픽셀).
///
/// 대략 320x180 이다. 이보다 크게 늘어나면 그 사이의 멀쩡한 화면을 다시 보내는 셈이라 따로
/// 보내는 편이 낫다.
const MERGE_SLACK: u64 = 320 * 180;

/// 두 사각형이 겹치는 넓이. 합치는 값이 이만큼은 이미 겹쳐 있다는 뜻이다.
fn overlap_area(a: (u16, u16, u16, u16), b: (u16, u16, u16, u16)) -> u64 {
    let left = a.0.max(b.0);
    let top = a.1.max(b.1);
    let right = a.2.min(b.2);
    let bottom = a.3.min(b.3);
    if right <= left || bottom <= top {
        return 0;
    }
    u64::from(right - left) * u64::from(bottom - top)
}

fn union(a: (u16, u16, u16, u16), b: (u16, u16, u16, u16)) -> (u16, u16, u16, u16) {
    (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3))
}

fn area(rect: (u16, u16, u16, u16)) -> u64 {
    u64::from(rect.2.saturating_sub(rect.0)) * u64::from(rect.3.saturating_sub(rect.1))
}

/// 캐시 칸 하나.
struct CachedTile {
    width: u16,
    height: u16,
    pixels: Vec<u8>,
}

/// 바뀐 사각형(오른쪽·아래는 열린 구간).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirtyRect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

pub struct EgfxSurface {
    width: u16,
    height: u16,
    pixels: Vec<u8>,
    cache: HashMap<u16, CachedTile>,
    /// 마지막으로 내보낸 뒤에 바뀐 영역들. left, top, right, bottom(열린 구간).
    ///
    /// 하나로 합치지 않는다. 화면 위쪽 한 줄과 아래쪽 한 줄이 바뀌었을 뿐인데 하나로 뭉치면
    /// 그 사이 전부를 다시 보내게 된다 — 스크롤 한 번에 화면 몇 장을 보내던 원인이 이것이다.
    dirty: Vec<(u16, u16, u16, u16)>,
    /// 겹치는 영역을 옮길 때 거쳐 가는 곳. 매번 새로 잡지 않는다.
    scratch: Vec<u8>,
}

/// 핸들러(세션 스레드 안쪽)와 펌프 루프가 나눠 갖는다.
pub type EgfxSurfaceHandle = Arc<Mutex<EgfxSurface>>;

pub fn new_surface() -> EgfxSurfaceHandle {
    Arc::new(Mutex::new(EgfxSurface::new()))
}

impl EgfxSurface {
    pub fn new() -> Self {
        Self {
            width: 0,
            height: 0,
            pixels: Vec::new(),
            cache: HashMap::new(),
            dirty: Vec::new(),
            scratch: Vec::new(),
        }
    }

    /// 화면 크기가 정해졌다. 내용은 사라진다 — 서버가 곧 전부 다시 그린다.
    pub fn resize(&mut self, width: u16, height: u16) {
        if self.width == width && self.height == height {
            return;
        }
        self.width = width;
        self.height = height;
        self.pixels = vec![0; usize::from(width) * usize::from(height) * BYTES_PER_PIXEL];
        self.dirty.clear();
        // 캐시는 화면과 함께 버린다. 크기가 바뀌었다는 것은 서버가 세션을 다시 그린다는 뜻이라,
        // 옛 화면에서 떠 둔 조각을 들고 있어 봐야 엉뚱한 그림만 나온다.
        self.cache.clear();
    }

    pub fn size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0
    }

    /// 사각형을 화면 안으로 자른다. 남는 것이 없으면 None.
    fn clip(&self, x: u16, y: u16, width: u16, height: u16) -> Option<(u16, u16, u16, u16)> {
        if self.is_empty() || width == 0 || height == 0 || x >= self.width || y >= self.height {
            return None;
        }
        let right = x.saturating_add(width).min(self.width);
        let bottom = y.saturating_add(height).min(self.height);
        if right <= x || bottom <= y {
            return None;
        }
        Some((x, y, right - x, bottom - y))
    }

    fn mark_dirty(&mut self, x: u16, y: u16, width: u16, height: u16) {
        let rect = (x, y, x.saturating_add(width), y.saturating_add(height));

        // 합쳐서 크게 손해가 아니면 합친다.
        //
        // 사각형을 따로 보내면 그만큼 프레임 수가 늘고, 프레임 하나하나가 렌더러에서 비용이다.
        // 반대로 무조건 합치면 멀리 떨어진 두 변경 사이의 멀쩡한 화면까지 다시 보내게 된다.
        // 그래서 "합쳤을 때 늘어나는 넓이"가 작을 때만 합친다.
        let mut best: Option<(usize, u64)> = None;
        for (index, existing) in self.dirty.iter().enumerate() {
            let added = area(union(*existing, rect)) - area(*existing) - area(rect)
                + overlap_area(*existing, rect);
            if best.map(|(_, cost)| added < cost).unwrap_or(true) {
                best = Some((index, added));
            }
        }

        if let Some((index, added)) = best {
            if added <= MERGE_SLACK {
                self.dirty[index] = union(self.dirty[index], rect);
                return;
            }
        }

        if self.dirty.len() < MAX_DIRTY_RECTS {
            self.dirty.push(rect);
            return;
        }

        // 자리가 없으면 가장 덜 커지는 짝을 합친다. 사각형 수를 늘리는 것보다 조금 넓게 보내는
        // 편이 낫다.
        self.dirty.push(rect);
        let mut pair = (0_usize, 1_usize, u64::MAX);
        for i in 0..self.dirty.len() {
            for j in (i + 1)..self.dirty.len() {
                let cost = area(union(self.dirty[i], self.dirty[j]));
                if cost < pair.2 {
                    pair = (i, j, cost);
                }
            }
        }
        self.dirty[pair.0] = union(self.dirty[pair.0], self.dirty[pair.1]);
        self.dirty.remove(pair.1);
    }

    /// 디코딩된 RGBA 조각을 화면에 얹는다.
    pub fn write(&mut self, x: u16, y: u16, width: u16, height: u16, pixels: &[u8]) {
        let Some((x, y, clipped_width, clipped_height)) = self.clip(x, y, width, height) else {
            return;
        };
        let source_stride = usize::from(width) * BYTES_PER_PIXEL;
        if pixels.len() < source_stride * usize::from(height) {
            // 잘린 조각을 그리면 화면이 깨진 채로 남는다.
            return;
        }

        let stride = self.stride();
        let row_bytes = usize::from(clipped_width) * BYTES_PER_PIXEL;
        for row in 0..usize::from(clipped_height) {
            let from = row * source_stride;
            let to = (usize::from(y) + row) * stride + usize::from(x) * BYTES_PER_PIXEL;
            self.pixels[to..to + row_bytes].copy_from_slice(&pixels[from..from + row_bytes]);
        }

        self.mark_dirty(x, y, clipped_width, clipped_height);
    }

    /// 화면 안에서 한 영역을 다른 자리로 옮긴다. 스크롤이 이걸로 온다.
    pub fn copy(
        &mut self,
        source_x: u16,
        source_y: u16,
        width: u16,
        height: u16,
        dest_x: u16,
        dest_y: u16,
    ) {
        // 원본과 목적지 양쪽이 화면 안에 들어오는 만큼만 옮긴다.
        let Some((source_x, source_y, width, height)) = self.clip(source_x, source_y, width, height)
        else {
            return;
        };
        let Some((dest_x, dest_y, width, height)) = self.clip(dest_x, dest_y, width, height) else {
            return;
        };

        let stride = self.stride();
        let row_bytes = usize::from(width) * BYTES_PER_PIXEL;

        // 원본과 목적지는 거의 항상 겹친다(화면을 조금 밀어 올리는 것이 곧 스크롤이다). 한 번
        // 받아 두고 옮기면 방향을 따질 필요가 없다.
        self.scratch.clear();
        self.scratch.reserve(row_bytes * usize::from(height));
        for row in 0..usize::from(height) {
            let from = (usize::from(source_y) + row) * stride + usize::from(source_x) * BYTES_PER_PIXEL;
            self.scratch
                .extend_from_slice(&self.pixels[from..from + row_bytes]);
        }

        for row in 0..usize::from(height) {
            let from = row * row_bytes;
            let to = (usize::from(dest_y) + row) * stride + usize::from(dest_x) * BYTES_PER_PIXEL;
            self.pixels[to..to + row_bytes].copy_from_slice(&self.scratch[from..from + row_bytes]);
        }

        self.mark_dirty(dest_x, dest_y, width, height);
    }

    /// 한 가지 색으로 채운다.
    pub fn fill(&mut self, x: u16, y: u16, width: u16, height: u16, r: u8, g: u8, b: u8) {
        let Some((x, y, width, height)) = self.clip(x, y, width, height) else {
            return;
        };

        let stride = self.stride();
        for row in 0..usize::from(height) {
            let start = (usize::from(y) + row) * stride + usize::from(x) * BYTES_PER_PIXEL;
            for pixel in self.pixels[start..start + usize::from(width) * BYTES_PER_PIXEL]
                .chunks_exact_mut(BYTES_PER_PIXEL)
            {
                pixel[0] = r;
                pixel[1] = g;
                pixel[2] = b;
                pixel[3] = 0xFF;
            }
        }

        self.mark_dirty(x, y, width, height);
    }

    /// 화면 조각을 캐시 칸에 떠 둔다.
    pub fn cache_store(&mut self, slot: u16, source_x: u16, source_y: u16, width: u16, height: u16) {
        let Some((source_x, source_y, width, height)) = self.clip(source_x, source_y, width, height)
        else {
            return;
        };

        let stride = self.stride();
        let row_bytes = usize::from(width) * BYTES_PER_PIXEL;
        let mut pixels = Vec::with_capacity(row_bytes * usize::from(height));
        for row in 0..usize::from(height) {
            let from = (usize::from(source_y) + row) * stride + usize::from(source_x) * BYTES_PER_PIXEL;
            pixels.extend_from_slice(&self.pixels[from..from + row_bytes]);
        }

        self.cache.insert(
            slot,
            CachedTile {
                width,
                height,
                pixels,
            },
        );
    }

    /// 캐시 칸의 조각을 화면에 놓는다. 모르는 칸이면 false.
    pub fn cache_restore(&mut self, slot: u16, dest_x: u16, dest_y: u16) -> bool {
        let Some(tile) = self.cache.get(&slot) else {
            return false;
        };

        // 빌려서 쓰는 동안 self 를 또 빌릴 수 없다. 크기와 픽셀만 떼어 온다.
        let (width, height) = (tile.width, tile.height);
        let Some((dest_x, dest_y, clipped_width, clipped_height)) =
            self.clip(dest_x, dest_y, width, height)
        else {
            return true;
        };

        let stride = self.stride();
        let source_stride = usize::from(width) * BYTES_PER_PIXEL;
        let row_bytes = usize::from(clipped_width) * BYTES_PER_PIXEL;

        // 캐시와 화면을 동시에 빌리지 않도록 한 번 떠 온다. 칸은 작아서(아이콘·창틀) 부담이 없다.
        self.scratch.clear();
        {
            let tile = &self.cache[&slot];
            for row in 0..usize::from(clipped_height) {
                let from = row * source_stride;
                self.scratch
                    .extend_from_slice(&tile.pixels[from..from + row_bytes]);
            }
        }

        for row in 0..usize::from(clipped_height) {
            let from = row * row_bytes;
            let to = (usize::from(dest_y) + row) * stride + usize::from(dest_x) * BYTES_PER_PIXEL;
            self.pixels[to..to + row_bytes].copy_from_slice(&self.scratch[from..from + row_bytes]);
        }

        self.mark_dirty(dest_x, dest_y, clipped_width, clipped_height);
        true
    }

    pub fn cache_evict(&mut self, slot: u16) {
        self.cache.remove(&slot);
    }

    /// 화면 전체를 다시 내보내야 한다고 표시한다.
    ///
    ///
    /// 탭이 돌아오거나 창이 새로 붙으면 렌더러의 누적본이 비어 있을 수 있다. 그때 서버에
    /// 다시 달라고 할 수는 없으므로(서버는 이미 보냈다고 여긴다) 우리가 들고 있는 화면을
    /// 통째로 내보낸다.
    pub fn mark_all_dirty(&mut self) {
        if self.is_empty() {
            return;
        }
        self.dirty.clear();
        self.dirty.push((0, 0, self.width, self.height));
    }

    /// 바뀐 영역들을 가져가고 표시를 지운다.
    pub fn take_dirty(&mut self, out: &mut Vec<DirtyRect>) {
        out.clear();
        for (left, top, right, bottom) in self.dirty.drain(..) {
            if right <= left || bottom <= top {
                continue;
            }
            out.push(DirtyRect {
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
            });
        }
    }

    /// 한 사각형의 픽셀을 촘촘히 담아 낸다. 그대로 프레임으로 나간다.
    pub fn extract(&self, rect: DirtyRect, out: &mut Vec<u8>) {
        out.clear();
        let Some((x, y, width, height)) = self.clip(rect.x, rect.y, rect.width, rect.height) else {
            return;
        };

        let stride = self.stride();
        let row_bytes = usize::from(width) * BYTES_PER_PIXEL;
        out.reserve(row_bytes * usize::from(height));
        for row in 0..usize::from(height) {
            let from = (usize::from(y) + row) * stride + usize::from(x) * BYTES_PER_PIXEL;
            out.extend_from_slice(&self.pixels[from..from + row_bytes]);
        }
    }

    fn stride(&self) -> usize {
        usize::from(self.width) * BYTES_PER_PIXEL
    }
}

impl Default for EgfxSurface {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 변경 사각형을 하나만 기대하는 자리를 위한 도우미.
    fn only_dirty(surface: &mut EgfxSurface) -> Option<DirtyRect> {
        let mut rects = Vec::new();
        surface.take_dirty(&mut rects);
        assert!(rects.len() <= 1, "expected at most one rectangle, got {rects:?}");
        rects.into_iter().next()
    }

    fn all_dirty(surface: &mut EgfxSurface) -> Vec<DirtyRect> {
        let mut rects = Vec::new();
        surface.take_dirty(&mut rects);
        rects
    }

    /// 픽셀 하나를 RGBA 로 읽는다.
    fn pixel(surface: &EgfxSurface, x: u16, y: u16) -> [u8; 4] {
        let at = (usize::from(y) * usize::from(surface.width) + usize::from(x)) * BYTES_PER_PIXEL;
        [
            surface.pixels[at],
            surface.pixels[at + 1],
            surface.pixels[at + 2],
            surface.pixels[at + 3],
        ]
    }

    fn solid(width: u16, height: u16, colour: [u8; 4]) -> Vec<u8> {
        colour
            .iter()
            .cycle()
            .take(usize::from(width) * usize::from(height) * BYTES_PER_PIXEL)
            .copied()
            .collect()
    }

    #[test]
    fn writes_a_rectangle_and_reports_it_dirty() {
        let mut surface = EgfxSurface::new();
        surface.resize(8, 4);

        surface.write(2, 1, 2, 2, &solid(2, 2, [1, 2, 3, 255]));

        assert_eq!(pixel(&surface, 2, 1), [1, 2, 3, 255]);
        assert_eq!(pixel(&surface, 3, 2), [1, 2, 3, 255]);
        // 손대지 않은 자리는 그대로.
        assert_eq!(pixel(&surface, 0, 0), [0, 0, 0, 0]);
        assert_eq!(
            only_dirty(&mut surface),
            Some(DirtyRect {
                x: 2,
                y: 1,
                width: 2,
                height: 2
            })
        );
        // 가져갔으면 표시는 사라진다.
        assert_eq!(only_dirty(&mut surface), None);
    }

    #[test]
    fn moves_an_overlapping_region() {
        // 스크롤이 정확히 이 모양이다 — 원본과 목적지가 크게 겹친다.
        let mut surface = EgfxSurface::new();
        surface.resize(4, 4);
        // 각 행을 행 번호로 칠한다.
        for y in 0..4u16 {
            surface.write(0, y, 4, 1, &solid(4, 1, [y as u8, 0, 0, 255]));
        }
        let _ = all_dirty(&mut surface);

        // 두 행 위로 민다: (0,2) 2행을 (0,0) 으로.
        surface.copy(0, 2, 4, 2, 0, 0);

        assert_eq!(pixel(&surface, 0, 0), [2, 0, 0, 255]);
        assert_eq!(pixel(&surface, 0, 1), [3, 0, 0, 255]);
        // 원본이 있던 자리는 서버가 새로 그려 줄 때까지 그대로다.
        assert_eq!(pixel(&surface, 0, 2), [2, 0, 0, 255]);
        assert_eq!(
            only_dirty(&mut surface),
            Some(DirtyRect {
                x: 0,
                y: 0,
                width: 4,
                height: 2
            })
        );
    }

    #[test]
    fn fills_a_rectangle_opaque() {
        let mut surface = EgfxSurface::new();
        surface.resize(4, 4);

        surface.fill(1, 1, 2, 2, 10, 20, 30);

        assert_eq!(pixel(&surface, 1, 1), [10, 20, 30, 255]);
        assert_eq!(pixel(&surface, 2, 2), [10, 20, 30, 255]);
        assert_eq!(pixel(&surface, 3, 3), [0, 0, 0, 0]);
    }

    #[test]
    fn stores_and_restores_a_tile() {
        let mut surface = EgfxSurface::new();
        surface.resize(8, 4);
        surface.write(0, 0, 2, 2, &solid(2, 2, [9, 9, 9, 255]));
        let _ = all_dirty(&mut surface);

        surface.cache_store(7, 0, 0, 2, 2);
        assert!(surface.cache_restore(7, 4, 2));

        assert_eq!(pixel(&surface, 4, 2), [9, 9, 9, 255]);
        assert_eq!(pixel(&surface, 5, 3), [9, 9, 9, 255]);
        assert_eq!(
            only_dirty(&mut surface),
            Some(DirtyRect {
                x: 4,
                y: 2,
                width: 2,
                height: 2
            })
        );

        surface.cache_evict(7);
        // 비운 칸을 계속 들고 있으면 서버가 그 번호를 재사용할 때 옛 그림이 나온다.
        assert!(!surface.cache_restore(7, 0, 0));
    }

    #[test]
    fn keeps_far_apart_changes_apart() {
        // 떨어진 두 변경을 하나로 뭉치면 그 사이 전부를 다시 보내게 된다 — 스크롤 한 번에 화면
        // 몇 장씩 나가던 원인이 이것이었다.
        let mut surface = EgfxSurface::new();
        surface.resize(1920, 1080);

        surface.fill(0, 0, 64, 64, 0, 0, 0);
        surface.fill(1800, 1000, 64, 64, 0, 0, 0);

        let rects = all_dirty(&mut surface);
        assert_eq!(rects.len(), 2);
        assert!(rects.contains(&DirtyRect { x: 0, y: 0, width: 64, height: 64 }));
        assert!(rects.contains(&DirtyRect { x: 1800, y: 1000, width: 64, height: 64 }));
    }

    #[test]
    fn merges_changes_that_are_close_together() {
        // 붙어 있는 것들까지 따로 보내면 프레임 수만 늘고 렌더러 비용이 그만큼 커진다.
        let mut surface = EgfxSurface::new();
        surface.resize(1920, 1080);

        surface.fill(100, 100, 64, 64, 0, 0, 0);
        surface.fill(150, 120, 64, 64, 0, 0, 0);

        let rects = all_dirty(&mut surface);
        assert_eq!(rects.len(), 1);
        assert_eq!(rects[0], DirtyRect { x: 100, y: 100, width: 114, height: 84 });
    }

    #[test]
    fn caps_how_many_rectangles_it_tracks() {
        // 사각형이 무한정 늘면 프레임 수가 그만큼 늘어 그 자체가 비용이 된다.
        let mut surface = EgfxSurface::new();
        surface.resize(512, 512);

        for i in 0..64u16 {
            surface.fill(i * 8, 500 - i * 4, 2, 2, 0, 0, 0);
        }

        assert!(all_dirty(&mut surface).len() <= 8);
    }

    #[test]
    fn clips_everything_to_the_screen() {
        let mut surface = EgfxSurface::new();
        surface.resize(4, 4);

        // 화면 밖으로 걸친 것들. 잘라 쓰거나 버리되, 절대 넘어 쓰지 않는다.
        surface.write(3, 3, 4, 4, &solid(4, 4, [5, 5, 5, 255]));
        surface.fill(10, 10, 4, 4, 1, 1, 1);
        surface.copy(2, 2, 4, 4, 0, 0);

        assert_eq!(pixel(&surface, 3, 3), [5, 5, 5, 255]);
    }

    #[test]
    fn marks_the_whole_screen_when_a_refresh_is_asked_for() {
        // 탭이 돌아왔을 때 렌더러의 누적본이 비어 있을 수 있다. 서버는 이미 보냈다고 여기므로
        // 우리가 들고 있는 화면을 통째로 다시 내보내는 것이 유일한 복구 수단이다.
        let mut surface = EgfxSurface::new();
        surface.resize(8, 4);
        let _ = all_dirty(&mut surface);

        surface.mark_all_dirty();

        assert_eq!(
            only_dirty(&mut surface),
            Some(DirtyRect {
                x: 0,
                y: 0,
                width: 8,
                height: 4
            })
        );
    }

    #[test]
    fn extracts_a_rectangle_row_by_row() {
        let mut surface = EgfxSurface::new();
        surface.resize(4, 2);
        surface.write(0, 0, 4, 1, &solid(4, 1, [1, 1, 1, 255]));
        surface.write(0, 1, 4, 1, &solid(4, 1, [2, 2, 2, 255]));

        let rect = only_dirty(&mut surface).unwrap();
        let mut out = Vec::new();
        surface.extract(rect, &mut out);

        // 두 행이 stride 없이 촘촘히 이어져야 한다 — 렌더러가 그렇게 읽는다.
        assert_eq!(out.len(), 4 * 2 * BYTES_PER_PIXEL);
        assert_eq!(&out[0..4], &[1, 1, 1, 255]);
        assert_eq!(&out[4 * 4..4 * 4 + 4], &[2, 2, 2, 255]);
    }

    #[test]
    fn forgets_everything_when_the_screen_is_resized() {
        let mut surface = EgfxSurface::new();
        surface.resize(4, 4);
        surface.write(0, 0, 2, 2, &solid(2, 2, [9, 9, 9, 255]));
        surface.cache_store(1, 0, 0, 2, 2);

        surface.resize(8, 8);

        assert_eq!(surface.size(), (8, 8));
        assert_eq!(pixel(&surface, 0, 0), [0, 0, 0, 0]);
        // 옛 화면에서 떠 둔 조각은 새 화면에 놓을 자리가 없다.
        assert!(!surface.cache_restore(1, 0, 0));
        assert_eq!(only_dirty(&mut surface), None);
    }
}
