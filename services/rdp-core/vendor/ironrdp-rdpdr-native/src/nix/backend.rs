use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::fs::MetadataExt;

use ironrdp_core::impl_as_any;
use ironrdp_pdu::{PduResult, encode_err};
use ironrdp_rdpdr::RdpdrBackend;
use ironrdp_rdpdr::pdu::RdpdrPdu;
use ironrdp_rdpdr::pdu::efs::*;
use ironrdp_rdpdr::pdu::esc::{ScardCall, ScardIoCtlCode};
use ironrdp_svc::SvcMessage;
use nix::dir::{Dir, OwningIter};
use tracing::{debug, warn};

/// PATCH (Dolgate): 공유 폴더 하나.
#[derive(Debug, Clone)]
pub struct DriveRoot {
    /// 로컬 절대 경로. 원격이 준 경로는 항상 이 아래로 봉쇄된다.
    pub path: String,
    /// 원격이 이 폴더를 수정하지 못하게 한다.
    ///
    /// 상류에는 읽기 전용 개념이 없어 write/rename/delete 가 무조건 실행된다. 공유는 신뢰
    /// 경계를 넘기는 동작이라, 읽기만 필요한 경우에 쓰기까지 열어둘 이유가 없다.
    pub read_only: bool,
}

#[derive(Debug, Clone)]
struct OpenFileContext {
    device_id: u32,
    root: DriveRoot,
    path: String,
}

/// Bound every server-controlled read before allocating its response buffer.
const MAX_DEVICE_READ_BYTES: u32 = 1024 * 1024;

fn checked_device_read_length(length: u32) -> Option<usize> {
    if length > MAX_DEVICE_READ_BYTES {
        return None;
    }
    usize::try_from(length).ok()
}

#[derive(Debug, Default)]
pub struct NixRdpdrBackend {
    file_id: u32,
    /// PATCH (Dolgate): 장치 번호별 공유 루트.
    ///
    /// RDPDR 은 채널 하나에 드라이브 여러 개를 붙일 수 있고 요청마다 `device_id` 가 온다.
    /// 상류는 루트를 **하나만** 들고 있어서, 드라이브를 여럿 announce 하면 전부 같은 폴더를
    /// 보여 줬다. 요청의 device_id 로 루트를 골라야 폴더별로 갈린다.
    roots: std::collections::HashMap<u32, DriveRoot>,
    file_map: std::collections::HashMap<u32, std::fs::File>,
    /// The device/root/policy that authorized each open file ID. Follow-up
    /// requests must match this owner instead of trusting their claimed device.
    file_context_map: std::collections::HashMap<u32, OpenFileContext>,
    file_dir_map: std::collections::HashMap<u32, OwningIter>,
}

impl NixRdpdrBackend {
    /// PATCH (Dolgate): 장치 번호 → 공유 루트.
    pub fn new(roots: std::collections::HashMap<u32, DriveRoot>) -> Self {
        Self {
            roots,
            ..Default::default()
        }
    }

    /// 이 요청이 가리키는 공유 루트. 모르는 장치면 `None` — 그때는 요청을 거절해야 한다.
    /// 임의의 루트로 대신 처리하면 다른 공유 폴더의 내용이 새어 나간다.
    fn root_of(&self, device_id: u32) -> Option<&DriveRoot> {
        self.roots.get(&device_id)
    }

    /// 이 요청의 공유 루트 경로. 모르는 장치면 `None`.
    fn base_of(&self, device_id: u32) -> Option<&str> {
        self.root_of(device_id).map(|root| root.path.as_str())
    }

    /// 이 장치가 읽기 전용인지. 모르는 장치는 쓰기를 막는다(안전한 쪽).
    fn is_read_only(&self, device_id: u32) -> bool {
        self.root_of(device_id).map(|root| root.read_only).unwrap_or(true)
    }

    fn file_context_for_ids(&self, device_id: u32, file_id: u32) -> Option<&OpenFileContext> {
        self.file_context_map
            .get(&file_id)
            .filter(|context| context.device_id == device_id)
    }

    fn file_context_for(&self, request: &DeviceIoRequest) -> Option<&OpenFileContext> {
        self.file_context_for_ids(request.device_id, request.file_id)
    }

    fn register_file(&mut self, file_id: u32, device_id: u32, path: String, file: std::fs::File) {
        let root = self
            .root_of(device_id)
            .cloned()
            .expect("device root was validated before opening a file");
        self.file_map.insert(file_id, file);
        self.file_context_map.insert(
            file_id,
            OpenFileContext {
                device_id,
                root,
                path,
            },
        );
    }

    fn remove_file(&mut self, file_id: u32) {
        self.file_map.remove(&file_id);
        self.file_context_map.remove(&file_id);
        self.file_dir_map.remove(&file_id);
    }
}

impl_as_any!(NixRdpdrBackend);

impl RdpdrBackend for NixRdpdrBackend {
    fn handle_server_device_announce_response(&mut self, _pdu: ServerDeviceAnnounceResponse) -> PduResult<()> {
        Ok(())
    }
    fn handle_scard_call(&mut self, _req: DeviceControlRequest<ScardIoCtlCode>, _call: ScardCall) -> PduResult<()> {
        Ok(())
    }
    fn handle_drive_io_request(&mut self, req: ServerDriveIoRequest) -> PduResult<Vec<SvcMessage>> {
        debug!("handle_drive_io_request:{:?}", req);
        match req {
            ServerDriveIoRequest::DeviceWriteRequest(req_inner) => write_device(self, req_inner),
            ServerDriveIoRequest::ServerCreateDriveRequest(req_inner) => create_drive(self, req_inner),
            ServerDriveIoRequest::DeviceReadRequest(req_inner) => read_device(self, req_inner),
            ServerDriveIoRequest::DeviceCloseRequest(req_inner) => close_device(self, req_inner),
            ServerDriveIoRequest::ServerDriveNotifyChangeDirectoryRequest(_) => {
                // TODO
                Ok(Vec::new())
            }
            ServerDriveIoRequest::ServerDriveQueryDirectoryRequest(req_inner) => query_directory(self, req_inner),
            ServerDriveIoRequest::ServerDriveQueryInformationRequest(req_inner) => query_information(self, req_inner),
            ServerDriveIoRequest::ServerDriveQueryVolumeInformationRequest(req_inner) => {
                query_volume_information(self, req_inner)
            }
            ServerDriveIoRequest::ServerDriveSetInformationRequest(req_inner) => set_information(self, req_inner),
            ServerDriveIoRequest::DeviceControlRequest(req_inner) => Ok(vec![SvcMessage::from(
                RdpdrPdu::DeviceControlResponse(DeviceControlResponse {
                    device_io_reply: DeviceIoResponse::new(req_inner.header, NtStatus::SUCCESS),
                    output_buffer: None,
                }),
            )]),
            ServerDriveIoRequest::ServerDriveLockControlRequest(_) => {
                // TODO
                Ok(Vec::new())
            }
        }
    }
}

