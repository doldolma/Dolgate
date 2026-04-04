import type { DesktopApi } from '@shared';
import { desktopApi } from '../desktopApi';

type ContainersApi = DesktopApi['containers'];

export function releaseContainerHost(hostId: string) {
  return desktopApi.containers.release(hostId);
}

export function listHostContainers(hostId: string) {
  return desktopApi.containers.list(hostId);
}

export function inspectHostContainer(hostId: string, containerId: string) {
  return desktopApi.containers.inspect(hostId, containerId);
}

export function onContainersConnectionProgress(
  listener: Parameters<ContainersApi['onConnectionProgress']>[0],
) {
  return desktopApi.containers.onConnectionProgress(listener);
}

export function startContainerTunnel(
  input: Parameters<typeof desktopApi.containers.startTunnel>[0],
) {
  return desktopApi.containers.startTunnel(input);
}

export function stopContainerTunnel(runtimeId: string) {
  return desktopApi.containers.stopTunnel(runtimeId);
}
