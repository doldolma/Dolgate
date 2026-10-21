import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeErrorMessage } from '../../store/utils/errors-and-prompts';

/** 실패하면 창에 한 줄로 보이고, 끝나면 닫는다. */
export function useDialogAction(fallbackKey = 'teamsPanel.actionFailed') {
  const { t: translate } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (failure) {
      setError(normalizeErrorMessage(failure, translate(fallbackKey)));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}
