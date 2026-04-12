import type { DesktopSerialControlInput } from '@shared';
import { desktopApi } from '../desktopApi';

export function sendSerialControl(input: DesktopSerialControlInput) {
  return desktopApi.serial.control(input);
}
