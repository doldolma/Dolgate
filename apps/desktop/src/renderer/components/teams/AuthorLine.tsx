import { useTranslation } from 'react-i18next';
import { Tooltip } from '../../ui';
import { Smartphone, User } from '../../ui/icons';

/**
 * 폰이 남긴 팀 기록 줄의 표시 — 작성자 뒤에 '· Mobile'. 폰은 그 사람의 기기라 작성자 옆에 둔다. 폰은 녹화하지 않으므로
 * Replay 가 없는 까닭은 'Mobile' 에 마우스를 올리면 말한다. 기록 화면·호스트 상세·최근 로그가 같이 쓴다.
 */
export function MobileMark({ icon = true }: { icon?: boolean }) {
  const { t: translate } = useTranslation();
  return (
    <>
      <span aria-hidden className="shrink-0">
        ·
      </span>
      <Tooltip label={translate('teamLogs.mobileNotRecorded')} className="shrink-0 items-center gap-[0.3rem]">
        {icon ? <Smartphone className="h-[0.8rem] w-[0.8rem] shrink-0" aria-hidden /> : null}
        <span>Mobile</span>
      </Tooltip>
    </>
  );
}

/** 기록 카드의 누가 한 줄 — 팀 기록과 바뀐 것이 같은 모양으로 쓴다. 폰이 남긴 줄이면 뒤에 MobileMark. */
export function AuthorLine({ email, mobile = false }: { email: string; mobile?: boolean }) {
  return (
    <div className="mt-[0.15rem] flex min-w-0 items-center gap-[0.3rem] text-[0.82rem] text-[var(--text-soft)]">
      <User className="h-[0.8rem] w-[0.8rem] shrink-0" aria-hidden />
      <span className="truncate">{email}</span>
      {mobile ? <MobileMark /> : null}
    </div>
  );
}
