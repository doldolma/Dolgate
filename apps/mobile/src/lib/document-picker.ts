import {
  errorCodes,
  isErrorWithCode,
  keepLocalCopy,
  pick,
  types,
} from '@react-native-documents/picker';

export const documentPickerTypes = types;

export interface LocalPickedDocument {
  uri: string;
  name: string;
  size: number | null;
}

interface PickLocalDocumentOptions {
  type: string[];
  fallbackName: string;
}

export async function pickLocalDocument({
  type,
  fallbackName,
}: PickLocalDocumentOptions): Promise<LocalPickedDocument | null> {
  try {
    const [pickedFile] = await pick({ type });
    if (pickedFile.error) {
      throw new Error(pickedFile.error);
    }

    const fileName = pickedFile.name ?? fallbackName;
    const [copyResult] = await keepLocalCopy({
      destination: 'cachesDirectory',
      files: [{ uri: pickedFile.uri, fileName }],
    });
    if (copyResult.status === 'error') {
      throw new Error(copyResult.copyError);
    }

    return {
      uri: copyResult.localUri,
      name: fileName,
      size: pickedFile.size,
    };
  } catch (error) {
    if (
      isErrorWithCode(error) &&
      error.code === errorCodes.OPERATION_CANCELED
    ) {
      return null;
    }
    throw error;
  }
}
