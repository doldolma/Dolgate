import type { HostRecord } from '@shared';
import { t } from '../../i18n';

/** 상세 패널용 풀 타입 라벨. */
export function getHostTypeLabel(host: HostRecord): string {
  switch (host.kind) {
    case 'aws-ec2':
      return 'AWS EC2';
    case 'aws-ecs':
      return 'AWS ECS';
    case 'warpgate-ssh':
      return 'Warpgate SSH';
    case 'serial':
      return 'Serial';
    default:
      return 'SSH';
  }
}

/** 카드용 짧은 타입 라벨(EC2 · region 형태로 쓰기 좋음). */
export function getHostShortType(host: HostRecord): string {
  switch (host.kind) {
    case 'aws-ec2':
      return 'EC2';
    case 'aws-ecs':
      return 'ECS';
    case 'warpgate-ssh':
      return 'Warpgate';
    case 'serial':
      return 'Serial';
    default:
      return 'SSH';
  }
}

/** IP/호스트 주소 한 줄. */
export function getHostAddress(host: HostRecord): string | null {
  switch (host.kind) {
    case 'ssh':
      return `${host.hostname}:${host.port}`;
    case 'aws-ec2':
      return host.awsPrivateIp || host.awsInstanceId || null;
    case 'aws-ecs':
      return host.awsEcsClusterName || null;
    case 'warpgate-ssh':
      return `${host.warpgateSshHost}:${host.warpgateSshPort}`;
    case 'serial':
      return host.transport === 'local'
        ? host.devicePath ?? null
        : host.host && host.port
          ? `${host.host}:${host.port}`
          : null;
    default:
      return null;
  }
}

/** 최근 사용(연결) 시각 ms → 상대시간(가까운 과거) / 날짜(오래됨). 카드·테이블 공용. */
export function formatLastUsed(ms: number): string {
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 1) {
    return t('hostDisplay.justNow');
  }
  if (diffMin < 60) {
    return t('hostDisplay.minutes', { count: diffMin });
  }
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) {
    return t('hostDisplay.hours', { count: diffHour });
  }
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) {
    return t('hostDisplay.days', { count: diffDay });
  }
  return new Date(ms).toLocaleDateString();
}

export function getHostRegion(host: HostRecord): string | null {
  if (host.kind === 'aws-ec2' || host.kind === 'aws-ecs') {
    return host.awsRegion ?? null;
  }
  return null;
}

/**
 * 타입 배지 색 — 목업처럼 네이비/블루 절제 팔레트(쿨톤, 흰 글씨).
 * 무지개색 대신 톤만 살짝 달리해 타입을 구분한다.
 */
export function getHostBadgeTone(host: HostRecord): string {
  switch (host.kind) {
    case 'aws-ec2':
      return 'bg-[#1f3a5f] text-white';
    case 'aws-ecs':
      return 'bg-[#3457b3] text-white';
    case 'warpgate-ssh':
      return 'bg-[#494f87] text-white';
    case 'serial':
      return 'bg-[#3a6076] text-white';
    default:
      return 'bg-[#43566f] text-white';
  }
}