pub(crate) fn write_device(backend: &mut NixRdpdrBackend, req_inner: DeviceWriteRequest) -> PduResult<Vec<SvcMessage>> {
    // Mutation policy belongs to the opened handle. A server must not pair a
    // read-only handle with another drive's writable device ID.
    if backend
        .file_context_for(&req_inner.device_io_request)
        .is_some_and(|context| context.root.read_only)
    {
        return Ok(vec![SvcMessage::from(RdpdrPdu::DeviceWriteResponse(
            DeviceWriteResponse {
                device_io_reply: DeviceIoResponse::new(
                    req_inner.device_io_request,
                    NtStatus::ACCESS_DENIED,
                ),
                length: 0,
            },
        ))]);
    }

    return process_dependent_file(
        backend,
        req_inner.device_io_request,
        |request| {
            let res = RdpdrPdu::DeviceWriteResponse(DeviceWriteResponse {
                device_io_reply: DeviceIoResponse::new(request, NtStatus::NO_SUCH_FILE),
                length: 0u32,
            });
            Ok(vec![SvcMessage::from(res)])
        },
        |file, request| match write_inner(file, req_inner.offset, &req_inner.write_data) {
            Ok(length) => {
                if length == req_inner.write_data.len() {
                    Ok(vec![SvcMessage::from(RdpdrPdu::DeviceWriteResponse(
                        DeviceWriteResponse {
                            device_io_reply: DeviceIoResponse::new(request, NtStatus::SUCCESS),
                            length: u32::try_from(req_inner.write_data.len()).unwrap(),
                        },
                    ))])
                } else {
                    warn!(
                        "Written content len:{} is not equal to {}",
                        length,
                        req_inner.write_data.len()
                    );
                    let res = RdpdrPdu::DeviceWriteResponse(DeviceWriteResponse {
                        device_io_reply: DeviceIoResponse::new(request, NtStatus::UNSUCCESSFUL),
                        length: 0u32,
                    });
                    Ok(vec![SvcMessage::from(res)])
                }
            }
            Err(error) => {
                warn!(%error, "Write error");
                let res = RdpdrPdu::DeviceWriteResponse(DeviceWriteResponse {
                    device_io_reply: DeviceIoResponse::new(request, NtStatus::UNSUCCESSFUL),
                    length: 0u32,
                });
                Ok(vec![SvcMessage::from(res)])
            }
        },
    );
    fn write_inner(file: &mut std::fs::File, offset: u64, write_data: &[u8]) -> std::io::Result<usize> {
        let sf = SeekFrom::Start(offset);
        file.seek(sf)?;
        let length = file.write(write_data)?;
        file.flush()?;
        Ok(length)
    }
}

pub(crate) fn read_device(backend: &mut NixRdpdrBackend, req_inner: DeviceReadRequest) -> PduResult<Vec<SvcMessage>> {
    let Some(read_length) = checked_device_read_length(req_inner.length) else {
        warn!(length = req_inner.length, "Refusing oversized drive read");
        return Ok(vec![SvcMessage::from(RdpdrPdu::DeviceReadResponse(
            DeviceReadResponse {
                device_io_reply: DeviceIoResponse::new(
                    req_inner.device_io_request,
                    NtStatus::UNSUCCESSFUL,
                ),
                read_data: Vec::new(),
            },
        ))]);
    };

    return process_dependent_file(
        backend,
        req_inner.device_io_request,
        |request| {
            let res = RdpdrPdu::DeviceReadResponse(DeviceReadResponse {
                device_io_reply: DeviceIoResponse::new(request, NtStatus::NO_SUCH_FILE),
                read_data: Vec::new(),
            });
            Ok(vec![SvcMessage::from(res)])
        },
        |file, request| match read_inner(file, req_inner.offset, read_length) {
            Ok(buf) => {
                let res = RdpdrPdu::DeviceReadResponse(DeviceReadResponse {
                    device_io_reply: DeviceIoResponse::new(request, NtStatus::SUCCESS),
                    read_data: buf,
                });
                Ok(vec![SvcMessage::from(res)])
            }
            Err(error) => {
                warn!(?error, "Read error");
                let res = RdpdrPdu::DeviceReadResponse(DeviceReadResponse {
                    device_io_reply: DeviceIoResponse::new(request, NtStatus::UNSUCCESSFUL),
                    read_data: Vec::new(),
                });
                Ok(vec![SvcMessage::from(res)])
            }
        },
    );

    fn read_inner(file: &mut std::fs::File, offset: u64, length: usize) -> std::io::Result<Vec<u8>> {
        let sf = SeekFrom::Start(offset);
        file.seek(sf)?;
        let mut buf = vec![0; length];

        let length = file.read(&mut buf)?;
        buf.resize(length, 0u8);
        Ok(buf)
    }
}

pub(crate) fn close_device(backend: &mut NixRdpdrBackend, req_inner: DeviceCloseRequest) -> PduResult<Vec<SvcMessage>> {
    let status = if backend.file_context_for(&req_inner.device_io_request).is_some() {
        backend.remove_file(req_inner.device_io_request.file_id);
        NtStatus::SUCCESS
    } else {
        // Do not let one drive close or probe another drive's handle.
        NtStatus::NO_SUCH_FILE
    };
    let res = RdpdrPdu::DeviceCloseResponse(DeviceCloseResponse {
        device_io_response: DeviceIoResponse::new(req_inner.device_io_request, status),
    });
    Ok(vec![SvcMessage::from(res)])
}

