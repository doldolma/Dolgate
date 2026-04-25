use std::io::SeekFrom;
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::ssh_connection::{connect, ConnectOptions, ConnectionDetails, SshConnection};
use crate::utils::{now_ms, SshError};

#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum SftpEntryKind {
    File,
    Directory,
    Symlink,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: f64,
    pub mtime: Option<String>,
    pub kind: SftpEntryKind,
    pub permissions: Option<String>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SftpListing {
    pub path: String,
    pub entries: Vec<SftpEntry>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SftpReadChunk {
    pub bytes: Vec<u8>,
    pub bytes_read: u32,
    pub eof: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SftpConnectionInfo {
    pub connection_id: String,
    pub connection_details: ConnectionDetails,
    pub created_at_ms: f64,
    pub connected_at_ms: f64,
}

#[derive(uniffi::Object)]
pub struct SftpConnection {
    info: SftpConnectionInfo,
    parent: Arc<SshConnection>,
    sftp: SftpSession,
}

#[uniffi::export(async_runtime = "tokio")]
impl SftpConnection {
    pub fn get_info(&self) -> SftpConnectionInfo {
        self.info.clone()
    }

    pub async fn list_directory(&self, path: String) -> Result<SftpListing, SshError> {
        let mut entries = Vec::new();
        let read_dir = self
            .sftp
            .read_dir(path.clone())
            .await
            .map_err(sftp_error)?;

        for entry in read_dir {
            let name = entry.file_name();
            let metadata = entry.metadata();
            let file_type = entry.file_type();
            entries.push(SftpEntry {
                path: join_remote_path(&path, &name),
                name,
                is_directory: file_type.is_dir(),
                size: metadata.len() as f64,
                mtime: metadata.mtime.map(|value| value.to_string()),
                kind: match file_type {
                    FileType::File => SftpEntryKind::File,
                    FileType::Dir => SftpEntryKind::Directory,
                    FileType::Symlink => SftpEntryKind::Symlink,
                    FileType::Other => SftpEntryKind::Unknown,
                },
                permissions: metadata
                    .permissions
                    .map(|value| format!("{:04o}", value & 0o7777)),
            });
        }

        Ok(SftpListing { path, entries })
    }

    pub async fn read_file_chunk(
        &self,
        path: String,
        offset: f64,
        length: u32,
    ) -> Result<SftpReadChunk, SshError> {
        let mut file = self.sftp.open(path).await.map_err(sftp_error)?;
        file.seek(SeekFrom::Start(offset.max(0.0) as u64)).await?;

        let mut buffer = vec![0_u8; length as usize];
        let bytes_read = file.read(&mut buffer).await?;
        buffer.truncate(bytes_read);

        Ok(SftpReadChunk {
            bytes: buffer,
            bytes_read: bytes_read as u32,
            eof: bytes_read < length as usize,
        })
    }

    pub async fn write_file_chunk(
        &self,
        path: String,
        offset: f64,
        data: Vec<u8>,
    ) -> Result<(), SshError> {
        let flags = if offset <= 0.0 {
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE | OpenFlags::READ
        } else {
            OpenFlags::WRITE | OpenFlags::READ
        };
        let mut file = self
            .sftp
            .open_with_flags(path, flags)
            .await
            .map_err(sftp_error)?;
        file.seek(SeekFrom::Start(offset.max(0.0) as u64)).await?;
        file.write_all(&data).await?;
        file.flush().await?;
        Ok(())
    }

    pub async fn mkdir(&self, path: String) -> Result<(), SshError> {
        self.sftp.create_dir(path).await.map_err(sftp_error)
    }

    pub async fn rename(&self, source_path: String, target_path: String) -> Result<(), SshError> {
        self.sftp
            .rename(source_path, target_path)
            .await
            .map(|_| ())
            .map_err(sftp_error)
    }

    pub async fn chmod(&self, path: String, permissions: u32) -> Result<(), SshError> {
        let attrs = FileAttributes {
            permissions: Some(permissions),
            ..FileAttributes::empty()
        };
        self.sftp.set_metadata(path, attrs).await.map_err(sftp_error)
    }

    pub async fn delete(&self, path: String) -> Result<(), SshError> {
        match self.sftp.remove_file(path.clone()).await {
            Ok(()) => Ok(()),
            Err(_) => self.sftp.remove_dir(path).await.map_err(sftp_error),
        }
    }

    pub async fn close(&self) -> Result<(), SshError> {
        self.sftp.close().await.map_err(sftp_error)?;
        self.parent.disconnect().await
    }
}

impl SshConnection {
    pub async fn start_sftp(self: &Arc<Self>) -> Result<Arc<SftpConnection>, SshError> {
        let started_at_ms = now_ms();
        let channel = {
            let client_handle = self.client_handle.lock().await;
            let channel = client_handle.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            channel
        };
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(sftp_error)?;

        Ok(Arc::new(SftpConnection {
            info: SftpConnectionInfo {
                connection_id: self.info.connection_id.clone(),
                connection_details: self.info.connection_details.clone(),
                created_at_ms: started_at_ms,
                connected_at_ms: now_ms(),
            },
            parent: self.clone(),
            sftp,
        }))
    }
}

#[uniffi::export(async_runtime = "tokio")]
pub async fn connect_sftp(options: ConnectOptions) -> Result<Arc<SftpConnection>, SshError> {
    let connection = connect(options).await?;
    connection.start_sftp().await
}

fn join_remote_path(parent: &str, name: &str) -> String {
    if parent.is_empty() || parent == "." {
        return name.to_string();
    }
    if parent == "/" {
        return format!("/{name}");
    }
    format!("{}/{}", parent.trim_end_matches('/'), name)
}

fn sftp_error<E: std::fmt::Display>(error: E) -> SshError {
    SshError::Russh(format!("sftp error: {error}"))
}
