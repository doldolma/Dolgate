// 호스트 뱃지. 감지한 OS 가 있으면 그 배포판 마크를, 없으면 예전처럼 글자를 그린다.
//
// 한 곳에 모아 둔 이유: 이 뱃지는 카드·표·상세·SFTP·컨테이너 등 일곱 군데에서 그려진다.
// 판정을 각자 하게 두면 어떤 화면은 마크가 뜨고 어떤 화면은 글자가 뜨는 상태가 된다.

import { getHostBadgeLabel, resolveHostOsMark, type HostRecord } from '@shared';
import { cn } from '../../lib/cn';
import { HOST_OS_MARK_ART } from '../../lib/host-os-marks';
import { getHostBadgeTone } from './hostDisplay';

interface HostBadgeProps {
  host: HostRecord;
  className?: string;
}

export function HostBadge({ host, className }: HostBadgeProps) {
  const mark = resolveHostOsMark(host.detectedOs);
  const art = mark ? HOST_OS_MARK_ART[mark] : null;

  if (!art) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'inline-grid h-[1.9rem] min-w-[2.3rem] shrink-0 place-items-center rounded-[8px] px-[0.25rem] text-[0.7rem] font-bold tracking-[-0.01em]',
          getHostBadgeTone(host),
          className,
        )}
      >
        {getHostBadgeLabel(host)}
      </span>
    );
  }

  return (
    <span
      // 무엇인지는 이름으로 남긴다 — 로고만으로는 스크린리더에 아무것도 남지 않는다.
      role="img"
      aria-label={host.detectedOs?.prettyName || art.title}
      title={host.detectedOs?.prettyName || art.title}
      className={cn(
        'inline-grid h-[1.9rem] min-w-[2.3rem] shrink-0 place-items-center rounded-[8px] px-[0.25rem]',
        className,
      )}
      style={{
        // 브랜드 색을 옅게 깔고 마크에 그 색을 그대로 쓴다. 꽉 채우면 목록에서 그것만 튄다.
        background: `color-mix(in srgb, ${art.hex} 16%, transparent)`,
        color: art.hex,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-[1.05rem] w-[1.05rem]"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d={art.path} />
      </svg>
    </span>
  );
}
