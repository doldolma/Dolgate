use std::ffi::CString;
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

#[derive(Debug, Default)]
pub struct NixRdpdrBackend {
    file_id: u32,
    file_base: String,
    /// PATCH (Dolgate): 원격이 공유 폴더를 수정하지 못하게 한다.
    ///
    /// 상류에는 읽기 전용 개념이 없어 write/rename/delete 가 무조건 실행된다. 공유는 신뢰
    /// 경계를 넘기는 동작이라, 읽기만 필요한 경우에 쓰기까지 열어둘 이유가 없다.
    read_only: bool,
    file_map: std::collections::HashMap<u32, std::fs::File>,
    file_path_map: std::collections::HashMap<u32, String>,
    file_dir_map: std::collections::HashMap<u32, OwningIter>,
}

impl NixRdpdrBackend {
    pub fn new(file_base: String) -> Self {
        Self {
            file_base,
            ..Default::default()
        }
    }

    /// PATCH (Dolgate): 쓰기를 막은 백엔드.
    pub fn new_read_only(file_base: String) -> Self {
        Self {
            file_base,
            read_only: true,
            ..Default::default()
        }
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
    // PATCH (Dolgate): 읽기 전용 공유에서는 쓰기를 거절한다.
    if backend.read_only {
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
        |file, request| match read_inner(file, req_inner.offset, usize::try_from(req_inner.length).unwrap()) {
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
    backend.file_map.remove(&req_inner.device_io_request.file_id);
    backend.file_path_map.remove(&req_inner.device_io_request.file_id);
    backend.file_dir_map.remove(&req_inner.device_io_request.file_id);
    let res = RdpdrPdu::DeviceCloseResponse(DeviceCloseResponse {
        device_io_response: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::SUCCESS),
    });
    Ok(vec![SvcMessage::from(res)])
}

pub(crate) fn query_information(
    backend: &mut NixRdpdrBackend,
    req_inner: ServerDriveQueryInformationRequest,
) -> PduResult<Vec<SvcMessage>> {
    match backend.file_map.get(&req_inner.device_io_request.file_id) {
        Some(file) => match file.metadata() {
            Ok(meta) => {
                let path = backend
                    .file_path_map
                    .get(&req_inner.device_io_request.file_id)
                    .cloned()
                    .unwrap_or_default();
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
    match backend.file_map.get(&req_inner.device_io_request.file_id) {
        Some(file) => {
            if let Ok(statvfs) = nix::sys::statvfs::fstatvfs(file.as_fd()) {
                if FileSystemInformationClassLevel::FILE_FS_FULL_SIZE_INFORMATION == req_inner.fs_info_class_lvl {
                    #[cfg_attr(target_os = "macos", expect(clippy::unnecessary_fallible_conversions))]
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
                                #[cfg_attr(target_os = "macos", expect(clippy::unnecessary_fallible_conversions))]
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

pub(crate) fn set_information(
    backend: &mut NixRdpdrBackend,
    req_inner: ServerDriveSetInformationRequest,
) -> PduResult<Vec<SvcMessage>> {
    match backend.file_path_map.get(&req_inner.device_io_request.file_id) {
        Some(file) => {
            match &req_inner.set_buffer {
                FileInformationClass::Rename(info) => {
                    // PATCH (Dolgate): 이름 변경의 대상도 원격이 정한다. 봉쇄하지 않으면
                    // 공유 폴더 안의 파일을 밖으로 옮길 수 있다.
                    let Some(to) = contained_path(&backend.file_base, &info.file_name) else {
                        warn!("rename target escapes the shared folder; refusing");
                        return Ok(Vec::new());
                    };
                    if let Err(error) = std::fs::rename(file, to) {
                        warn!(?error, "Rename file error");
                        let res = RdpdrPdu::ClientDriveSetInformationResponse(
                            ClientDriveSetInformationResponse::new(&req_inner, NtStatus::UNSUCCESSFUL)
                                .map_err(|e| encode_err!(e))?,
                        );
                        return Ok(vec![SvcMessage::from(res)]);
                    }
                }
                FileInformationClass::Allocation(_) => {
                    //nothing to do
                }
                FileInformationClass::Disposition(_) => {
                    if let Err(error) = std::fs::remove_file(file) {
                        warn!(?error, "Remove file error");
                        let res = RdpdrPdu::ClientDriveSetInformationResponse(
                            ClientDriveSetInformationResponse::new(&req_inner, NtStatus::UNSUCCESSFUL)
                                .map_err(|e| encode_err!(e))?,
                        );
                        return Ok(vec![SvcMessage::from(res)]);
                    }
                }
                FileInformationClass::EndOfFile(info) => {
                    if let Some(file) = backend.file_map.get(&req_inner.device_io_request.file_id) {
                        // SAFETY: the file must has been opened with write access in the last steps, since rdp prepares to set information. In addition it is a regular file.
                        let set_end_res = unsafe { nix::libc::ftruncate(file.as_raw_fd(), info.end_of_file) };
                        if set_end_res < 0 {
                            let error = nix::errno::Errno::last();
                            warn!(%error, "Failed to set end of file");
                            let res = RdpdrPdu::ClientDriveSetInformationResponse(
                                ClientDriveSetInformationResponse::new(&req_inner, NtStatus::UNSUCCESSFUL)
                                    .map_err(|e| encode_err!(e))?,
                            );
                            return Ok(vec![SvcMessage::from(res)]);
                        }
                    } else {
                        warn!("no such file");
                        let res = RdpdrPdu::ClientDriveSetInformationResponse(
                            ClientDriveSetInformationResponse::new(&req_inner, NtStatus::NO_SUCH_FILE)
                                .map_err(|e| encode_err!(e))?,
                        );
                        return Ok(vec![SvcMessage::from(res)]);
                    }
                }
                _ => {
                    // TODO
                }
            }
        }
        None => {
            warn!("no such file");
            let res = RdpdrPdu::ClientDriveSetInformationResponse(
                ClientDriveSetInformationResponse::new(&req_inner, NtStatus::NO_SUCH_FILE)
                    .map_err(|e| encode_err!(e))?,
            );
            return Ok(vec![SvcMessage::from(res)]);
        }
    }
    Ok(vec![SvcMessage::from(RdpdrPdu::ClientDriveSetInformationResponse(
        ClientDriveSetInformationResponse::new(&req_inner, NtStatus::SUCCESS).map_err(|e| encode_err!(e))?,
    ))])
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

pub(crate) fn query_directory(
    backend: &mut NixRdpdrBackend,
    req_inner: ServerDriveQueryDirectoryRequest,
) -> PduResult<Vec<SvcMessage>> {
    match backend.file_path_map.get(&req_inner.device_io_request.file_id) {
        Some(parent_pos_for_next) => {
            let mut find_file_name = None;
            if req_inner.initial_query > 0 {
                if req_inner.path.ends_with('*') {
                    let mut parent = backend.file_base.clone();
                    let query_path = req_inner.path.replace('\\', "/");
                    let len = query_path.len();
                    // path ends with *, so its len > 0
                    #[expect(clippy::arithmetic_side_effects)]
                    parent.push_str(&query_path[0..len - 1]);
                    if let Ok(dirp) = Dir::open(
                        parent.as_str(),
                        nix::fcntl::OFlag::O_RDONLY,
                        nix::sys::stat::Mode::empty(),
                    ) {
                        let mut iter = dirp.into_iter();
                        while let Some(Ok(first)) = iter.next() {
                            let file_name = first.file_name();
                            if CString::new(".").unwrap().as_c_str() == file_name
                                || CString::new("..").unwrap().as_c_str() == file_name
                            {
                                continue;
                            }
                            parent.push_str(file_name.to_string_lossy().into_owned().as_str());
                            find_file_name = Some(parent);
                            break;
                        }
                        backend.file_dir_map.insert(req_inner.device_io_request.file_id, iter);
                    }
                } else {
                    // PATCH (Dolgate): 질의 경로도 봉쇄한다.
                    let Some(full_path) = contained_path(&backend.file_base, &req_inner.path)
                    else {
                        warn!("query path escapes the shared folder; refusing");
                        return Ok(Vec::new());
                    };
                    find_file_name = Some(full_path);
                }
                make_query_dir_resp(
                    find_file_name,
                    req_inner.device_io_request,
                    req_inner.file_info_class_lvl,
                    true,
                )
            } else {
                if let Some(dirp_iter) = backend.file_dir_map.get_mut(&req_inner.device_io_request.file_id) {
                    if let Some(Ok(next)) = dirp_iter.next() {
                        let file_name = next.file_name();
                        let mut full_path = parent_pos_for_next.clone();
                        if !full_path.ends_with('/') {
                            full_path.push('/');
                        }
                        full_path.push_str(file_name.to_string_lossy().into_owned().as_str());
                        find_file_name = Some(full_path);
                    }
                }
                make_query_dir_resp(
                    find_file_name,
                    req_inner.device_io_request,
                    req_inner.file_info_class_lvl,
                    false,
                )
            }
        }
        None => {
            warn!("no file to query directory");
            Ok(vec![SvcMessage::from(RdpdrPdu::ClientDriveQueryDirectoryResponse(
                ClientDriveQueryDirectoryResponse {
                    device_io_reply: DeviceIoResponse::new(req_inner.device_io_request, NtStatus::NO_SUCH_FILE),
                    buffer: None,
                },
            ))])
        }
    }
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
// in fact, index only needs to be different, so it is ok
#[expect(clippy::arithmetic_side_effects)]

/// PATCH (Dolgate): 공유 폴더 밖으로 나가는 경로를 막는다.
///
/// 상류는 `file_base` 에 원격이 준 경로를 그대로 이어붙인다. 그 경로는 원격이 통제하므로
/// `..` 가 섞여 있으면 공유 폴더 밖의 파일이 열린다 — 사용자는 폴더 하나를 공유했다고 믿는데
/// 홈 디렉터리 전체가 노출될 수 있다.
///
/// 이어붙인 뒤 정규화해서 base 안에 남는지 확인하고, 벗어나면 None 을 돌려준다. 심링크까지는
/// 막지 못하므로(정규화는 파일시스템을 보지 않는다) 완전한 봉쇄는 아니지만, 원격이 직접
/// 요청으로 빠져나가는 경로는 닫힌다.
fn contained_path(file_base: &str, remote_path: &str) -> Option<String> {
    use std::path::{Component, PathBuf};

    let mut joined = PathBuf::from(file_base);
    let relative = remote_path.replace('\\', "/");

    for component in PathBuf::from(&relative).components() {
        match component {
            Component::Normal(part) => joined.push(part),
            // 앞의 "/" 나 "." 은 무해하다.
            Component::RootDir | Component::CurDir => {}
            // ".." 는 base 위로 올라가려는 시도다. 어떤 형태로든 허용하지 않는다.
            Component::ParentDir => return None,
            Component::Prefix(_) => return None,
        }
    }

    let base = PathBuf::from(file_base);
    if joined.starts_with(&base) {
        Some(joined.to_string_lossy().into_owned())
    } else {
        None
    }
}

pub(crate) fn create_drive(
    backend: &mut NixRdpdrBackend,
    req_inner: DeviceCreateRequest,
) -> PduResult<Vec<SvcMessage>> {
    let file_id = backend.file_id;
    backend.file_id += 1;
    let Some(path) = contained_path(&backend.file_base, &req_inner.path) else {
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
                            backend.file_map.insert(file_id, file);
                            backend.file_path_map.insert(file_id, path.clone());
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

    match fs.open(&path) {
        Ok(file) => {
            debug!("create drive file_id:{},path:{}", file_id, path);
            backend.file_map.insert(file_id, file);
            backend.file_path_map.insert(file_id, path.clone());
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
    match backend.file_map.get_mut(&request.file_id) {
        None => error_fx(request),
        Some(file) => fx(file, request),
    }
}

#[cfg(test)]
mod containment_tests {
    use super::contained_path;

    #[test]
    fn joins_a_normal_path_under_the_share() {
        assert_eq!(
            contained_path("/share", "\\docs\\a.txt").as_deref(),
            Some("/share/docs/a.txt")
        );
    }

    #[test]
    fn refuses_a_parent_traversal() {
        // 원격이 통제하는 값이다. 막지 않으면 공유 폴더 밖 파일이 열린다.
        assert_eq!(contained_path("/share", "\\..\\..\\etc\\passwd"), None);
        assert_eq!(contained_path("/share", "..\\secret"), None);
        assert_eq!(contained_path("/share", "\\docs\\..\\..\\secret"), None);
    }

    #[test]
    fn ignores_harmless_leading_separators_and_dots() {
        assert_eq!(contained_path("/share", "\\").as_deref(), Some("/share"));
        assert_eq!(
            contained_path("/share", "\\.\\a.txt").as_deref(),
            Some("/share/a.txt")
        );
    }

    #[test]
    fn keeps_a_windows_style_absolute_path_inside_the_share() {
        // Unix 에서 "C:" 는 Prefix 가 아니라 평범한 이름이라 공유 폴더 안의 디렉터리가 된다.
        // 밖으로 나가지 않으므로 봉쇄는 성립한다 — 막을 이유가 없다.
        assert_eq!(
            contained_path("/share", "C:\\Windows").as_deref(),
            Some("/share/C:/Windows")
        );
    }

    #[test]
    fn never_escapes_the_share_for_any_input() {
        for probe in [
            "\\..\\..\\..\\etc\\passwd",
            "....\\\\..\\secret",
            "\\docs\\..\\..\\..\\..\\root",
            "/../../etc/shadow",
        ] {
            if let Some(joined) = contained_path("/share", probe) {
                assert!(
                    joined.starts_with("/share"),
                    "{probe:?} escaped to {joined}"
                );
            }
        }
    }
}