pub(crate) fn query_information(
    backend: &mut NixRdpdrBackend,
    req_inner: ServerDriveQueryInformationRequest,
) -> PduResult<Vec<SvcMessage>> {
    match backend
        .file_context_for(&req_inner.device_io_request)
        .and_then(|context| {
            backend
                .file_map
                .get(&req_inner.device_io_request.file_id)
                .map(|file| (context, file))
        })
    {
        Some((context, file)) => match file.metadata() {
            Ok(meta) => {
                let path = context.path.clone();
                let name_index = match path.rfind('/') {
                    // in fact, index only needs to be different for existing requests
                    #[expect(clippy::arithmetic_side_effects)]
                    Some(index) => index + 1,
                    None => 0,
                };
                let name = &path[name_index..];
                let file_attribute = get_file_attributes(&meta, name);
                if FileInformationClassLevel::FILE_BASIC_INFORMATION == req_inner.file_info_class_lvl {
                    let basic_info = FileBasicInformation {
                        creation_time: transform_to_filetime(meta.ctime()),
                        last_access_time: transform_to_filetime(meta.atime()),
                        last_write_time: transform_to_filetime(meta.mtime()),
                        change_time: transform_to_filetime(meta.ctime()),
                        file_attributes: file_attribute,
                    };
                    let res = RdpdrPdu::ClientDriveQueryInformationResponse(ClientDriveQueryInformationResponse {
                        device_io_response: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::SUCCESS),
                        buffer: Some(FileInformationClass::Basic(basic_info)),
                    });
                    Ok(vec![SvcMessage::from(res)])
                } else if FileInformationClassLevel::FILE_STANDARD_INFORMATION == req_inner.file_info_class_lvl {
                    let dir = if meta.is_dir() { Boolean::True } else { Boolean::False };
                    let standard_info = FileStandardInformation {
                        allocation_size: i64::try_from(meta.size()).unwrap(),
                        end_of_file: i64::try_from(meta.size()).unwrap(),
                        number_of_links: u32::try_from(meta.nlink()).unwrap(),
                        delete_pending: Boolean::False,
                        directory: dir,
                    };
                    let res = RdpdrPdu::ClientDriveQueryInformationResponse(ClientDriveQueryInformationResponse {
                        device_io_response: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::SUCCESS),
                        buffer: Some(FileInformationClass::Standard(standard_info)),
                    });
                    Ok(vec![SvcMessage::from(res)])
                } else if FileInformationClassLevel::FILE_ATTRIBUTE_TAG_INFORMATION == req_inner.file_info_class_lvl {
                    let info = FileAttributeTagInformation {
                        file_attributes: file_attribute,
                        reparse_tag: 0,
                    };
                    let res = RdpdrPdu::ClientDriveQueryInformationResponse(ClientDriveQueryInformationResponse {
                        device_io_response: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::SUCCESS),
                        buffer: Some(FileInformationClass::AttributeTag(info)),
                    });
                    Ok(vec![SvcMessage::from(res)])
                } else {
                    warn!("unsupported file class");
                    let res = RdpdrPdu::ClientDriveQueryInformationResponse(ClientDriveQueryInformationResponse {
                        device_io_response: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::UNSUCCESSFUL),
                        buffer: None,
                    });
                    Ok(vec![SvcMessage::from(res)])
                }
            }
            Err(error) => {
                warn!(?error, "Get file metadata error");
                let res = RdpdrPdu::ClientDriveQueryInformationResponse(ClientDriveQueryInformationResponse {
                    device_io_response: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::UNSUCCESSFUL),
                    buffer: None,
                });
                Ok(vec![SvcMessage::from(res)])
            }
        },
        None => {
            warn!("no such file");
            let res = RdpdrPdu::ClientDriveQueryInformationResponse(ClientDriveQueryInformationResponse {
                device_io_response: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::NO_SUCH_FILE),
                buffer: None,
            });
            Ok(vec![SvcMessage::from(res)])
        }
    }
}

