import { useMemo } from 'react';
import { listSerialPorts, pickPrivateKey, pickSshCertificate } from '../services/desktop/settings';

export function useHostFormController() {
  return useMemo(
    () => ({
      listSerialPorts,
      pickPrivateKey,
      pickSshCertificate,
    }),
    [],
  );
}
