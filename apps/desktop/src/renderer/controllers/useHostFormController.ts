import { useMemo } from 'react';
import { pickPrivateKey } from '../services/desktop/settings';

export function useHostFormController() {
  return useMemo(
    () => ({
      pickPrivateKey,
    }),
    [],
  );
}
