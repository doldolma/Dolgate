import type {
  LogsAbsoluteRangeValue,
  LogsRangeMode,
  LogsRelativePresetKey,
  LogsRelativeRangeValue,
  LogsRelativeUnit,
} from "../store/createAppStore";
import { t } from "../i18n";

// 요일·프리셋 라벨은 렌더 시점에 번역한다(모듈 상수는 i18n 초기화보다 먼저 평가된다).
export const LOGS_RANGE_WEEKDAY_KEYS: string[] = [
  "logRange.weekday.sun",
  "logRange.weekday.mon",
  "logRange.weekday.tue",
  "logRange.weekday.wed",
  "logRange.weekday.thu",
  "logRange.weekday.fri",
  "logRange.weekday.sat",
];

export const LOGS_RELATIVE_RANGE_PRESET_OPTIONS: Array<{
  key: LogsRelativePresetKey;
  labelKey: string;
  amount: number;
  unit: LogsRelativeUnit;
}> = [
  { key: "30m", labelKey: "logRange.preset.30m", amount: 30, unit: "minute" },
  { key: "1h", labelKey: "logRange.preset.1h", amount: 1, unit: "hour" },
  { key: "6h", labelKey: "logRange.preset.6h", amount: 6, unit: "hour" },
  { key: "1d", labelKey: "logRange.preset.1d", amount: 1, unit: "day" },
  { key: "3d", labelKey: "logRange.preset.3d", amount: 3, unit: "day" },
  { key: "1w", labelKey: "logRange.preset.1w", amount: 1, unit: "week" },
];

export const LOGS_RELATIVE_RANGE_UNIT_OPTIONS: Array<{
  value: LogsRelativeUnit;
  labelKey: string;
}> = [
  { value: "second", labelKey: "logRange.unit.second" },
  { value: "minute", labelKey: "logRange.unit.minute" },
  { value: "hour", labelKey: "logRange.unit.hour" },
  { value: "day", labelKey: "logRange.unit.day" },
  { value: "week", labelKey: "logRange.unit.week" },
  { value: "month", labelKey: "logRange.unit.month" },
  { value: "year", labelKey: "logRange.unit.year" },
];

function padRangeValue(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatLocalDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${padRangeValue(date.getMonth() + 1)}-${padRangeValue(date.getDate())}`;
}

export function formatLocalTimeInputValue(date: Date): string {
  return `${padRangeValue(date.getHours())}:${padRangeValue(date.getMinutes())}:${padRangeValue(date.getSeconds())}`;
}

export function parseLocalDateTime(
  dateValue: string,
  timeValue: string,
): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue.trim());
  if (!dateMatch) {
    return null;
  }
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeValue.trim());
  if (!timeMatch) {
    return null;
  }

  const parsed = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3] ?? "0"),
    0,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function createDefaultLogsAbsoluteRange(): LogsAbsoluteRangeValue {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 60 * 1000);
  return {
    startDate: formatLocalDateInputValue(start),
    startTime: formatLocalTimeInputValue(start),
    endDate: formatLocalDateInputValue(end),
    endTime: formatLocalTimeInputValue(end),
  };
}

export function createDefaultLogsRelativeRange(): LogsRelativeRangeValue {
  return {
    presetKey: "30m",
    amount: "30",
    unit: "minute",
  };
}

export function subtractLogsRelativeRange(
  end: Date,
  amount: number,
  unit: LogsRelativeUnit,
): Date {
  const start = new Date(end);
  if (unit === "second") {
    start.setSeconds(start.getSeconds() - amount);
  } else if (unit === "minute") {
    start.setMinutes(start.getMinutes() - amount);
  } else if (unit === "hour") {
    start.setHours(start.getHours() - amount);
  } else if (unit === "day") {
    start.setDate(start.getDate() - amount);
  } else if (unit === "week") {
    start.setDate(start.getDate() - amount * 7);
  } else if (unit === "month") {
    start.setMonth(start.getMonth() - amount);
  } else if (unit === "year") {
    start.setFullYear(start.getFullYear() - amount);
  }
  return start;
}

export function normalizeLogsRelativeRange(
  value: LogsRelativeRangeValue | null,
  now = new Date(),
): { startTime: string; endTime: string } | null {
  if (!value) {
    return null;
  }
  const preset = LOGS_RELATIVE_RANGE_PRESET_OPTIONS.find(
    (option) => option.key === value.presetKey,
  );
  const resolvedAmount =
    value.presetKey === "custom"
      ? Number(value.amount)
      : preset?.amount ?? Number.NaN;
  const resolvedUnit =
    value.presetKey === "custom" ? value.unit : preset?.unit ?? value.unit;
  if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
    return null;
  }
  const end = new Date(now);
  const start = subtractLogsRelativeRange(end, resolvedAmount, resolvedUnit);
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

export function normalizeLogsAbsoluteRange(
  value: LogsAbsoluteRangeValue | null,
): { startTime: string; endTime: string } | null {
  if (!value) {
    return null;
  }
  const start = parseLocalDateTime(value.startDate, value.startTime);
  const end = parseLocalDateTime(value.endDate, value.endTime);
  if (!start || !end || end.getTime() < start.getTime()) {
    return null;
  }
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

export function formatLogsRangeLabel(
  mode: LogsRangeMode,
  absoluteValue: LogsAbsoluteRangeValue | null,
  relativeValue: LogsRelativeRangeValue | null,
): string {
  if (mode === "absolute" && absoluteValue) {
    return `${absoluteValue.startDate.replace(/-/g, "/")} ${absoluteValue.startTime.slice(0, 5)} - ${absoluteValue.endDate.replace(/-/g, "/")} ${absoluteValue.endTime.slice(0, 5)}`;
  }
  const preset = LOGS_RELATIVE_RANGE_PRESET_OPTIONS.find(
    (option) => option.key === relativeValue?.presetKey,
  );
  if (relativeValue?.presetKey === "custom") {
    const unitKey = LOGS_RELATIVE_RANGE_UNIT_OPTIONS.find(
      (option) => option.value === relativeValue.unit,
    )?.labelKey;
    return t("logRange.recentAmount", {
      amount: relativeValue.amount || "0",
      unit: unitKey ? t(unitKey) : "",
    });
  }
  return preset
    ? t("logRange.recentPreset", { preset: t(`logRange.presetShort.${preset.key}`) })
    : t("logRange.recentDefault");
}

export function startOfRangeMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addRangeMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

export function buildRangeCalendarDays(month: Date): Date[] {
  const firstDay = startOfRangeMonth(month);
  const gridStart = new Date(firstDay);
  gridStart.setDate(firstDay.getDate() - firstDay.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const next = new Date(gridStart);
    next.setDate(gridStart.getDate() + index);
    return next;
  });
}

export function formatRangeMonthLabel(date: Date): string {
  return t("logRange.monthLabel", { year: date.getFullYear(), month: date.getMonth() + 1 });
}

export function formatRangeDayValue(date: Date): string {
  return formatLocalDateInputValue(date);
}
