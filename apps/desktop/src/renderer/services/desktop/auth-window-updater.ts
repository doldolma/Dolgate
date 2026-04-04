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

export function retryOnline() {
  return desktopApi.auth.retryOnline();
}

export function logout() {
  return desktopApi.auth.logout();
}

export function bootstrapSync() {
  return desktopApi.sync.bootstrap();
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

export function closeWindow() {
  return desktopApi.window.close();
}
