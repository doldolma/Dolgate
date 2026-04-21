import { NativeModules } from "react-native";
import { AWS_SSO_APP_CALLBACK_URI } from "./mobile";

type AwsSsoBridgeModuleShape = {
  startLoopback(deepLinkBaseUri: string): Promise<{ redirectUri: string }>;
  stopLoopback(): Promise<void>;
  openBrowser(url: string): Promise<void>;
  closeBrowser(): Promise<void>;
};

const nativeAwsSsoBridge = NativeModules.AwsSsoBridgeModule as
  | AwsSsoBridgeModuleShape
  | undefined;

function getNativeBridge(): AwsSsoBridgeModuleShape {
  if (!nativeAwsSsoBridge) {
    throw new Error("AWS SSO 브라우저 모듈을 찾지 못했습니다.");
  }
  return nativeAwsSsoBridge;
}

export async function startAwsSsoLoopback(): Promise<{ redirectUri: string }> {
  return getNativeBridge().startLoopback(AWS_SSO_APP_CALLBACK_URI);
}

export async function stopAwsSsoLoopback(): Promise<void> {
  await getNativeBridge().stopLoopback();
}

export async function openAwsSsoBrowser(url: string): Promise<void> {
  await getNativeBridge().openBrowser(url);
}

export async function closeAwsSsoBrowser(): Promise<void> {
  await getNativeBridge().closeBrowser();
}