pub(crate) fn query_volume_information(
    backend: &mut NixRdpdrBackend,
    req_inner: ServerDriveQueryVolumeInformationRequest,
) -> PduResult<Vec<SvcMessage>> {
    match backend
        .file_context_for(&req_inner.device_io_request)
        .and_then(|_| backend.file_map.get(&req_inner.device_io_request.file_id))
    {
        Some(file) => {
            if let Ok(statvfs) = nix::sys::statvfs::fstatvfs(file.as_fd()) {
                if FileSystemInformationClassLevel::FILE_FS_FULL_SIZE_INFORMATION == req_inner.fs_info_class_lvl {
                    #[cfg_attr(target_vendor = "apple", expect(clippy::unnecessary_fallible_conversions))]
                    let info = FileFsFullSizeInformation {
                        total_alloc_units: i64::try_from(statvfs.blocks()).unwrap(),
                        caller_available_alloc_units: i64::try_from(statvfs.blocks_available()).unwrap(),
                        actual_available_alloc_units: i64::try_from(statvfs.blocks_available()).unwrap(),
                        sectors_per_alloc_unit: u32::try_from(statvfs.fragment_size()).unwrap(),
                        bytes_per_sector: 1,
                    };

                    Ok(vec![SvcMessage::from(
                        RdpdrPdu::ClientDriveQueryVolumeInformationResponse(
                            ClientDriveQueryVolumeInformationResponse {
                                device_io_reply: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::SUCCESS),
                                buffer: Some(FileSystemInformationClass::FileFsFullSizeInformation(info)),
                            },
                        ),
                    )])
                } else if FileSystemInformationClassLevel::FILE_FS_ATTRIBUTE_INFORMATION == req_inner.fs_info_class_lvl
                {
                    Ok(vec![SvcMessage::from(
                        RdpdrPdu::ClientDriveQueryVolumeInformationResponse(
                            ClientDriveQueryVolumeInformationResponse {
                                device_io_reply: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::SUCCESS),
                                buffer: Some(FileSystemInformationClass::FileFsAttributeInformation(
                                    FileFsAttributeInformation {
                                        file_system_attributes: FileSystemAttributes::FILE_CASE_SENSITIVE_SEARCH
                                            | FileSystemAttributes::FILE_CASE_PRESERVED_NAMES
                                            | FileSystemAttributes::FILE_UNICODE_ON_DISK,
                                        max_component_name_len: 260,
                                        file_system_name: "FAT32".to_owned(),
                                    },
                                )),
                            },
                        ),
                    )])
                } else if FileSystemInformationClassLevel::FILE_FS_VOLUME_INFORMATION == req_inner.fs_info_class_lvl {
                    Ok(vec![SvcMessage::from(
                        RdpdrPdu::ClientDriveQueryVolumeInformationResponse(
                            ClientDriveQueryVolumeInformationResponse {
                                device_io_reply: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::SUCCESS),
                                buffer: Some(FileSystemInformationClass::FileFsVolumeInformation(
                                    FileFsVolumeInformation {
                                        volume_creation_time: transform_to_filetime(file.metadata().unwrap().ctime()),
                                        // blocks_available() may have different integer type on different platforms.
                                        // so we need to cast it to u32 uniformly. so if it is u32, it will emit 'useless conversion'
                                        // warning, i choose to mute it.
                                        #[expect(
                                            clippy::allow_attributes,
                                            reason = "we have to use allow as the useless_conversion isn't triggered on some platforms"
                                        )]
                                        #[allow(clippy::useless_conversion)]
                                        volume_serial_number: u32::try_from(statvfs.blocks_available()).unwrap(),
                                        supports_objects: Boolean::False,
                                        volume_label: "IRON_RDP".to_owned(),
                                    },
                                )),
                            },
                        ),
                    )])
                } else if FileSystemInformationClassLevel::FILE_FS_SIZE_INFORMATION == req_inner.fs_info_class_lvl {
                    Ok(vec![SvcMessage::from(
                        RdpdrPdu::ClientDriveQueryVolumeInformationResponse(
                            ClientDriveQueryVolumeInformationResponse {
                                device_io_reply: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::SUCCESS),
                                #[cfg_attr(target_vendor = "apple", expect(clippy::unnecessary_fallible_conversions))]
                                buffer: Some(FileSystemInformationClass::FileFsSizeInformation(
                                    FileFsSizeInformation {
                                        total_alloc_units: i64::try_from(statvfs.blocks()).unwrap(),
                                        available_alloc_units: i64::try_from(statvfs.blocks_free()).unwrap(),
                                        sectors_per_alloc_unit: u32::try_from(statvfs.fragment_size()).unwrap(),
                                        bytes_per_sector: 1,
                                    },
                                )),
                            },
                        ),
                    )])
                } else {
                    warn!("unsupported volume class");
                    Ok(vec![SvcMessage::from(
                        RdpdrPdu::ClientDriveQueryVolumeInformationResponse(
                            ClientDriveQueryVolumeInformationResponse {
                                device_io_reply: DeviceIoResponse::new(
                                    req_inner.device_io_request,
                                    NtStatus::UNSUCCESSFUL,
                                ),
                                buffer: None,
                            },
                        ),
                    )])
                }
            } else {
                warn!("no such file");
                let res = RdpdrPdu::ClientDriveQueryInformationResponse(ClientDriveQueryInformationResponse {
                    device_io_response: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::NO_SUCH_FILE),
                    buffer: None,
                });
                Ok(vec![SvcMessage::from(res)])
            }
        }
        None => {
            warn!("no such file");
            let res = RdpdrPdu::ClientDriveQueryInformationResponse(ClientDriveQueryInformationResponse {
                device_io_response: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::NO_SUCH_FILE),
                buffer: None,
            });
            Ok(vec![SvcMessage::from(res)])
        }
    }
}


fn make_set_information_resp(
    request: &ServerDriveSetInformationRequest,
    status: NtStatus,
) -> PduResult<Vec<SvcMessage>> {
    let response = ClientDriveSetInformationResponse::new(request, status)
        .map_err(|error| encode_err!(error))?;
    Ok(vec![SvcMessage::from(
        RdpdrPdu::ClientDriveSetInformationResponse(response),
    )])
}
pub(crate) fn set_information(
    backend: &mut NixRdpdrBackend,
    req_inner: ServerDriveSetInformationRequest,
) -> PduResult<Vec<SvcMessage>> {
    let Some(context) = backend
        .file_context_for(&req_inner.device_io_request)
        .cloned()
    else {
        return make_set_information_resp(&req_inner, NtStatus::NO_SUCH_FILE);
    };
    if context.root.read_only {
        return make_set_information_resp(&req_inner, NtStatus::ACCESS_DENIED);
    }

    match &req_inner.set_buffer {
        FileInformationClass::Rename(info) => {
            // Resolve the target against the handle owner's root, never the
            // device ID claimed by this follow-up request.
            let Some(to) = contained_path(&context.root.path, &info.file_name) else {
                warn!("rename target escapes the shared folder; refusing");
                return make_set_information_resp(&req_inner, NtStatus::ACCESS_DENIED);
            };
            if let Err(error) = std::fs::rename(&context.path, &to) {
                warn!(?error, "Rename file error");
                return make_set_information_resp(&req_inner, NtStatus::UNSUCCESSFUL);
            }
            if let Some(current) = backend
                .file_context_map
                .get_mut(&req_inner.device_io_request.file_id)
            {
                current.path = to;
            }
        }
        FileInformationClass::Allocation(_) => {
            // Nothing to do.
        }
        FileInformationClass::Disposition(_) => {
            if let Err(error) = std::fs::remove_file(&context.path) {
                warn!(?error, "Remove file error");
                return make_set_information_resp(&req_inner, NtStatus::UNSUCCESSFUL);
            }
        }
        FileInformationClass::EndOfFile(info) => {
            if let Some(file) = backend.file_map.get(&req_inner.device_io_request.file_id) {
                // SAFETY: the handle was opened with write access for this operation and is a regular file.
                let set_end_res = unsafe { nix::libc::ftruncate(file.as_raw_fd(), info.end_of_file) };
                if set_end_res < 0 {
                    let error = nix::errno::Errno::last();
                    warn!(%error, "Failed to set end of file");
                    return make_set_information_resp(&req_inner, NtStatus::UNSUCCESSFUL);
                }
            } else {
                return make_set_information_resp(&req_inner, NtStatus::NO_SUCH_FILE);
            }
        }
        _ => {
            // TODO
        }
    }

    make_set_information_resp(&req_inner, NtStatus::SUCCESS)
}

