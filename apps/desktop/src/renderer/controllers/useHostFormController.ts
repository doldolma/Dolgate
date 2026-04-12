import { useMemo } from 'react';
import { pickPrivateKey, pickSshCertificate } from '../services/desktop/settings';

export function useHostFormController() {
  return useMemo(
    () => ({
      pickPrivateKey,
      pickSshCertificate,
    }),
    [],
  );
}
