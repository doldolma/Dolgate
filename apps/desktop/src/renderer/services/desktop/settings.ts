import { desktopApi } from '../desktopApi';
import type { LoadedManagedSecretPayload, SerialPortSummary } from '@shared';

export function getDesktopSettings() {
  return desktopApi.settings.get();
}

export function loadSavedCredential(
  secretRef: string,
): Promise<LoadedManagedSecretPayload | null> {
  return desktopApi.keychain.load(secretRef);
}

export function pickPrivateKey() {
  return desktopApi.shell.pickPrivateKey();
}

export function pickSshCertificate() {
  return desktopApi.shell.pickSshCertificate();
}

export function listSerialPorts(): Promise<SerialPortSummary[]> {
  return desktopApi.serial.listPorts();
}
