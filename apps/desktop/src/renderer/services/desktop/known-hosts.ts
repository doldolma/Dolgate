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