// in fact, it is time in secs which is very small
#[expect(clippy::arithmetic_side_effects)]
pub(crate) fn transform_to_filetime(time_in_secs: i64) -> i64 {
    let mut time = time_in_secs * 10000000;
    time += 116444736000000000;
    time
}

pub(crate) fn get_file_attributes(meta: &std::fs::Metadata, file_name: &str) -> FileAttributes {
    let mut file_attribute = FileAttributes::empty();
    if meta.is_dir() {
        file_attribute |= FileAttributes::FILE_ATTRIBUTE_DIRECTORY;
    }
    if file_attribute.is_empty() {
        file_attribute |= FileAttributes::FILE_ATTRIBUTE_ARCHIVE;
    }

    if file_name.len() > 1 && file_name.starts_with('.') && file_name.as_bytes()[1] != b'.' {
        file_attribute |= FileAttributes::FILE_ATTRIBUTE_HIDDEN;
    }
    if meta.permissions().readonly() {
        file_attribute |= FileAttributes::FILE_ATTRIBUTE_READONLY;
    }
    file_attribute
}

pub(crate) fn make_query_dir_resp(
    find_file_name: Option<String>,
    device_io_request: DeviceIoRequest,
    file_class: FileInformationClassLevel,
    initial_query: bool,
) -> PduResult<Vec<SvcMessage>> {
    let not_found_status = if initial_query {
        NtStatus::NO_SUCH_FILE
    } else {
        NtStatus::NO_MORE_FILES
    };
    match find_file_name {
        None => Ok(vec![SvcMessage::from(RdpdrPdu::ClientDriveQueryDirectoryResponse(
            ClientDriveQueryDirectoryResponse {
                device_io_reply: DeviceIoResponse::new(device_io_request, not_found_status),
                buffer: None,
            },
        ))]),
        Some(file_full_path) => {
            // in fact, it represents file name, so it is not very large
            #[expect(clippy::arithmetic_side_effects)]
            let file_last_slash = if let Some(index) = file_full_path.rfind('/') {
                index + 1
            } else {
                0
            };
            let file_name = &file_full_path[file_last_slash..];
            match std::fs::metadata(&file_full_path) {
                Ok(meta) => {
                    let file_attribute = get_file_attributes(&meta, file_name);
                    if file_class == FileInformationClassLevel::FILE_BOTH_DIRECTORY_INFORMATION {
                        let info = FileBothDirectoryInformation::new(
                            transform_to_filetime(meta.ctime()),
                            transform_to_filetime(meta.ctime()),
                            transform_to_filetime(meta.atime()),
                            transform_to_filetime(meta.mtime()),
                            i64::try_from(meta.size()).unwrap(),
                            file_attribute,
                            file_name.to_owned(),
                        );
                        let info2 = FileInformationClass::BothDirectory(info);
                        Ok(vec![SvcMessage::from(RdpdrPdu::ClientDriveQueryDirectoryResponse(
                            ClientDriveQueryDirectoryResponse {
                                device_io_reply: DeviceIoResponse::new(device_io_request, NtStatus::SUCCESS),
                                buffer: Some(info2),
                            },
                        ))])
                    } else {
                        warn!("unsupported file class for query directory");
                        Ok(vec![SvcMessage::from(RdpdrPdu::ClientDriveQueryDirectoryResponse(
                            ClientDriveQueryDirectoryResponse {
                                device_io_reply: DeviceIoResponse::new(device_io_request, NtStatus::NOT_SUPPORTED),
                                buffer: None,
                            },
                        ))])
                    }
                }
                Err(error) => {
                    warn!(%error, "Get metadata error");
                    Ok(vec![SvcMessage::from(RdpdrPdu::ClientDriveQueryDirectoryResponse(
                        ClientDriveQueryDirectoryResponse {
                            device_io_reply: DeviceIoResponse::new(device_io_request, not_found_status),
                            buffer: None,
                        },
                    ))])
                }
            }
        }
    }
}

fn next_contained_directory_entry(
    base: &str,
    parent: &str,
    iter: &mut OwningIter,
) -> Option<String> {
    let canonical_base = std::fs::canonicalize(base).ok()?;
    while let Some(entry) = iter.next() {
        let Ok(entry) = entry else { continue };
        let file_name = entry.file_name();
        if file_name.to_bytes() == b"." || file_name.to_bytes() == b".." {
            continue;
        }
        let Ok(file_name) = file_name.to_str() else {
            continue;
        };
        let candidate = std::path::Path::new(parent).join(file_name);
        if resolve_contained_candidate(&canonical_base, &candidate).is_some() {
            if let Some(candidate) = candidate.to_str() {
                return Some(candidate.to_owned());
            }
        }
    }
    None
}

pub(crate) fn query_directory(
    backend: &mut NixRdpdrBackend,
    req_inner: ServerDriveQueryDirectoryRequest,
) -> PduResult<Vec<SvcMessage>> {
    let Some(context) = backend
        .file_context_for(&req_inner.device_io_request)
        .cloned()
    else {
        warn!("directory query for an unknown or mismatched handle; refusing");
        return make_query_dir_resp(
            None,
            req_inner.device_io_request,
            req_inner.file_info_class_lvl,
            req_inner.initial_query > 0,
        );
    };
    let base = context.root.path;
    let parent_for_next = context.path;

    let mut find_file_name = None;
    if req_inner.initial_query > 0 {
        if req_inner.path.ends_with('*') {
            let query_parent = req_inner.path.trim_end_matches('*');
            let Some(parent) = contained_path(&base, query_parent) else {
                warn!("directory query escapes the shared folder; refusing");
                return make_query_dir_resp(
                    None,
                    req_inner.device_io_request,
                    req_inner.file_info_class_lvl,
                    true,
                );
            };
            if let Ok(dir) = Dir::open(
                parent.as_str(),
                nix::fcntl::OFlag::O_RDONLY,
                nix::sys::stat::Mode::empty(),
            ) {
                let mut iter = dir.into_iter();
                find_file_name = next_contained_directory_entry(&base, &parent, &mut iter);
                backend
                    .file_dir_map
                    .insert(req_inner.device_io_request.file_id, iter);
            }
        } else {
            find_file_name = contained_path(&base, &req_inner.path);
            if find_file_name.is_none() {
                warn!("query path escapes the shared folder; refusing");
            }
        }
    } else if let Some(iter) = backend
        .file_dir_map
        .get_mut(&req_inner.device_io_request.file_id)
    {
        find_file_name = next_contained_directory_entry(&base, &parent_for_next, iter);
    }

    make_query_dir_resp(
        find_file_name,
        req_inner.device_io_request,
        req_inner.file_info_class_lvl,
        req_inner.initial_query > 0,
    )
}

