import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { InfoHint } from '../../ui';

/**
 * 팀 것의 키 칸(후보 K1) — "My …" 이름과 ⓘ. 키는 늘 각자 넣는다: 팀에는 설정만 가고, 이 칸의 값은 나에게만 저장된다.
 *
 * FieldGroup 과 같은 모양이지만 이름을 `<label>` 로 감싸지 않는다 — label 안에 ⓘ 단추가 있으면 그 단추가 label 의 첫
 * 대상이 되어, 이름이 입력 칸 대신 단추를 가리킨다(이름을 눌러도 칸으로 가지 않는다). 입력 칸은 aria-label 로 이름을 갖는다.
 */
export function MyKeyField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const { t: translate } = useTranslation();
  return (
    <div className="flex min-w-0 flex-col gap-[0.55rem] text-[0.9rem] font-medium text-[var(--text)]">
      <span className="inline-flex items-center gap-1.5">
        <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">{label}</span>
        {hint ? <InfoHint label={translate('teams.myKey.aboutToggle')}>{hint}</InfoHint> : null}
      </span>
      {children}
    </div>
  );
}
