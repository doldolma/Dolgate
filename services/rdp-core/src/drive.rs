//! RDPDR — sharing a local folder into the remote session.
//!
//! The redirected drive is a folder on THIS machine (the client), exposed to the remote as a
//! network drive. That is the opposite of Guacamole's model, where the "drive" lives on the proxy.
//!
//! Platform reality: the native filesystem backend works on Unix targets, including mobile
//! iOS/Android sandboxes. Windows still has no published backend; rather than announce a drive we
//! cannot serve, Windows clients get a clear refusal.

use ironrdp_rdpdr::Rdpdr;

/// 첫 공유 폴더에 줄 장치 번호. 목록 순서대로 하나씩 올려 배정한다.
///
/// 0 은 쓰지 않는다 — 장치 번호가 0 이면 "장치 없음"으로 읽는 구현이 있다.
const FIRST_DRIVE_DEVICE_ID: u32 = 1;

/// What to share, resolved from the connect payload.
pub struct DriveShareConfig {
    pub label: String,
    pub path: String,
    pub read_only: bool,
}

/// 공유 폴더들을 RDPDR 채널에 붙인다.
///
/// `label` 은 원격에 보이는 드라이브 이름이다. 이름을 여기서 만들지 않는 이유: 편집 화면이 같은
/// 이름을 보여주므로, 규칙이 두 곳에 있으면 보여준 것과 원격에 뜨는 것이 갈린다.
///
/// `path` 는 announce 전에 절대 경로인지, 접근 가능한 디렉터리인지 확인하고 canonicalize한다.
/// 검증에 실패한 항목은 backend root와 원격 장치 목록 양쪽에서 제외한다.
#[cfg(unix)]
pub fn build_rdpdr(computer_name: String, drives: Vec<DriveShareConfig>) -> Rdpdr {
    use ironrdp_rdpdr_native::backend::{DriveRoot, NixRdpdrBackend};

    let assigned = assign_device_ids(&drives);
    let mut roots = std::collections::HashMap::new();
    let mut announced = Vec::new();
    for (device_id, drive) in assigned {
        let requested = std::path::Path::new(drive.path.trim());
        if !requested.is_absolute() {
            tracing::warn!(path = %drive.path, "shared drive path is not absolute; skipping");
            continue;
        }
        let canonical = match std::fs::canonicalize(requested) {
            Ok(path) if path.is_dir() => path,
            Ok(_) => {
                tracing::warn!(path = %drive.path, "shared drive path is not a directory; skipping");
                continue;
            }
            Err(error) => {
                tracing::warn!(path = %drive.path, %error, "shared drive path is unavailable; skipping");
                continue;
            }
        };
        let Some(canonical) = canonical.to_str() else {
            tracing::warn!(path = %drive.path, "shared drive path is not valid UTF-8; skipping");
            continue;
        };
        roots.insert(
            device_id,
            DriveRoot {
                path: canonical.to_owned(),
                read_only: drive.read_only,
            },
        );
        announced.push((device_id, drive.label.clone()));
    }
    let backend = NixRdpdrBackend::new(roots);

    let rdpdr = Rdpdr::new(Box::new(backend), computer_name);
    if announced.is_empty() {
        rdpdr
    } else {
        rdpdr.with_drives(Some(announced))
    }
}

/// 목록 순서대로 장치 번호를 배정한다.
///
/// 경로가 빈 항목은 버린다 — 원격에 드라이브만 뜨고 모든 접근이 실패하는 것보다 없는 편이 낫다.
fn assign_device_ids(drives: &[DriveShareConfig]) -> Vec<(u32, &DriveShareConfig)> {
    drives
        .iter()
        .filter(|drive| !drive.path.trim().is_empty())
        .enumerate()
        .map(|(index, drive)| {
            // enumerate 는 0 부터라 첫 번호에 맞춰 올린다.
            #[expect(clippy::arithmetic_side_effects, reason = "드라이브 수는 한 자리다")]
            let device_id = FIRST_DRIVE_DEVICE_ID + index as u32;
            (device_id, drive)
        })
        .collect()
}

#[cfg(not(unix))]
pub fn build_rdpdr(computer_name: String, drives: Vec<DriveShareConfig>) -> Rdpdr {
    use ironrdp_rdpdr::NoopRdpdrBackend;

    if !drives.is_empty() {
        tracing::warn!(
            "drive redirection is not available on this platform yet; the folders will not be shared"
        );
    }

    // 장치를 announce 하지 않는다. 원격에 드라이브가 보이는데 모든 접근이 실패하는 것보다
    // 아예 없는 편이 낫다.
    Rdpdr::new(Box::new(NoopRdpdrBackend), computer_name)
}

/// Whether this platform can actually serve a redirected folder.
pub const fn is_supported() -> bool {
    cfg!(unix)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive(path: &str, read_only: bool) -> DriveShareConfig {
        DriveShareConfig {
            label: path.rsplit('/').next().unwrap_or(path).to_owned(),
            path: path.to_owned(),
            read_only,
        }
    }

    #[test]
    fn gives_each_drive_its_own_device_id() {
        // 번호가 겹치면 원격의 두 드라이브가 같은 폴더를 보게 된다.
        let drives = vec![drive("/a/docs", false), drive("/b/photos", true)];
        let assigned = assign_device_ids(&drives);

        assert_eq!(assigned.len(), 2);
        assert_eq!(assigned[0].0, FIRST_DRIVE_DEVICE_ID);
        assert_eq!(assigned[1].0, FIRST_DRIVE_DEVICE_ID + 1);
        assert_eq!(assigned[0].1.path, "/a/docs");
        assert_eq!(assigned[1].1.path, "/b/photos");
        assert!(assigned[1].1.read_only);
    }

    #[test]
    fn never_uses_device_id_zero() {
        // 장치 번호 0 을 "장치 없음"으로 읽는 구현이 있다.
        let drives = vec![drive("/a", false)];
        assert!(assign_device_ids(&drives).iter().all(|(id, _)| *id > 0));
    }

    #[test]
    fn drops_entries_without_a_path() {
        // 경로가 없으면 원격에 드라이브만 뜨고 모든 접근이 실패한다. 아예 안 붙이는 편이 낫다.
        let drives = vec![drive("/a", false), drive("   ", false)];
        let assigned = assign_device_ids(&drives);
        assert_eq!(assigned.len(), 1);
        assert_eq!(assigned[0].1.path, "/a");
    }

    #[test]
    fn announces_nothing_for_an_empty_list() {
        assert!(assign_device_ids(&[]).is_empty());
    }

    #[test]
    fn reports_support_matching_the_upstream_backend_gate() {
        // ironrdp-rdpdr-native 가 macOS/Linux 로만 컴파일된다. 이 상수가 그것과 어긋나면
        // Windows 에서 붙지 않는 드라이브를 announce 하게 된다.
        #[cfg(unix)]
        assert!(is_supported());
        #[cfg(not(unix))]
        assert!(!is_supported());
    }
}
