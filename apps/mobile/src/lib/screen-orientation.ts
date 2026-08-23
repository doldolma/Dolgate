import { NativeModules, Platform } from 'react-native';

type ScreenOrientationModuleShape = {
  lockLandscape(): void;
  unlock(): void;
};

/**
 * 화면을 가로로 고정한다.
 *
 * 원격 데스크톱은 가로가 기본인데, 폰의 자동 회전을 꺼 둔 사람은 세로로만 보게 된다 — 앱이
 * 막고 있는 게 아니라 시스템 설정이라, 그 사람들을 위해 앱 안에서 뒤집을 길을 준다.
 *
 * **지금은 안드로이드에만 있다.** iOS 16+ 는 `UIWindowScene.requestGeometryUpdate` 와 루트
 * 뷰 컨트롤러의 `supportedInterfaceOrientations` 재정의가 함께 필요해 작업 크기가 다르다.
 * 없는 플랫폼에서는 `isSupported` 가 false 이고, 호출은 조용히 아무 일도 하지 않는다 —
 * 버튼을 그 값으로 감춘다.
 */
function getNativeModule(): ScreenOrientationModuleShape | undefined {
  // 조회를 호출 시점까지 미룬다 — import 시점에 붙잡아 두면 테스트가 갈아끼울 틈이 없다.
  return NativeModules.ScreenOrientationModule as
    | ScreenOrientationModuleShape
    | undefined;
}

export function isScreenOrientationLockSupported(): boolean {
  return Platform.OS === 'android' && Boolean(getNativeModule());
}

export function lockLandscape(): void {
  getNativeModule()?.lockLandscape();
}

/**
 * 시스템 설정으로 되돌린다.
 *
 * **화면을 벗어날 때 반드시 부른다.** 안 부르면 홈 화면까지 가로로 남는다.
 */
export function unlockOrientation(): void {
  getNativeModule()?.unlock();
}
