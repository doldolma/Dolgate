// 상단 바의 "동기화 꺼짐" 표시.
//
// **주어가 동기화다.** 한동안 노트북 아이콘에 "이 컴퓨터에만" 이라고 적었는데, 그러면 주어가
// 컴퓨터가 되어 문구가 전부 "이 컴퓨터에…" 로 시작하는 어색한 말이 됐다. 사용자가 실제로 알고
// 싶은 것은 기기가 아니라 **다른 기기와 같이 쓰이느냐**, 즉 동기화다. 주어를 바로잡으니 사선 친
// 클라우드가 제자리를 찾았다 — 고장 표시가 아니라 그냥 사실이다.
//
// **아이콘 하나로 두지 않는다.** 이 줄은 공유·세션 패널·알림 같은 **토글**이 늘어선 자리라,
// 정사각 아이콘 버튼을 하나 더 놓으면 무엇을 그리든 토글로 읽힌다(실제로 노트북 아이콘이
// "하단바 내리기" 로 읽혔다). 글자를 단 칩은 모양부터 다르고, 오른쪽 구분선이 "이건 종류가
// 다른 것" 이라고 한 번 더 말한다.
//
// **오류가 아니라 정상 상태다.** 경고색도 빨간 점도 쓰지 않는다 — 사용자가 골라서 꺼진 것이지
// 무언가 잘못된 것이 아니다.
//
// 로그인은 여기서 처리하지 않고 **로그인 창을 연다**. 오류 표시·서버 설정·브라우저 대기와 취소를
// 이 작은 판에 다시 만들면 로그인할 수 있는 자리마다 그것이 복제된다.
//
// 로그인이 끝나면 이 버튼은 사라진다(상태가 바뀌므로 렌더링에서 빠진다). 그것이 흡수가 끝났다는
// 유일한 피드백이다 — 따로 알림을 띄우지 않는다.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';
import { CloudOff } from '../ui/icons';

interface LocalOnlyChromeButtonProps {
  onRequestLogin: () => void;
}

export function LocalOnlyChromeButton({
  onRequestLogin,
}: LocalOnlyChromeButtonProps) {
  const { t: translate } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div className="relative [-webkit-app-region:no-drag]" ref={containerRef}>
      <div className="flex items-center gap-[0.55rem]">
        <button
          type="button"
          aria-expanded={open}
          aria-label={translate('localOnly.title')}
          title={translate('localOnly.title')}
          onClick={() => setOpen((current) => !current)}
          className="flex h-[1.875rem] items-center gap-[0.35rem] whitespace-nowrap rounded-[8px] border-0 bg-[rgba(255,255,255,0.09)] px-[0.7rem] text-[0.78rem] text-[rgba(255,255,255,0.8)] hover:bg-[rgba(255,255,255,0.14)] hover:text-white"
        >
          <CloudOff className="h-[0.95rem] w-[0.95rem]" aria-hidden="true" />
          {translate('localOnly.chip')}
        </button>
        {/* 토글들과 갈라 놓는 선. 이것이 없으면 칩도 그 줄의 일부로 읽힌다. */}
        <span
          aria-hidden="true"
          className="h-5 w-px bg-[rgba(255,255,255,0.16)]"
        />
      </div>

      {open ? (
        <div
          data-testid="local-only-popover"
          className="absolute right-0 top-[calc(100%+0.8rem)] z-20 w-[min(22rem,calc(100vw-2rem))] rounded-[12px] border border-[var(--border)] bg-[var(--dialog-surface)] p-5 shadow-[var(--shadow-floating)]"
        >
          <p className="m-0 mb-2 text-[0.95rem] font-medium text-[var(--text)]">
            {translate('localOnly.title')}
          </p>
          <p className="m-0 mb-4 text-[0.85rem] leading-[1.6] text-[var(--text-soft)]">
            {translate('localOnly.body')}
          </p>
          <Button
            variant="primary"
            fullWidth
            onClick={() => {
              setOpen(false);
              onRequestLogin();
            }}
          >
            {translate('localOnly.login')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
