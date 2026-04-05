import { Button, NoticeCard } from '../ui';

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
    <NoticeCard tone="warning" role="status" className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <span className="min-w-0 flex-[1_1_18rem] leading-[1.55] text-[var(--text)]">
          인터넷 연결이 없어 오프라인 모드로 실행 중입니다.
          {expiryLabel ? ` ${expiryLabel}까지 사용할 수 있습니다.` : ''}
        </span>
        <Button variant="secondary" className="ml-auto shrink-0" onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? '다시 연결 중...' : '다시 연결'}
        </Button>
      </div>
    </NoticeCard>
  );
}