fn make_create_drive_resp(
    device_io_request: DeviceIoRequest,
    create_disposation: CreateDisposition,
    file_id: u32,
) -> PduResult<Vec<SvcMessage>> {
    let io_response = DeviceIoResponse::new(device_io_request, NtStatus::SUCCESS);
    let information = if create_disposation == CreateDisposition::FILE_OPEN_IF {
        Information::FILE_OPENED
    } else if create_disposation == CreateDisposition::FILE_OVERWRITE_IF {
        Information::FILE_OVERWRITTEN
    } else {
        Information::FILE_SUPERSEDED
    };
    let res = RdpdrPdu::DeviceCreateResponse(DeviceCreateResponse {
        device_io_reply: io_response,
        file_id,
        information,
    });
    Ok(vec![SvcMessage::from(res)])
}
fn make_create_error_resp(
    device_io_request: DeviceIoRequest,
    file_id: u32,
    status: NtStatus,
) -> PduResult<Vec<SvcMessage>> {
    Ok(vec![SvcMessage::from(RdpdrPdu::DeviceCreateResponse(
        DeviceCreateResponse {
            device_io_reply: DeviceIoResponse::new(device_io_request, status),
            file_id,
            information: Information::empty(),
        },
    ))])
}

// in fact, index only needs to be different, so it is ok
#[expect(clippy::arithmetic_side_effects)]

/// PATCH (Dolgate): resolve an already joined candidate under one canonical share root.
///
/// Existing components are canonicalized, so a symlink to a path outside the share is rejected.
/// A not-yet-existing create/rename target is rebuilt from its nearest existing canonical parent;
/// dangling symlinks are rejected rather than mistaken for missing path components.
fn resolve_contained_candidate(
    canonical_base: &std::path::Path,
    candidate: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let mut probe = candidate;
    let mut missing = Vec::new();
    loop {
        match std::fs::canonicalize(probe) {
            Ok(mut resolved) => {
                if !resolved.starts_with(canonical_base) {
                    return None;
                }
                for component in missing.iter().rev() {
                    resolved.push(component);
                }
                return resolved.starts_with(canonical_base).then_some(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // canonicalize also reports NotFound for dangling symlinks. Following one during a
                // later create could leave the share, so distinguish it from a genuinely absent path.
                if std::fs::symlink_metadata(probe).is_ok() {
                    return None;
                }
                missing.push(probe.file_name()?.to_os_string());
                probe = probe.parent()?;
            }
            Err(_) => return None,
        }
    }
}

/// Convert a remote Windows-style path into a canonical path confined to `file_base`.
fn contained_path(file_base: &str, remote_path: &str) -> Option<String> {
    use std::path::{Component, PathBuf};

    let canonical_base = std::fs::canonicalize(file_base).ok()?;
    if !canonical_base.is_dir() {
        return None;
    }
    let mut joined = canonical_base.clone();
    let relative = remote_path.replace('\\', "/");

    for component in PathBuf::from(&relative).components() {
        match component {
            Component::Normal(part) => joined.push(part),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) => return None,
        }
    }

    resolve_contained_candidate(&canonical_base, &joined)?
        .to_str()
        .map(str::to_owned)
}

