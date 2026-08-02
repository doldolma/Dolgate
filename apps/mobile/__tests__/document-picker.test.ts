import {
  documentPickerTypes,
  pickLocalDocument,
} from '../src/lib/document-picker';

const mockPick = jest.fn();
const mockKeepLocalCopy = jest.fn();

jest.mock('@react-native-documents/picker', () => ({
  pick: (...args: unknown[]) => mockPick(...args),
  keepLocalCopy: (...args: unknown[]) => mockKeepLocalCopy(...args),
  isErrorWithCode: (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error,
  errorCodes: {
    OPERATION_CANCELED: 'OPERATION_CANCELED',
  },
  types: {
    allFiles: '*/*',
    plainText: 'text/plain',
  },
}));

describe('pickLocalDocument', () => {
  beforeEach(() => {
    mockPick.mockReset();
    mockKeepLocalCopy.mockReset();
  });

  it('copies the selected file into the cache before returning it', async () => {
    mockPick.mockResolvedValue([
      {
        uri: 'content://source/key.pem',
        name: 'key.pem',
        size: 128,
        error: null,
      },
    ]);
    mockKeepLocalCopy.mockResolvedValue([
      {
        status: 'success',
        sourceUri: 'content://source/key.pem',
        localUri: 'file:///cache/key.pem',
      },
    ]);

    await expect(
      pickLocalDocument({
        type: [documentPickerTypes.plainText],
        fallbackName: 'private-key',
      }),
    ).resolves.toEqual({
      uri: 'file:///cache/key.pem',
      name: 'key.pem',
      size: 128,
    });
    expect(mockPick).toHaveBeenCalledWith({ type: ['text/plain'] });
    expect(mockKeepLocalCopy).toHaveBeenCalledWith({
      destination: 'cachesDirectory',
      files: [{ uri: 'content://source/key.pem', fileName: 'key.pem' }],
    });
  });

  it('uses the fallback name when the provider omits file metadata', async () => {
    mockPick.mockResolvedValue([
      {
        uri: 'content://source/unknown',
        name: null,
        size: null,
        error: null,
      },
    ]);
    mockKeepLocalCopy.mockResolvedValue([
      {
        status: 'success',
        sourceUri: 'content://source/unknown',
        localUri: 'file:///cache/upload',
      },
    ]);

    await expect(
      pickLocalDocument({
        type: [documentPickerTypes.allFiles],
        fallbackName: 'upload',
      }),
    ).resolves.toEqual({
      uri: 'file:///cache/upload',
      name: 'upload',
      size: null,
    });
  });

  it('returns null when the user cancels the picker', async () => {
    mockPick.mockRejectedValue({ code: 'OPERATION_CANCELED' });

    await expect(
      pickLocalDocument({
        type: [documentPickerTypes.allFiles],
        fallbackName: 'upload',
      }),
    ).resolves.toBeNull();
    expect(mockKeepLocalCopy).not.toHaveBeenCalled();
  });

  it('reports a local copy failure', async () => {
    mockPick.mockResolvedValue([
      {
        uri: 'content://source/key.pem',
        name: 'key.pem',
        size: 128,
        error: null,
      },
    ]);
    mockKeepLocalCopy.mockResolvedValue([
      {
        status: 'error',
        sourceUri: 'content://source/key.pem',
        copyError: 'copy failed',
      },
    ]);

    await expect(
      pickLocalDocument({
        type: [documentPickerTypes.plainText],
        fallbackName: 'private-key',
      }),
    ).rejects.toThrow('copy failed');
  });
});
