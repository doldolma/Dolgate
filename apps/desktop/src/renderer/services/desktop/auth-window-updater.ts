import type { DesktopApi } from '@shared';
import { desktopApi } from '../desktopApi';

type AuthApi = DesktopApi['auth'];
type UpdaterApi = DesktopApi['updater'];
type WindowApi = DesktopApi['window'];

export function bootstrapAuth() {
  return desktopApi.auth.bootstrap();
}

export function getAuthState() {
  return desktopApi.auth.getState();
}

export function onAuthEvent(listener: Parameters<AuthApi['onEvent']>[0]) {
  return desktopApi.auth.onEvent(listener);
}

export function beginBrowserLogin() {
  return desktopApi.auth.beginBrowserLogin();
}

export function reopenBrowserLogin() {
  return desktopApi.auth.reopenBrowserLogin();
}

export function cancelBrowserLogin() {
  return desktopApi.auth.cancelBrowserLogin();
}

export function startLocalOnly() {
  return desktopApi.auth.startLocalOnly();
}

export function retryOnline() {
  return desktopApi.auth.retryOnline();
}

export function logout() {
  return desktopApi.auth.logout();
}

// 회원 탈퇴 — 서버의 모든 사용자 데이터를 즉시 영구 삭제하고 로컬 세션을 정리한다.
export function deleteAccount() {
  return desktopApi.auth.deleteAccount();
}

export function changeAccountPassword(
  currentPassword: string,
  newPassword: string,
) {
  return desktopApi.auth.changeAccountPassword(currentPassword, newPassword);
}

// 패스키(WebAuthn) — 설정에서 추가(시스템 브라우저로 등록 페이지 오픈)/목록/삭제.
export function addPasskey() {
  return desktopApi.auth.addPasskey();
}

export function listPasskeys() {
  return desktopApi.auth.listPasskeys();
}

export function deletePasskey(credentialId: string) {
  return desktopApi.auth.deletePasskey(credentialId);
}

// E2EE 볼트 — 동기화 암호 설정/잠금해제/초기화/변경.
export function setupVault(passphrase: string) {
  return desktopApi.auth.setupVault(passphrase);
}

export function unlockVault(passphrase: string) {
  return desktopApi.auth.unlockVault(passphrase);
}

export function resetVault() {
  return desktopApi.auth.resetVault();
}

export function migrateVault(passphrase: string) {
  return desktopApi.auth.migrateVault(passphrase);
}

export function changeVaultPassphrase(
  currentPassphrase: string,
  nextPassphrase: string,
) {
  return desktopApi.auth.changeVaultPassphrase(
    currentPassphrase,
    nextPassphrase,
  );
}

export function bootstrapSync() {
  return desktopApi.sync.bootstrap();
}

export function pushDirtySync() {
  return desktopApi.sync.pushDirty();
}

export function getUpdaterState() {
  return desktopApi.updater.getState();
}

export function onUpdaterEvent(listener: Parameters<UpdaterApi['onEvent']>[0]) {
  return desktopApi.updater.onEvent(listener);
}

export function checkForUpdates() {
  return desktopApi.updater.check();
}

export function downloadUpdate() {
  return desktopApi.updater.download();
}

export function dismissAvailableUpdate(version: string) {
  return desktopApi.updater.dismissAvailable(version);
}

export function installUpdateAndRestart() {
  return desktopApi.updater.installAndRestart();
}

export function openExternalUrl(url: string) {
  return desktopApi.shell.openExternal(url);
}

export function getWindowState() {
  return desktopApi.window.getState();
}

export function onWindowStateChanged(listener: Parameters<WindowApi['onStateChanged']>[0]) {
  return desktopApi.window.onStateChanged(listener);
}

export function minimizeWindow() {
  return desktopApi.window.minimize();
}

export function maximizeWindow() {
  return desktopApi.window.maximize();
}

export function restoreWindow() {
  return desktopApi.window.restore();
}

export function toggleFullScreenWindow() {
  return desktopApi.window.toggleFullScreen();
}

export function closeWindow() {
  return desktopApi.window.close();
}

export function openHostInNewWindow(hostId: string) {
  return desktopApi.window.openHost(hostId);
}

export function consumeWindowLaunchIntent() {
  const consume = desktopApi.window.consumeLaunchIntent;
  return typeof consume === 'function' ? consume() : Promise.resolve(null);
}
