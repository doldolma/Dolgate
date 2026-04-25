import { NativeModules } from 'react-native';

export interface PickedUploadFile {
  uri: string;
  name: string;
  size?: number | null;
}

export interface DownloadDestination {
  uri: string;
  name: string;
  requiresExport?: boolean;
}

export interface DownloadDirectory {
  uri: string;
  name: string;
  requiresExport?: boolean;
}

interface NativeFileTransferModule {
  pickDownloadDestination(fileName: string): Promise<DownloadDestination>;
  pickDownloadDirectory(directoryName: string): Promise<DownloadDirectory>;
  createDownloadDirectory(
    parentUri: string,
    directoryName: string,
  ): Promise<DownloadDirectory>;
  createDownloadFile(
    parentUri: string,
    fileName: string,
  ): Promise<DownloadDestination>;
  writeDownloadChunk(
    destinationUri: string,
    base64Chunk: string,
    append: boolean,
  ): Promise<void>;
  finalizeDownloadDestination(
    destinationUri: string,
    name: string,
  ): Promise<DownloadDestination>;
  deleteDocument(destinationUri: string): Promise<void>;
  readLocalFileChunk(
    sourceUri: string,
    offset: number,
    length: number,
  ): Promise<{
    base64: string;
    bytesRead: number;
  }>;
}

const nativeFileTransfer = NativeModules.DolsshFileTransferModule as
  | NativeFileTransferModule
  | undefined;

type DocumentPickerModule =
  typeof import('react-native-document-picker').default;

function getDocumentPicker(): DocumentPickerModule {
  return require('react-native-document-picker')
    .default as DocumentPickerModule;
}

function getNativeFileTransfer(): NativeFileTransferModule {
  if (!nativeFileTransfer) {
    throw new Error('파일 전송 네이티브 모듈을 찾지 못했습니다.');
  }
  return nativeFileTransfer;
}

export async function pickUploadFile(): Promise<PickedUploadFile | null> {
  const DocumentPicker = getDocumentPicker();
  try {
    const result = await DocumentPicker.pickSingle({
      type: [DocumentPicker.types.allFiles],
      copyTo: 'cachesDirectory',
    });
    return {
      uri: result.fileCopyUri ?? result.uri,
      name: result.name ?? 'upload',
      size: result.size,
    };
  } catch (error) {
    if (DocumentPicker.isCancel(error)) {
      return null;
    }
    throw error;
  }
}

export async function pickDownloadDestination(
  fileName: string,
): Promise<DownloadDestination | null> {
  try {
    return await getNativeFileTransfer().pickDownloadDestination(fileName);
  } catch (error) {
    if (isNativeCancelError(error)) {
      return null;
    }
    throw error;
  }
}

export async function pickDownloadDirectory(
  directoryName: string,
): Promise<DownloadDirectory | null> {
  try {
    return await getNativeFileTransfer().pickDownloadDirectory(directoryName);
  } catch (error) {
    if (isNativeCancelError(error)) {
      return null;
    }
    throw error;
  }
}

export async function createDownloadDirectory(
  parentUri: string,
  directoryName: string,
): Promise<DownloadDirectory> {
  return getNativeFileTransfer().createDownloadDirectory(
    parentUri,
    directoryName,
  );
}

export async function createDownloadFile(
  parentUri: string,
  fileName: string,
): Promise<DownloadDestination> {
  return getNativeFileTransfer().createDownloadFile(parentUri, fileName);
}

export async function writeDownloadChunk(
  destinationUri: string,
  base64Chunk: string,
  append: boolean,
): Promise<void> {
  await getNativeFileTransfer().writeDownloadChunk(
    destinationUri,
    base64Chunk,
    append,
  );
}

export async function finalizeDownloadDestination(
  destinationUri: string,
  name: string,
): Promise<DownloadDestination> {
  try {
    return await getNativeFileTransfer().finalizeDownloadDestination(
      destinationUri,
      name,
    );
  } catch (error) {
    if (isNativeCancelError(error)) {
      throw new Error('저장이 취소되었습니다.');
    }
    throw error;
  }
}

export async function deleteDownloadDestination(
  destinationUri: string,
): Promise<void> {
  await getNativeFileTransfer().deleteDocument(destinationUri);
}

export async function readLocalFileChunk(
  sourceUri: string,
  offset: number,
  length: number,
): Promise<{
  base64: string;
  bytesRead: number;
}> {
  return getNativeFileTransfer().readLocalFileChunk(sourceUri, offset, length);
}

function isNativeCancelError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = 'code' in error ? String(error.code) : '';
  const message = 'message' in error ? String(error.message) : '';
  return (
    code === 'DOCUMENT_PICKER_CANCELED' ||
    code === 'download_destination_busy' ||
    code === 'download_directory_busy' ||
    /cancel/i.test(message)
  );
}