pub(crate) fn create_drive(
    backend: &mut NixRdpdrBackend,
    req_inner: DeviceCreateRequest,
) -> PduResult<Vec<SvcMessage>> {
    let file_id = backend.file_id;
    backend.file_id += 1;
    let Some(path) = backend
        .base_of(req_inner.device_io_request.device_id)
        .and_then(|base| contained_path(base, &req_inner.path))
    else {
        // 공유 폴더 밖을 가리키는 요청. 존재하지 않는 것처럼 응답한다.
        return Ok(vec![SvcMessage::from(RdpdrPdu::DeviceCreateResponse(
            DeviceCreateResponse {
                device_io_reply: DeviceIoResponse::new(
                    req_inner.device_io_request,
                    NtStatus::NO_SUCH_FILE,
                ),
                file_id: 0,
                information: Information::FILE_SUPERSEDED,
            },
        ))]);
    };
    if backend.is_read_only(req_inner.device_io_request.device_id) {
        let opens_existing = matches!(
            req_inner.create_disposition,
            CreateDisposition::FILE_OPEN | CreateDisposition::FILE_OPEN_IF
        ) && std::fs::metadata(&path).is_ok();
        if !opens_existing {
            return make_create_error_resp(
                req_inner.device_io_request,
                file_id,
                NtStatus::ACCESS_DENIED,
            );
        }
    }
    // first process directory
    match std::fs::metadata(&path) {
        Ok(meta) => {
            if meta.is_dir() {
                if req_inner.create_disposition == CreateDisposition::FILE_CREATE {
                    warn!("Attempt to create directory, but it exists");
                    let io_response = DeviceIoResponse::new(req_inner.device_io_request, NtStatus::UNSUCCESSFUL);
                    let res = RdpdrPdu::DeviceCreateResponse(DeviceCreateResponse {
                        device_io_reply: io_response,
                        file_id,
                        information: Information::empty(),
                    });
                    return Ok(vec![SvcMessage::from(res)]);
                }
                if req_inner.create_options.bits() & CreateOptions::FILE_NON_DIRECTORY_FILE.bits() != 0 {
                    warn!("Attempt to create a file, but it is a directory");
                    let io_response = DeviceIoResponse::new(req_inner.device_io_request, NtStatus::UNSUCCESSFUL);
                    let res = RdpdrPdu::DeviceCreateResponse(DeviceCreateResponse {
                        device_io_reply: io_response,
                        file_id,
                        information: Information::empty(),
                    });
                    return Ok(vec![SvcMessage::from(res)]);
                }
                // Return afterwards
                // This can be unified with the condition for opening the file.
            } else if req_inner.create_options.bits() & CreateOptions::FILE_DIRECTORY_FILE.bits() != 0 {
                warn!("Attempt to create a directory, but it is a file");
                let io_response = DeviceIoResponse::new(req_inner.device_io_request, NtStatus::NOT_A_DIRECTORY);
                let res = RdpdrPdu::DeviceCreateResponse(DeviceCreateResponse {
                    device_io_reply: io_response,
                    file_id,
                    information: Information::empty(),
                });
                return Ok(vec![SvcMessage::from(res)]);
            }
        }
        Err(_) => {
            if req_inner.create_options.bits() & CreateOptions::FILE_DIRECTORY_FILE.bits() != 0 {
                if (req_inner.create_disposition == CreateDisposition::FILE_CREATE
                    || req_inner.create_disposition == CreateDisposition::FILE_OPEN_IF)
                    && std::fs::create_dir_all(path.as_str()).is_ok()
                {
                    let mut fs = std::fs::OpenOptions::new();
                    match fs.read(true).open(&path) {
                        Ok(file) => {
                            debug!("create drive file_id:{},path:{}", file_id, path);
                            backend.register_file(
                                file_id,
                                req_inner.device_io_request.device_id,
                                path.clone(),
                                file,
                            );
                            return make_create_drive_resp(
                                req_inner.device_io_request,
                                req_inner.create_disposition,
                                file_id,
                            );
                        }
                        Err(error) => {
                            warn!(%error, "Open file dir error");
                            //return by downside
                        }
                    }
                }
                //create disposition is not correct
                let io_response = DeviceIoResponse::new(req_inner.device_io_request, NtStatus::UNSUCCESSFUL);
                let res = RdpdrPdu::DeviceCreateResponse(DeviceCreateResponse {
                    device_io_reply: io_response,
                    file_id,
                    information: Information::empty(),
                });
                return Ok(vec![SvcMessage::from(res)]);
            }
        }
    }

    let mut fs = std::fs::OpenOptions::new();
    if backend.is_read_only(req_inner.device_io_request.device_id) {
        fs.read(true);
    } else {
        if CreateDisposition::FILE_OPEN_IF == req_inner.create_disposition {
            fs.create(true).write(true).read(true);
        }
        if CreateDisposition::FILE_CREATE == req_inner.create_disposition {
            fs.create_new(true).write(true).read(true);
        }
        if CreateDisposition::FILE_SUPERSEDE == req_inner.create_disposition {
            fs.create(true).write(true).append(true).read(true);
        }
        if CreateDisposition::FILE_OPEN == req_inner.create_disposition {
            fs.read(true);
        }
        if CreateDisposition::FILE_OVERWRITE == req_inner.create_disposition {
            fs.write(true).truncate(true).read(true);
        }
        if CreateDisposition::FILE_OVERWRITE_IF == req_inner.create_disposition {
            fs.write(true).truncate(true).create(true).read(true);
        }
    }

    match fs.open(&path) {
        Ok(file) => {
            debug!("create drive file_id:{},path:{}", file_id, path);
            backend.register_file(
                file_id,
                req_inner.device_io_request.device_id,
                path.clone(),
                file,
            );
            make_create_drive_resp(req_inner.device_io_request, req_inner.create_disposition, file_id)
        }
        Err(error) => {
            warn!(?error, "Open file error for path:{}", path);
            let io_response = DeviceIoResponse::new(req_inner.device_io_request, NtStatus::UNSUCCESSFUL);
            let res = RdpdrPdu::DeviceCreateResponse(DeviceCreateResponse {
                device_io_reply: io_response,
                file_id,
                information: Information::empty(),
            });
            Ok(vec![SvcMessage::from(res)])
        }
    }
}

pub(crate) fn process_dependent_file(
    backend: &mut NixRdpdrBackend,
    request: DeviceIoRequest,
    error_fx: impl Fn(DeviceIoRequest) -> PduResult<Vec<SvcMessage>>,
    fx: impl Fn(&mut std::fs::File, DeviceIoRequest) -> PduResult<Vec<SvcMessage>>,
) -> PduResult<Vec<SvcMessage>> {
    if backend.file_context_for(&request).is_none() {
        return error_fx(request);
    }
    match backend.file_map.get_mut(&request.file_id) {
        None => error_fx(request),
        Some(file) => fx(file, request),
    }
}

/// PATCH (Dolgate): 장치별 루트 해석.
///
/// 여기서 어긋나면 한 공유 폴더의 요청이 다른 폴더로 해석되어, 사용자가 공유하지 않은 파일이
/// 원격에 노출된다. 상류에는 루트가 하나뿐이라 이 개념 자체가 없었다.
#[cfg(test)]
mod root_tests {
    use super::{
        DriveRoot, MAX_DEVICE_READ_BYTES, NixRdpdrBackend, checked_device_read_length,
    };

    fn backend() -> NixRdpdrBackend {
        let mut roots = std::collections::HashMap::new();
        roots.insert(
            1,
            DriveRoot {
                path: "/share/a".to_owned(),
                read_only: false,
            },
        );
        roots.insert(
            2,
            DriveRoot {
                path: "/share/b".to_owned(),
                read_only: true,
            },
        );
        NixRdpdrBackend::new(roots)
    }

    #[test]
    fn resolves_each_device_to_its_own_root() {
        let backend = backend();
        assert_eq!(backend.base_of(1), Some("/share/a"));
        assert_eq!(backend.base_of(2), Some("/share/b"));
    }

    #[test]
    fn refuses_an_unknown_device() {
        // 임의의 루트로 대신 처리하면 공유하지 않은 폴더가 새어 나간다.
        assert_eq!(backend().base_of(99), None);
    }

    #[test]
    fn applies_read_only_per_device() {
        let backend = backend();
        assert!(!backend.is_read_only(1));
        assert!(backend.is_read_only(2));
    }

    #[test]
    fn treats_an_unknown_device_as_read_only() {
        // 쓰기를 막는 쪽이 안전하다. 어차피 경로 해석도 실패한다.
        assert!(backend().is_read_only(99));
    }

    #[test]
    fn binds_an_open_handle_to_its_original_device_policy() {
        let mut backend = backend();
        backend.register_file(
            42,
            2,
            "/share/b/file.txt".to_owned(),
            std::fs::File::open("/dev/null").unwrap(),
        );

        let owner = backend.file_context_for_ids(2, 42).unwrap();
        assert!(owner.root.read_only);
        assert_eq!(owner.path, "/share/b/file.txt");
        assert!(backend.file_context_for_ids(1, 42).is_none());
    }

