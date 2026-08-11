import { beforeEach, describe, expect, it, vi } from "vitest";

// 메뉴 항목은 id 로 찾아 enabled 만 바꾼다. 재생성하면 macOS 메뉴바가 깜빡이고 열려 있던 메뉴가
// 닫힌다.
const items = new Map<string, { enabled: boolean }>();
const applicationMenu = {
  getMenuItemById: (id: string) => items.get(id) ?? null,
};
let currentMenu: typeof applicationMenu | null = applicationMenu;

vi.mock("electron", () => ({
  Menu: { getApplicationMenu: () => currentMenu },
}));

const {
  RDP_CAPTURE_SENSITIVE_MENU_IDS,
  forgetRdpKeyboardCapture,
  isRdpKeyboardCaptureActive,
  resetRdpKeyboardCaptureForTests,
  setRdpKeyboardCapture,
} = await import("./rdp-keyboard-capture");

beforeEach(() => {
  resetRdpKeyboardCaptureForTests();
  currentMenu = applicationMenu;
  items.clear();
  for (const id of RDP_CAPTURE_SENSITIVE_MENU_IDS) {
    items.set(id, { enabled: true });
  }
});

function enabledIds(): string[] {
  return [...items.entries()]
    .filter(([, item]) => item.enabled)
    .map(([id]) => id);
}

describe("RDP 키보드 캡처", () => {
  it("캡처 중에는 충돌하는 메뉴 항목을 비활성화한다", () => {
    // 비활성 key equivalent 는 매칭되지 않아 키가 웹 페이지(캔버스)로 내려온다. macOS 는 메뉴가
    // 페이지보다 먼저 매칭되므로 이것 없이는 Cmd+W 가 원격에 못 간다.
    setRdpKeyboardCapture(7, true);

    expect(enabledIds()).toEqual([]);
  });

  it("캡처가 끝나면 되돌린다", () => {
    setRdpKeyboardCapture(7, true);
    setRdpKeyboardCapture(7, false);

    expect(enabledIds()).toEqual([...RDP_CAPTURE_SENSITIVE_MENU_IDS]);
    expect(isRdpKeyboardCaptureActive(7)).toBe(false);
  });

  it("창을 옮기는 동안 새 창의 focus 가 옛 창의 blur 보다 먼저 와도 켜진 채로 둔다", () => {
    // 모니터별 창까지 같은 캔버스를 쓴다. 여기서 한 번 풀리면 그 순간의 키가 우리 단축키로 샌다.
    setRdpKeyboardCapture(1, true);
    setRdpKeyboardCapture(2, true);
    setRdpKeyboardCapture(1, false);

    expect(isRdpKeyboardCaptureActive(2)).toBe(true);
    expect(enabledIds()).toEqual([]);
  });

  it("캡처를 쥔 채 창이 닫히면 잊는다", () => {
    // blur 가 오지 않는 경로다. 남겨두면 앱 단축키가 영구히 죽는다.
    setRdpKeyboardCapture(3, true);

    forgetRdpKeyboardCapture(3);

    expect(isRdpKeyboardCaptureActive(3)).toBe(false);
    expect(enabledIds()).toEqual([...RDP_CAPTURE_SENSITIVE_MENU_IDS]);
  });

  it("창 닫기와 시스템 항목은 대상이 아니다", () => {
    // 캡처가 켜진 채 남는 버그가 생겨도 키보드로 창을 닫을 길은 하나 있어야 한다.
    expect(RDP_CAPTURE_SENSITIVE_MENU_IDS).not.toContain("window-close");
    expect(RDP_CAPTURE_SENSITIVE_MENU_IDS).not.toContain("quit");
  });

  it("메뉴가 아직 없어도 상태는 기록한다", () => {
    // 창이 먼저 뜨고 메뉴가 나중에 붙는 순서가 있다. 여기서 던지면 IPC 핸들러가 죽는다.
    currentMenu = null;

    expect(() => setRdpKeyboardCapture(9, true)).not.toThrow();
    expect(isRdpKeyboardCaptureActive(9)).toBe(true);
  });
});
