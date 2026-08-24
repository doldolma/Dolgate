// 상단 바(창 크롬)에 놓이는 아이콘 토글의 스킨. 세션 패널·하단바 토글, 알림, 공유가 함께 쓴다.
//
// AppTitleBar 안에 두면 크롬에 붙는 다른 조각(공유 버튼처럼 셸이 끼워 넣는 것)이 같은 값을
// 쓰려고 상단 바 모듈 전체를 끌어와야 한다 — 그래서 여기 하나로 둔다.
//
// 평소에는 배경 없이 아이콘만 둔다. 켜지면 옅은 칩 + 얇은 테두리로 바꾸고 아이콘만 완전한
// 흰색이 된다 — 흰 원으로 채우면 크롬에서 그것만 튀고, hover 배경만으로는 켜진 티가 나지
// 않는다. IconButton 의 active 색(selection-tint)은 밝은 배경을 가정한 값이라 여기선 못 쓴다.
//
// 모양은 **라운드 사각**이다(원형 아님). 원형은 눌릴 영역이 눈에 덜 잡히고, 앱의 다른 아이콘
// 버튼(IconButton sm = rounded-[10px])과도 어긋난다.
export const CHROME_TOGGLE_CLASS =
  'h-9 w-9 rounded-[10px] border-transparent bg-transparent text-[1.15rem] text-[rgba(255,255,255,0.66)] shadow-none hover:bg-[rgba(255,255,255,0.1)] hover:text-white';
export const CHROME_TOGGLE_ON_CLASS =
  'bg-[rgba(255,255,255,0.16)] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.24)] hover:bg-[rgba(255,255,255,0.2)]';
