import type { ReactNode } from 'react';

// 터미널 하단 1줄 바들의 공통 스킨. 사용처: 호스트 자원 바, mosh 상태 바, tmux 바
// (TerminalTmuxBar — ssh 감지 / tmux 세션 푸터 양쪽).
//
// 예전에는 각 바가 같은 클래스 문자열을 따로 복사해 들고 있었다. 그래서 한쪽만 고치면
// 나머지가 조용히 어긋났고, 실제로 여백(mx 0.35 vs 0.55, mb 0.2 vs 0.55, mt-1 유무)과
// 아이콘(텍스트 글리프 ▤ vs lucide, h-3 vs h-3.5)이 제각각이었다. 하단 바는 연결 방식에
// 따라 다른 조합이 같은 자리에 뜨기 때문에, 그 차이가 "연결마다 UI 가 다르다"로 보인다.
//
// 새 하단 바를 만들 때 클래스를 복사하지 말고 여기서 가져다 쓸 것.

/**
 * 바 본체 — 좌우 패딩·글자 크기·정렬.
 *
 * 테두리와 배경을 두지 않는다. 자원과 tmux 는 한 줄에 나란히 놓이는데 각자 상자를 두르면
 * 알약 두 개로 조각나 보이고, 터미널 바로 아래에 선이 하나 더 생겨 답답하다. 상자를 없애면
 * 인접한 두 영역이 그대로 한 줄짜리 상태바가 된다(구분은 호출부의 세로 구분선이 맡는다).
 *
 * min-h 가 있는 이유: 바마다 담는 것이 달라(자원 바는 글자만, tmux 바는 아이콘 + 메뉴
 * 버튼) 자연 높이가 어긋난다. 한 줄에 나란히 놓이므로 그 차이가 그대로 보인다. 실측으로
 * 가장 높은 조합(아이콘 14px)에 맞춘 값이라 어느 바도 잘리지 않는다.
 */
export const statusBarChrome =
  'flex min-h-[1.625rem] items-center gap-1.5 px-[0.7rem] py-[0.25rem] text-[0.7rem] text-[var(--text-muted)]';

/**
 * 바 바깥 여백.
 *
 * 위 여백(mt)은 두지 않는다 — 하단 바는 여러 개가 세로로 쌓이는데 각자 mt 를 들고 있으면
 * 간격이 그만큼 배로 벌어진다. 아래 여백은 바를 감싸는 statusBarStack 이 한 번만 준다.
 */
export const statusBarSpacing = 'mb-[0.2rem]';

/**
 * 한 줄 안에서 자원 영역과 tmux 영역을 가르는 세로선. 상자가 없으니 이것만으로 구분한다.
 * self-stretch 라 줄 높이를 그대로 따라간다.
 */
export const statusBarDivider = 'self-stretch border-l border-[var(--border)]';

/**
 * 하단 바 스택 컨테이너. 바들을 서로 바짝 붙이고 바깥 여백을 한 번만 준다.
 *
 * 좌우 여백이 여기 있는 이유: 바에 상자가 없어져 각자 mx 를 들 이유가 사라졌다. 바마다
 * 주면 구분선 양옆이 벌어져 한 줄로 안 읽힌다.
 * pane 안(TerminalSessionPane)과 pane 바깥(SessionShell) 양쪽이 같은 값을 써야
 * 연결 방식이 달라도 바가 같은 자리에 같은 간격으로 놓인다.
 */
export const statusBarStack = 'px-[0.35rem] pb-[0.15rem]';

/** 좌측 아이콘 크기. 바마다 h-3 / h-3.5 로 갈리던 것을 한 값으로 고정한다. */
export const statusBarIconSize = 'h-3.5 w-3.5';

/**
 * 바 우측 액션 버튼(tmux 의 열기 / detach). 바마다 다르던 hover 를 하나로 맞춘다.
 *
 * 세로 패딩을 주지 않는다 — 바가 이미 py 를 갖고 있어서 여기에 또 주면 그만큼 바가
 * 두꺼워진다(실측 26px → 33px). 버튼이 있는 바와 없는 바가 한 줄에 나란히 놓이므로
 * 그 차이가 그대로 보인다. 높이는 chrome 의 min-h 가 잡아 준다.
 */
export const statusBarActionButton =
  'ml-auto self-stretch rounded-[4px] border border-[var(--border)] bg-[var(--surface)] px-[0.55rem] text-[0.7rem] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]';

/**
 * 좌측 아이콘 슬롯. 텍스트 글리프(▤ 등)는 OS·폰트마다 두께와 세로 정렬이 달라져
 * 3-OS 빌드에서 제각각으로 보이므로 lucide 아이콘만 넣는다.
 */
export function StatusBarIcon({
  children,
  color = 'var(--accent)',
  spin = false,
}: {
  children: ReactNode;
  /** 상태색. mosh 의 연결/재연결/끊김처럼 색 자체가 의미를 가질 때만 바꾼다. */
  color?: string;
  spin?: boolean;
}) {
  return (
    <span
      className={spin ? 'inline-flex leading-none animate-spin' : 'inline-flex leading-none'}
      style={{ color }}
      aria-hidden
    >
      {children}
    </span>
  );
}
