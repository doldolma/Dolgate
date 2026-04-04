import type { DesktopApi } from '@shared';
import { desktopApi } from '../desktopApi';

type PortForwardsApi = DesktopApi['portForwards'];

export function onPortForwardRuntimeEvent(
  listener: Parameters<PortForwardsApi['onEvent']>[0],
) {
  return desktopApi.portForwards.onEvent(listener);
}
