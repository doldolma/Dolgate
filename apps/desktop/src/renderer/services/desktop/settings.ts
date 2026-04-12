import { desktopApi } from '../desktopApi';

export function getDesktopSettings() {
  return desktopApi.settings.get();
}

export function pickPrivateKey() {
  return desktopApi.shell.pickPrivateKey();
}

export function pickSshCertificate() {
  return desktopApi.shell.pickSshCertificate();
}
