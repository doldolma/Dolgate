import { NativeModules, Platform } from 'react-native';
import {
  isScreenOrientationLockSupported,
  lockLandscape,
  unlockOrientation,
} from '../src/lib/screen-orientation';

// 원격 데스크톱만 가로로 고정할 수 있게 한다. **지금은 안드로이드에만 있다** — iOS 16+ 는
// 뷰 컨트롤러 재정의까지 필요해 작업 크기가 다르다. 없는 플랫폼에서 버튼이 뜨면 눌러도
// 아무 일이 없으므로, 지원 여부로 버튼을 감춘다.

const platformOsDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');

function setPlatformOs(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
}

describe('screen orientation', () => {
  const nativeModule = { lockLandscape: jest.fn(), unlock: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    (NativeModules as Record<string, unknown>).ScreenOrientationModule =
      nativeModule;
  });

  afterEach(() => {
    if (platformOsDescriptor) {
      Object.defineProperty(Platform, 'OS', platformOsDescriptor);
    }
    delete (NativeModules as Record<string, unknown>).ScreenOrientationModule;
  });

  it('안드로이드에서만 지원한다고 답한다', () => {
    setPlatformOs('android');
    expect(isScreenOrientationLockSupported()).toBe(true);

    setPlatformOs('ios');
    expect(isScreenOrientationLockSupported()).toBe(false);
  });

  it('네이티브 모듈이 없으면 지원하지 않는다', () => {
    setPlatformOs('android');
    delete (NativeModules as Record<string, unknown>).ScreenOrientationModule;
    expect(isScreenOrientationLockSupported()).toBe(false);
  });

  it('잠그고 푸는 호출이 네이티브로 간다', () => {
    setPlatformOs('android');
    lockLandscape();
    expect(nativeModule.lockLandscape).toHaveBeenCalledTimes(1);
    unlockOrientation();
    expect(nativeModule.unlock).toHaveBeenCalledTimes(1);
  });

  it('모듈이 없어도 던지지 않는다', () => {
    // 화면을 벗어날 때 부르는 경로라, 여기서 던지면 언마운트가 깨진다.
    delete (NativeModules as Record<string, unknown>).ScreenOrientationModule;
    expect(() => unlockOrientation()).not.toThrow();
    expect(() => lockLandscape()).not.toThrow();
  });
});
