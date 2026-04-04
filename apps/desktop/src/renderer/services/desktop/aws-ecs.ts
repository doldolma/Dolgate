import { desktopApi } from '../desktopApi';

export function listEcsTaskTunnelServices(hostId: string) {
  return desktopApi.aws.listEcsTaskTunnelServices(hostId);
}

export function loadEcsTaskTunnelService(hostId: string, serviceName: string) {
  return desktopApi.aws.loadEcsTaskTunnelService(hostId, serviceName);
}

export function loadEcsServiceActionContext(hostId: string, serviceName: string) {
  return desktopApi.aws.loadEcsServiceActionContext(hostId, serviceName);
}

export function loadEcsServiceLogs(
  input: Parameters<typeof desktopApi.aws.loadEcsServiceLogs>[0],
) {
  return desktopApi.aws.loadEcsServiceLogs(input);
}

export function startEcsServiceTunnel(
  input: Parameters<typeof desktopApi.aws.startEcsServiceTunnel>[0],
) {
  return desktopApi.aws.startEcsServiceTunnel(input);
}

export function stopEcsServiceTunnel(runtimeId: string) {
  return desktopApi.aws.stopEcsServiceTunnel(runtimeId);
}
