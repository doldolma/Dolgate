import { NativeModules } from "react-native";
import { AWS_SSO_APP_CALLBACK_URI } from "./mobile";
import { closeInAppBrowser, openInAppBrowser } from "./in-app-browser";
import { t } from "../i18n";

type AwsSsoBridgeModuleShape = {
  startLoopback(deepLinkBaseUri: string): Promise<{ redirectUri: string }>;
  stopLoopback(): Promise<void>;
};

const nativeAwsSsoBridge = NativeModules.AwsSsoBridgeModule as
  | AwsSsoBridgeModuleShape
  | undefined;

function getNativeBridge(): AwsSsoBridgeModuleShape {
  if (!nativeAwsSsoBridge) {
    throw new Error(t("awsSso.browserModuleMissing"));
  }
  return nativeAwsSsoBridge;
}

export async function startAwsSsoLoopback(): Promise<{ redirectUri: string }> {
  return getNativeBridge().startLoopback(AWS_SSO_APP_CALLBACK_URI);
}

export async function stopAwsSsoLoopback(): Promise<void> {
  await getNativeBridge().stopLoopback();
}

// 브라우저 시트 자체는 계정 로그인과 공유하므로 lib/in-app-browser.ts 가 갖고 있다. AWS SSO
// 호출부가 그대로 읽히도록 이름만 여기 남긴다.
export async function openAwsSsoBrowser(url: string): Promise<void> {
  await openInAppBrowser(url);
}

export async function closeAwsSsoBrowser(): Promise<void> {
  await closeInAppBrowser();
}
