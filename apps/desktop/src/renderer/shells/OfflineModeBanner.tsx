import { Button } from '../ui';

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
  return (
    <div className="terminal-warning-banner app-offline-banner" role="status">
      <span className="app-offline-banner__message">
        인터넷 연결이 없어 오프라인 모드로 실행 중입니다.
        {expiryLabel ? ` ${expiryLabel}까지 사용할 수 있습니다.` : ''}
      </span>
      <Button variant="secondary" className="app-offline-banner__action" onClick={onRetry} disabled={isRetrying}>
        {isRetrying ? '다시 연결 중...' : '다시 연결'}
      </Button>
    </div>
  );
}