    #[test]
    fn caps_each_server_controlled_read_before_allocation() {
        assert_eq!(
            checked_device_read_length(MAX_DEVICE_READ_BYTES),
            Some(MAX_DEVICE_READ_BYTES as usize)
        );
        assert_eq!(checked_device_read_length(MAX_DEVICE_READ_BYTES + 1), None);
        assert_eq!(checked_device_read_length(u32::MAX), None);
    }
}

#[cfg(test)]
mod containment_tests {
    use super::{contained_path, next_contained_directory_entry};
    use nix::dir::Dir;
    use nix::fcntl::OFlag;
    use nix::sys::stat::Mode;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TREE: AtomicU64 = AtomicU64::new(1);

    struct TestTree {
        parent: PathBuf,
        share: PathBuf,
        outside: PathBuf,
    }

    impl TestTree {
        fn new() -> Self {
            let id = NEXT_TREE.fetch_add(1, Ordering::Relaxed);
            let parent = std::env::temp_dir().join(format!(
                "dolgate-rdpdr-{}-{id}",
                std::process::id()
            ));
            let share = parent.join("share");
            let outside = parent.join("outside");
            std::fs::create_dir_all(&share).unwrap();
            std::fs::create_dir_all(&outside).unwrap();
            Self {
                parent,
                share,
                outside,
            }
        }

        fn share_str(&self) -> &str {
            self.share.to_str().unwrap()
        }

        fn canonical_share(&self) -> PathBuf {
            std::fs::canonicalize(&self.share).unwrap()
        }
    }

    impl Drop for TestTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.parent);
        }
    }

    #[test]
    fn joins_a_normal_path_under_the_share() {
        let tree = TestTree::new();
        assert_eq!(
            contained_path(tree.share_str(), "\\docs\\a.txt"),
            Some(
                tree.canonical_share()
                    .join("docs/a.txt")
                    .to_str()
                    .unwrap()
                    .to_owned()
            )
        );
    }

    #[test]
    fn refuses_a_parent_traversal() {
        let tree = TestTree::new();
        assert_eq!(contained_path(tree.share_str(), "\\..\\..\\etc\\passwd"), None);
        assert_eq!(contained_path(tree.share_str(), "..\\secret"), None);
        assert_eq!(contained_path(tree.share_str(), "\\docs\\..\\..\\secret"), None);
    }

    #[test]
    fn ignores_harmless_leading_separators_and_dots() {
        let tree = TestTree::new();
        let canonical = tree.canonical_share();
        assert_eq!(
            contained_path(tree.share_str(), "\\").as_deref(),
            canonical.to_str()
        );
        assert_eq!(
            contained_path(tree.share_str(), "\\.\\a.txt"),
            Some(canonical.join("a.txt").to_str().unwrap().to_owned())
        );
    }

    #[test]
    fn refuses_existing_and_dangling_symlinks_that_leave_the_share() {
        use std::os::unix::fs::symlink;

        let tree = TestTree::new();
        let outside_file = tree.outside.join("secret.txt");
        std::fs::write(&outside_file, b"secret").unwrap();
        symlink(&outside_file, tree.share.join("escape")).unwrap();
        symlink(tree.outside.join("missing"), tree.share.join("dangling")).unwrap();

        assert_eq!(contained_path(tree.share_str(), "escape"), None);
        assert_eq!(contained_path(tree.share_str(), "dangling"), None);
    }

    #[test]
    fn allows_a_symlink_only_when_its_resolved_target_stays_inside() {
        use std::os::unix::fs::symlink;

        let tree = TestTree::new();
        let actual = tree.share.join("actual");
        std::fs::create_dir(&actual).unwrap();
        std::fs::write(actual.join("ok.txt"), b"ok").unwrap();
        symlink(&actual, tree.share.join("inside")).unwrap();

        assert_eq!(
            contained_path(tree.share_str(), "inside\\ok.txt"),
            Some(
                std::fs::canonicalize(actual.join("ok.txt"))
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_owned()
            )
        );
    }

    #[test]
    fn directory_enumeration_skips_symlinks_that_leave_the_share() {
        use std::os::unix::fs::symlink;

        let tree = TestTree::new();
        let safe_file = tree.share.join("safe.txt");
        std::fs::write(&safe_file, b"safe").unwrap();
        std::fs::write(tree.outside.join("secret.txt"), b"secret").unwrap();
        symlink(&safe_file, tree.share.join("inside-link")).unwrap();
        symlink(
            tree.outside.join("secret.txt"),
            tree.share.join("outside-link"),
        )
        .unwrap();
        symlink(
            tree.outside.join("missing.txt"),
            tree.share.join("dangling-link"),
        )
        .unwrap();

        let parent = tree.canonical_share();
        let mut iter = Dir::open(parent.as_path(), OFlag::O_RDONLY, Mode::empty())
            .unwrap()
            .into_iter();
        let mut names = Vec::new();
        while let Some(path) = next_contained_directory_entry(
            tree.share_str(),
            parent.to_str().unwrap(),
            &mut iter,
        ) {
            names.push(
                Path::new(&path)
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_owned(),
            );
        }
        names.sort();

        assert_eq!(
            names,
            vec!["inside-link".to_owned(), "safe.txt".to_owned()]
        );
    }

    #[test]
    fn keeps_a_windows_style_absolute_path_inside_the_share() {
        let tree = TestTree::new();
        assert_eq!(
            contained_path(tree.share_str(), "C:\\Windows"),
            Some(
                tree.canonical_share()
                    .join("C:/Windows")
                    .to_str()
                    .unwrap()
                    .to_owned()
            )
        );
    }

    #[test]
    fn never_escapes_the_share_for_any_input() {
        let tree = TestTree::new();
        let canonical = tree.canonical_share();
        for probe in [
            "\\..\\..\\..\\etc\\passwd",
            "....\\\\..\\secret",
            "\\docs\\..\\..\\..\\..\\root",
            "/../../etc/shadow",
        ] {
            if let Some(joined) = contained_path(tree.share_str(), probe) {
                assert!(
                    Path::new(&joined).starts_with(&canonical),
                    "{probe:?} escaped to {joined}"
                );
            }
        }
    }
}
