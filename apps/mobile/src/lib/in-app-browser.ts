import { Linking, NativeModules } from 'react-native';

type InAppBrowserModuleShape = {
  openBrowser(url: string): Promise<void>;
  closeBrowser(): Promise<void>;
};

// 네이티브 모듈 이름은 AWS SSO 때 붙은 그대로지만 담고 있는 건 범용 인앱 브라우저다
// (iOS SFSafariViewController / Android Custom Tabs). 계정 로그인도 같은 시트를 쓴다 —
// 시스템 브라우저로 내보내면 앱을 벗어나서 로그인하는 셈이라 App Store 심사 Guideline 4.0
// 에 걸린다(1.8.5 리젝 사유).
function getNativeInAppBrowser(): InAppBrowserModuleShape | undefined {
  // 모듈 조회를 호출 시점까지 미룬다 — import 시점에 붙잡아두면 테스트가 NativeModules 를
  // 갈아끼울 틈이 없다.
  return NativeModules.AwsSsoBridgeModule as
    | InAppBrowserModuleShape
    | undefined;
}

export async function openInAppBrowser(url: string): Promise<void> {
  const nativeModule = getNativeInAppBrowser();
  if (!nativeModule) {
    // 네이티브 모듈이 빠진 환경(테스트·개발 번들)에서 로그인이 아예 불가능해지는 것보다는
    // 시스템 브라우저가 낫다. 실제 앱 번들에는 항상 들어 있는 모듈이다.
    await Linking.openURL(url);
    return;
  }
  await nativeModule.openBrowser(url);
}

// 콜백 딥링크로 앱이 앞으로 나와도 시트는 그대로 떠 있다 — 로그인이 끝났으면(또는 취소되면)
// 호출부가 직접 닫아준다. Android Custom Tabs 는 딥링크가 태스크를 앞으로 끌어올리므로
// 네이티브 쪽이 no-op 이다.
export async function closeInAppBrowser(): Promise<void> {
  await getNativeInAppBrowser()?.closeBrowser();
}
