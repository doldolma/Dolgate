//! RDPDR — sharing a local folder into the remote session.
//!
//! The redirected drive is a folder on THIS machine (the client), exposed to the remote as a
//! network drive. That is the opposite of Guacamole's model, where the "drive" lives on the proxy.
//!
//! Platform reality: the upstream filesystem backend (`ironrdp-rdpdr-native`) is gated to macOS and
//! Linux. There is no Windows backend published yet — the work is in flight upstream as stacked
//! PRs. Rather than announce a drive we cannot serve (which makes the remote show a drive that
//! errors on every access), Windows clients get a clear refusal.

use ironrdp_rdpdr::Rdpdr;

/// The device id the remote uses to address our shared folder. One share, so one id.
const DRIVE_DEVICE_ID: u32 = 1;

/// What to share, resolved from the connect payload.
pub struct DriveShareConfig {
    pub label: String,
    pub path: String,
    pub read_only: bool,
}

/// Attaches a shared folder to the RDPDR channel.
///
/// `label` is what the remote shows as the drive name. `path` must already be validated by the
/// caller — this does not check that it exists, because the desktop side picked it.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn build_rdpdr(computer_name: String, share: Option<DriveShareConfig>) -> Rdpdr {
    use ironrdp_rdpdr_native::backend::NixRdpdrBackend;

    let Some(DriveShareConfig { label, path, read_only }) = share else {
        // 공유 폴더가 없으면 채널 자체를 붙이지 않는 편이 낫지만, 호출부가 항상 Rdpdr 를
        // 기대하므로 드라이브 없는 채널을 만든다. 서버에는 아무 장치도 announce 되지 않는다.
        return Rdpdr::new(Box::new(NixRdpdrBackend::new(String::new())), computer_name);
    };

    let backend = if read_only {
        NixRdpdrBackend::new_read_only(path)
    } else {
        NixRdpdrBackend::new(path)
    };

    Rdpdr::new(Box::new(backend), computer_name)
        .with_drives(Some(vec![(DRIVE_DEVICE_ID, label)]))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn build_rdpdr(computer_name: String, share: Option<DriveShareConfig>) -> Rdpdr {
    use ironrdp_rdpdr::NoopRdpdrBackend;

    if share.is_some() {
        tracing::warn!(
            "drive redirection is not available on this platform yet; the folder will not be shared"
        );
    }

    // 장치를 announce 하지 않는다. 원격에 드라이브가 보이는데 모든 접근이 실패하는 것보다
    // 아예 없는 편이 낫다.
    Rdpdr::new(Box::new(NoopRdpdrBackend), computer_name)
}

/// Whether this platform can actually serve a redirected folder.
pub const fn is_supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "linux"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_support_matching_the_upstream_backend_gate() {
        // ironrdp-rdpdr-native 가 macOS/Linux 로만 컴파일된다. 이 상수가 그것과 어긋나면
        // Windows 에서 붙지 않는 드라이브를 announce 하게 된다.
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert!(is_supported());
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        assert!(!is_supported());
    }
}
