import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Info } from './icons';

interface InfoHintProps {
  /** 스크린리더용 이름. 무엇에 대한 설명인지 알 수 있게 구체적으로. */
  label: string;
  /** 팝오버 안에 들어갈 내용. 문단 하나이거나 짧은 목록. */
  children: ReactNode;
  /** 기본 24rem. 목록이 길면 늘린다. */
  widthClassName?: string;
}

/**
 * 제목 옆에 붙는 ⓘ. 눌러도 hover 해도 뜨는 말풍선을 흐름 **위에** 겹쳐 띄운다.
 *
 * **어디에 쓸지가 이 컴포넌트의 절반이다.** 모든 섹션에 달면 아무도 누르지 않는다. 이름만
 * 보고 "그게 내 컴퓨터·내 데이터에 무슨 일을 하는지" 짐작이 안 되는 기능에만 붙인다.
 * 취향 설정(테마·알림·재연결)에는 붙일 것이 없다 — 이름이 이미 다 말한다.
 *
 * 그리고 바로 아래 설명 줄과 **다른 층위**를 말해야 한다. 같은 내용을 길이만 바꿔 반복하면
 * 둘 다 안 읽힌다.
 *
 * 자리를 차지하지 않는 것이 계약이다. 접히는 영역으로 만들면 열고 닫을 때마다 아래 UI 가
 * 밀려 화면이 출렁인다.
 */
export function InfoHint({ label, children, widthClassName = 'w-[24rem]' }: InfoHintProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // 클릭으로 연 말풍선은 마우스를 떼도 남는다(hover 는 훑는 용도, 클릭은 붙잡는 용도).
  // 그래서 Esc 로 닫을 길이 필요하다.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[var(--text-soft)] hover:text-[var(--text)]"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
      >
        <Info className="h-4 w-4" aria-hidden />
      </button>
      {open ? (
        // 아이콘 기준 가운데가 아니라 왼쪽 끝에 붙인다 — 제목은 창 왼쪽에 가까워서 가운데
        // 정렬은 말풍선 절반이 창 밖으로 나간다. 좁은 창에서는 화면 폭으로 잘라 준다.
        <span
          role="tooltip"
          className={`absolute left-0 top-[calc(100%+0.5rem)] z-30 ${widthClassName} max-w-[calc(100vw-3rem)] rounded-[10px] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3 text-[0.82rem] font-normal leading-[1.5] text-[var(--text-soft)] shadow-[0_10px_30px_rgba(0,0,0,0.28)]`}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

/**
 * 말풍선 안의 짧은 사실 목록. 문장 두세 개면 이 형태가 문단보다 읽힌다.
 *
 * 각 줄은 **사실 하나**여야 한다 — 특히 저장·전송처럼 안전에 관한 내용은 확인한 것만 쓴다.
 * 여기에 잘못 쓰면 사용자는 틀린 안심을 얻는다.
 */
export function InfoHintPoints({ items }: { items: string[] }) {
  return (
    <span className="grid gap-1.5">
      {items.map((item) => (
        <span key={item} className="flex items-start gap-2">
          <Check
            className="mt-[0.15rem] h-3.5 w-3.5 shrink-0 text-[var(--success,#3fae8f)]"
            aria-hidden
          />
          <span>{item}</span>
        </span>
      ))}
    </span>
  );
}
