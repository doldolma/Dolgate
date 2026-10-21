import { desktopApi } from '../desktopApi';
import type { LoadedManagedSecretPayload, SecretMetadataRecord, SerialPortSummary } from '@shared';

/** 그 팀 볼트에 저장된 자격 증명(이름·종류만). 개인 목록은 스토어가 들고 있다. */
export function listTeamSavedCredentials(teamId: string): Promise<SecretMetadataRecord[]> {
  return desktopApi.keychain.list(teamId);
}

export function getDesktopSettings() {
  return desktopApi.settings.get();
}

export function loadSavedCredential(
  secretRef: string,
): Promise<LoadedManagedSecretPayload | null> {
  return desktopApi.keychain.load(secretRef);
}

export function copySavedCredentialPassword(secretRef: string): Promise<void> {
  return desktopApi.keychain.copyPassword(secretRef);
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

export function probeSshAgent() {
  return desktopApi.ssh.probeAgent();
}
