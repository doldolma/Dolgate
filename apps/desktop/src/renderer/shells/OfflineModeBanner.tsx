import { Button, NoticeCard } from '../ui';
import { useTranslation } from 'react-i18next';

interface OfflineModeBannerProps {
  expiryLabel: string | null;
  isRetrying: boolean;
  onRetry: () => void;
}

export function OfflineModeBanner({
  expiryLabel,
  isRetrying,
  onRetry,
}: OfflineModeBannerProps) {
  const { t: translate } = useTranslation();
  return (
    <NoticeCard tone="warning" role="status" className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <span className="min-w-0 flex-[1_1_18rem] leading-[1.55] text-[var(--text)]">
          {translate('offlineBanner.body')}
          {expiryLabel ? translate('offlineBanner.until', { expiry: expiryLabel }) : ''}
        </span>
        <Button variant="secondary" className="ml-auto shrink-0" onClick={onRetry} disabled={isRetrying}>
          {translate(isRetrying ? 'offlineBanner.retrying' : 'offlineBanner.retry')}
        </Button>
      </div>
    </NoticeCard>
  );
}
