import type { SecretMetadataRecord } from '@shared';
import { useTranslation } from 'react-i18next';
import { SearchableSelect } from '../ui';
import {
  formatSavedSecretOptionDetail,
  formatRdpCredentialOptionDetail,
} from '../lib/secret-display';

/**
 * 목록에 없는 현재 값은 메타데이터가 없을 수 있다(자격증명이 지워졌거나 다른 기기에서 만든 것).
 * 그때는 이름만 들고 온다 — 둘째 줄은 만들 수 없고, 만들면 "undefined 호스트" 가 찍힌다.
 */
export type CredentialSelectEntry = Pick<SecretMetadataRecord, 'secretRef' | 'label'> &
  Partial<SecretMetadataRecord>;

interface CredentialSelectProps {
  /** 접근성 이름. 섹션마다 문구가 다르다(SSH·RDP·VNC). */
  ariaLabel: string;
  /** 'new' 또는 `existing:<secretRef>`. 호스트 폼의 credentialMode/selectedSecretRef 조합. */
  value: string;
  entries: SecretMetadataRecord[];
  /**
   * 목록에는 없는데 지금 이 호스트에 붙어 있는 항목.
   *
   * 필터(종류·인증 방식)에 걸려 사라진 자격증명이 있어도 **현재 값은 보여야 한다** — 안 그러면
   * 무엇이 붙어 있는지 모르는 채로 폼을 저장하게 된다.
   */
  missingEntry?: CredentialSelectEntry | null;
  /** RDP·VNC 는 계정을 앞세운다. 생략하면 SSH 규칙(무엇이 들었나 + 몇 대가 쓰나). */
  accountFirst?: boolean;
  onSelectNew: () => void;
  onSelectExisting: (secretRef: string) => void;
  disabled?: boolean;
}

/**
 * 자격증명 고르기. 세 섹션(SSH·RDP·VNC)이 같은 규칙을 쓰므로 한 곳에 둔다.
 *
 * **native select 가 아니라 검색 가능한 목록이다.** 자격증명은 호스트에 비밀번호를 넣을 때마다
 * 하나씩 생기므로(호스트 수만큼 쌓인다) 목록이 길어지는 것이 정상이고, 스크롤로 찾는 것은
 * 그 시점부터 성립하지 않는다. 이름·종류·계정이 모두 검색어가 된다.
 *
 * 이름은 첫 줄, 나머지 정보(종류·연결된 호스트 수·계정)는 둘째 줄로 나눈다 — 한 줄로 이으면
 * 가장 중요한 이름이 부가 정보에 묻힌다.
 */
export function CredentialSelect({
  ariaLabel,
  value,
  entries,
  missingEntry,
  accountFirst = false,
  onSelectNew,
  onSelectExisting,
  disabled = false,
}: CredentialSelectProps) {
  const { t: translate } = useTranslation();
  const describe = accountFirst
    ? formatRdpCredentialOptionDetail
    : formatSavedSecretOptionDetail;
  const detailFor = (entry: CredentialSelectEntry): string | undefined =>
    entry.linkedHostCount === undefined
      ? undefined
      : describe(entry as SecretMetadataRecord);

  const newLabel = translate('hostForm.auth.newCredential');
  const options = [
    { value: 'new', label: newLabel },
    ...(missingEntry
      ? [
          {
            value: `existing:${missingEntry.secretRef}`,
            label: missingEntry.label,
            description: detailFor(missingEntry),
          },
        ]
      : []),
    ...entries.map((entry) => ({
      value: `existing:${entry.secretRef}`,
      label: entry.label,
      description: detailFor(entry),
    })),
  ];

  return (
    <SearchableSelect
      ariaLabel={ariaLabel}
      placeholder={newLabel}
      value={value}
      options={options}
      disabled={disabled}
      onChange={(next) => {
        if (next === 'new') {
          onSelectNew();
          return;
        }
        if (next.startsWith('existing:')) {
          onSelectExisting(next.slice('existing:'.length));
        }
      }}
    />
  );
}
