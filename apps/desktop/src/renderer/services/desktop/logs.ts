import type { LogsCsvExportInput } from '@shared';
import { desktopApi } from '../desktopApi';

/** 기록 화면이 만든 CSV 를 저장 창으로 저장한다(메인). 팀 기록이면 내보냈다는 줄이 그 팀 기록에도 남는다. */
export function exportLogsCsv(input: LogsCsvExportInput) {
  return desktopApi.logs.exportCsv(input);
}
