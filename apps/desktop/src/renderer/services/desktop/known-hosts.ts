import { desktopApi } from '../desktopApi';

export function probeKnownHost(
  input: Parameters<typeof desktopApi.knownHosts.probeHost>[0],
) {
  return desktopApi.knownHosts.probeHost(input);
}

export function trustKnownHost(
  input: Parameters<typeof desktopApi.knownHosts.trust>[0],
) {
  return desktopApi.knownHosts.trust(input);
}

export function replaceKnownHost(
  input: Parameters<typeof desktopApi.knownHosts.replace>[0],
) {
  return desktopApi.knownHosts.replace(input);
}

/** 그 팀 볼트의 호스트 키 기록. 개인 목록은 스토어가 들고 있다. */
export function listTeamKnownHosts(teamId: string) {
  return desktopApi.knownHosts.list(teamId);
}
