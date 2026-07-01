import { useMemo } from 'react';
import { listSerialPorts, pickPrivateKey, pickSshCertificate, probeSshAgent } from '../services/desktop/settings';

export function useHostFormController() {
  return useMemo(
    () => ({
      listSerialPorts,
      pickPrivateKey,
      pickSshCertificate,
      probeSshAgent,
    }),
    [],
  );
}
