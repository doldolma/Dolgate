import type { TeamChangeItem, TeamRecordKind } from '@shared';
import {
  ArrowLeftRight,
  Cloud,
  Folder,
  Globe,
  KeyRound,
  LayoutGrid,
  Network,
  Scissors,
  Server,
  ShieldCheck,
  type LucideIcon,
} from '../../ui/icons';

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** 묶음 제목에 종류를 놓는 순서 — 앱이 올리는 순서(그룹이 호스트보다 먼저). */
const KIND_ORDER: readonly TeamRecordKind[] = [
  'groups',
  'hosts',
  'secrets',
  'portForwards',
  'dnsOverrides',
  'knownHosts',
  'snippets',
  'workspaces',
  'tailnets',
  'awsProfiles',
];

export const TEAM_RECORD_KIND_ICONS: Record<TeamRecordKind, LucideIcon> = {
  groups: Folder,
  hosts: Server,
  secrets: KeyRound,
  portForwards: ArrowLeftRight,
  dnsOverrides: Globe,
  knownHosts: ShieldCheck,
  snippets: Scissors,
  workspaces: LayoutGrid,
  tailnets: Network,
  awsProfiles: Cloud,
};

/**
 * 한국어 받침이 있는지 — 조사(을/를·과/와)를 고른다. 조사는 늘 종류 이름("호스트")이나 "개" 뒤에 붙는다. 영어 종류
 * 이름은 읽는 소리로 어림한다(tailnet → 테일넷, Workspace → 워크스페이스).
 */
export function hasFinalConsonant(word: string): boolean {
  const trimmed = word.trim();
  const last = trimmed.slice(-1);
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    return (code - 0xac00) % 28 !== 0;
  }
  if (/[0-9]/.test(last)) {
    return '013678'.includes(last);
  }
  const lower = trimmed.toLowerCase();
  return lower.endsWith('net') || /[lmnr]$/.test(lower);
}

function particle(word: string, withFinal: string, withoutFinal: string): string {
  return `${word}${hasFinalConsonant(word) ? withFinal : withoutFinal}`;
}

/**
 * 종류 하나의 말 — 하나면 이름과 종류("Staging 그룹"), 여럿이면 개수("호스트 2개"). 비밀번호는 호스트 이름을
 * 이름으로 가지므로, 같은 묶음의 호스트 것이면 이름을 되풀이하지 않는다("legacy-db 호스트와 비밀번호").
 */
function kindPhrase(
  kind: TeamRecordKind,
  items: readonly TeamChangeItem[],
  hostLabels: ReadonlySet<string>,
  translate: Translate,
): string {
  if (kind === 'secrets' && items.length === 1 && items[0].label && hostLabels.has(items[0].label)) {
    return translate('teamChanges.kind.secrets');
  }
  if (items.length === 1 && items[0].label) {
    return translate('teamChanges.one', { name: items[0].label, kind: translate(`teamChanges.kind.${kind}`) });
  }
  return translate('teamChanges.many', { count: items.length, kind: translate(`teamChanges.kinds.${kind}`) });
}

/** 항목들을 한 말로 — "Staging 그룹과 호스트 2개". 조사 없이. */
export function formatTeamChangeSubject(
  items: readonly TeamChangeItem[],
  translate: Translate,
  language: string,
): string {
  const hostLabels = new Set(
    items.flatMap((item) => (item.kind === 'hosts' && item.label ? [item.label] : [])),
  );
  const phrases = KIND_ORDER.flatMap((kind) => {
    const ofKind = items.filter((item) => item.kind === kind);
    return ofKind.length > 0 ? [kindPhrase(kind, ofKind, hostLabels, translate)] : [];
  });
  if (phrases.length <= 1) {
    return phrases[0] ?? '';
  }
  const head = phrases.slice(0, -1).join(', ');
  const last = phrases[phrases.length - 1];
  return language.startsWith('ko') ? `${particle(head, '과', '와')} ${last}` : `${head} and ${last}`;
}

/** 묶음 제목 — "Staging 그룹과 호스트 2개를 삭제했습니다." 고치고 지운 것이 섞이면 둘 다 말한다. */
export function formatTeamChangeTitle(items: readonly TeamChangeItem[], translate: Translate, language: string): string {
  const object = (subset: readonly TeamChangeItem[]) => {
    const subject = formatTeamChangeSubject(subset, translate, language);
    return language.startsWith('ko') ? particle(subject, '을', '를') : subject;
  };
  const deleted = items.filter((item) => item.deleted);
  const edited = items.filter((item) => !item.deleted);
  if (edited.length === 0) {
    return translate('teamChanges.title.deleted', { what: object(deleted) });
  }
  if (deleted.length === 0) {
    return translate('teamChanges.title.edited', { what: object(edited) });
  }
  return translate('teamChanges.title.mixed', { edited: object(edited), deleted: object(deleted) });
}

/** 항목 하나의 이름 — 비밀번호는 호스트 이름을 이름으로 가지므로 종류를 붙인다. */
export function formatTeamChangeItemLabel(
  item: Pick<TeamChangeItem, 'kind' | 'label'>,
  translate: Translate,
): string {
  if (!item.label) {
    return translate('teamChanges.unreadable');
  }
  return item.kind === 'secrets' ? `${item.label} ${translate('teamChanges.kind.secrets')}` : item.label;
}
