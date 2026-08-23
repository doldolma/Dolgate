// 호스트 뱃지. 감지한 OS 가 있으면 그 배포판 마크를, 없으면 예전처럼 글자를 그린다.
//
// 한 곳에 모아 둔 이유: 이 뱃지는 카드·표·상세·SFTP·컨테이너 등 일곱 군데에서 그려진다.
// 판정을 각자 하게 두면 어떤 화면은 마크가 뜨고 어떤 화면은 글자가 뜨는 상태가 된다.

import { getHostBadgeLabel, resolveHostOsMark, type HostRecord } from '@shared';
import type { CSSProperties } from 'react';
import { cn } from '../../lib/cn';
import { HOST_OS_MARK_ART, isLetteredMark } from '../../lib/host-os-marks';
import { getHostBadgeTone } from './hostDisplay';

interface HostBadgeProps {
  host: HostRecord;
  className?: string;
}

// 칸은 정사각형이다. 예전에는 'WARP' 네 글자를 담으려고 가로가 더 길었는데(37×30), 그 칸에
// 정사각 로고가 들어가니 좌우가 비어 늘어나 보였다. 감지 여부와 무관하게 같은 칸을 써야
// 목록의 이름 시작 위치가 줄마다 흔들리지 않으므로, 글자 뱃지도 같이 정사각으로 좁힌다.
const BADGE_BOX =
  'inline-grid h-[1.9rem] w-[1.9rem] shrink-0 place-items-center rounded-[8px]';

/** 네 글자(WARP·ESXi·NBSD)는 좁아진 칸에 0.7rem 으로 들어가지 않는다. */
function letterSize(label: string): string {
  return label.length >= 4 ? 'text-[0.6rem]' : 'text-[0.7rem]';
}

export function HostBadge({ host, className }: HostBadgeProps) {
  const mark = resolveHostOsMark(host.detectedOs);
  const art = mark ? HOST_OS_MARK_ART[mark] : null;

  if (!art) {
    const label = getHostBadgeLabel(host);
    return (
      <span
        aria-hidden="true"
        className={cn(
          BADGE_BOX,
          'font-bold tracking-[-0.01em]',
          letterSize(label),
          getHostBadgeTone(host),
          className,
        )}
      >
        {label}
      </span>
    );
  }

  // 무엇인지는 이름으로 남긴다 — 로고만으로는 스크린리더에 아무것도 남지 않는다.
  const name = host.detectedOs?.prettyName || art.title;

  if (isLetteredMark(art)) {
    // 로고를 못 쓰는 것들(워드마크·얇은 실선). 브랜드색으로 칠하면 회색 Synology 처럼 다시
    // 안 보이게 되므로, 미감지 호스트와 같은 칩을 쓰고 글자만 OS 것으로 바꾼다.
    return (
      <span
        role="img"
        aria-label={name}
        title={name}
        className={cn(
          BADGE_BOX,
          'font-bold tracking-[-0.02em]',
          letterSize(art.letters),
          getHostBadgeTone(host),
          className,
        )}
      >
        {art.letters}
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      // 색은 테마마다 달라야 해서 스타일시트가 고른다([data-host-os-mark] 규칙). 여기서는
      // 브랜드색과 "그 테마에서 브랜드색을 써도 되는지"만 넘긴다.
      data-host-os-mark="true"
      className={cn(BADGE_BOX, className)}
      style={
        {
          '--host-os-brand': art.hex,
          ...(art.ink === 'both' || art.ink === 'light'
            ? { '--host-os-ink-light': art.hex }
            : null),
          ...(art.ink === 'both' || art.ink === 'dark'
            ? { '--host-os-ink-dark': art.hex }
            : null),
        } as CSSProperties
      }
    >
      <svg
        viewBox="0 0 24 24"
        className="h-[1.15rem] w-[1.15rem]"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d={art.path} />
      </svg>
    </span>
  );
}
