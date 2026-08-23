// 세션 하단바의 판정만 모아 둔 곳 — 무엇을 접을지, 연결종류를 무엇으로 부를지.
//
// 컴포넌트에서 떼어 둔 이유: 접힘은 폭에 따라 여섯 단계로 갈리고 연결종류는 호스트 종류 ·
// 점프 · 컨테이너 조합으로 갈린다. 둘 다 JSX 안에서 삼항으로 엮으면 어떤 조합이 어떻게
// 나오는지 눈으로 확인할 수 없다.

import type {
  HostRecord,
  TerminalConnectionHop,
} from '@shared';
import { isSshHostRecord } from '@shared';

/**
 * 폭에 따라 무엇을 남길지.
 *
 * 넓으면 지금처럼 NET·DISK 까지 보이고, 좁아지면 **그것부터** 버린다 — 초당 값은 자리를 가장
 * 많이 먹으면서 "지금 바쁜가" 는 CPU·RAM 으로도 알 수 있다. 그다음 칩(글자를 버려도 아이콘이
 * 자리를 지킨다) → 단위 → 라벨 → RAM → 지연 순이고, 마지막까지 남는 것은 CPU 다.
 */
export interface SessionStatusBarFold {
  /** 디스크 읽기·쓰기(초당). 가장 먼저 빠진다. */
  showDisk: boolean;
  /** 네트워크 수신·송신(초당). 디스크 다음으로 빠진다. */
  showNet: boolean;
  /** 칩(연결종류·tmux)을 아이콘만으로 그린다. */
  chipsIconOnly: boolean;
  /** `1.2 / 7.7GiB` 를 `1.2/7.7G` 로 줄인다. */
  shortUnits: boolean;
  /** `CPU`·`RAM` 라벨을 뗀다. */
  hideLabels: boolean;
  showRam: boolean;
  showRtt: boolean;
}

/**
 * 바의 실측 폭(px)으로 접힘 단계를 고른다.
 *
 * 경계는 실제 내용 폭이 아니라 자리값이다 — 값이 몇 자리인지에 따라 실제 폭은 조금씩
 * 다르므로, 경계에서 한 단계 일찍 접히는 편이 넘쳐서 잘리는 것보다 낫다.
 */
export function resolveStatusBarFold(width: number): SessionStatusBarFold {
  return {
    showDisk: width >= 700,
    showNet: width >= 600,
    chipsIconOnly: width < 520,
    shortUnits: width < 440,
    hideLabels: width < 380,
    showRam: width >= 320,
    showRtt: width >= 250,
  };
}

/** 하단바 왼쪽 맨 앞 칩. 평범한 SSH 면 만들지 않는다(모든 세션에 붙는 라벨은 정보가 아니다). */
export type SessionKindChipKind =
  | 'jump'
  | 'ssm'
  | 'ecs'
  | 'warpgate'
  | 'serial'
  | 'container';

export interface SessionKindChip {
  kind: SessionKindChipKind;
  /** 점프 홉 수(1홉이면 라벨에 이름을 넣는다). 점프가 아니면 0. */
  hopCount: number;
  /** 1홉일 때 라벨에 넣을 경유 호스트 이름. */
  hopName: string | null;
}

interface KindChipInput {
  host: HostRecord | null | undefined;
  shellKind?: string;
  hops?: readonly TerminalConnectionHop[] | null;
}

/** 홉 목록의 마지막은 목적지다 — 경유한 곳만 세려면 하나를 뺀다. */
function countJumpHops(hops: readonly TerminalConnectionHop[] | null | undefined): number {
  if (!hops || hops.length < 2) {
    return 1;
  }
  return hops.length - 1;
}

function firstHopName(
  hops: readonly TerminalConnectionHop[] | null | undefined,
): string | null {
  const first = hops?.[0];
  if (!first) {
    return null;
  }
  const name = first.name?.trim();
  if (name) {
    return name;
  }
  // Go 라벨은 `user@host:port` — 이름이 없으면 호스트만 떼어 쓴다.
  const label = first.label.trim();
  const at = label.lastIndexOf('@');
  const target = at >= 0 ? label.slice(at + 1) : label;
  const colon = target.lastIndexOf(':');
  const host = colon > 0 ? target.slice(0, colon) : target;
  return host || null;
}

export function resolveSessionKindChip({
  host,
  shellKind,
  hops,
}: KindChipInput): SessionKindChip | null {
  const none = { hopCount: 0, hopName: null };
  // 컨테이너 exec 은 호스트 종류보다 먼저 본다 — 붙은 곳이 호스트가 아니라 그 안의 컨테이너다.
  if (shellKind === 'container-exec') {
    return { kind: 'container', ...none };
  }
  if (!host) {
    return null;
  }
  if (host.kind === 'aws-ec2') {
    return { kind: 'ssm', ...none };
  }
  if (host.kind === 'aws-ecs') {
    return { kind: 'ecs', ...none };
  }
  if (host.kind === 'warpgate-ssh') {
    return { kind: 'warpgate', ...none };
  }
  if (host.kind === 'serial') {
    return { kind: 'serial', ...none };
  }
  if (isSshHostRecord(host) && host.jumpHostId) {
    return { kind: 'jump', hopCount: countJumpHops(hops), hopName: firstHopName(hops) };
  }
  return null;
}

export interface SessionHopRow {
  index: number;
  name: string | null;
  label: string;
  destination: boolean;
  failed: boolean;
}

/**
 * 종류 칩 hover 에 뿌릴 홉 목록.
 *
 * 이 값은 연결이 끝난 뒤에도 남아 있다(스토어가 지우지 않고 갱신만 한다) — 그래서 접속한
 * 뒤에도 "어디를 거쳐 왔는지" 를 볼 수 있다.
 */
export function buildHopRows(
  hops: readonly TerminalConnectionHop[] | null | undefined,
): SessionHopRow[] {
  if (!hops || hops.length === 0) {
    return [];
  }
  const ordered = [...hops].sort((left, right) => left.index - right.index);
  return ordered.map((hop, position) => ({
    index: hop.index,
    name: hop.name?.trim() || null,
    label: hop.label,
    destination: position === ordered.length - 1,
    failed: hop.stage === 'failed',
  }));
}

/** `1.2 / 7.7GiB` ↔ `1.2/7.7G`. 접힘 2단계에서 단위를 줄인다. */
export function shortenRatio(ratio: string): string {
  return ratio.replace(/\s*\/\s*/, '/').replace(/([KMGT])iB\b/g, '$1');
}
